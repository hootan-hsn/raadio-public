#!/usr/bin/env bash
# Deploys the latest main branch on the server.
#
# GitHub Actions runs this over SSH after every successful push to main.
# The CI key in ~/.ssh/authorized_keys can only run this script, nothing else.
# You can also run it by hand on the server:
#   bash ~/raadio/deploy/deploy.sh
#
# Everything is inside main() so Bash reads the whole script before running it.
# That matters because "git pull" below may replace this very file.
set -euo pipefail

main() {
  local repo web_root
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  web_root="${WEB_ROOT:-/var/www/radio}"
  cd "$repo"

  # One deploy at a time
  exec 9>/tmp/raadio-deploy.lock
  if ! flock -n 9; then
    echo "Another deploy is already running" >&2
    exit 1
  fi

  echo "==> Pulling latest code"
  # GitHub is the only source of truth: the server's copy is moved to exactly what's there.
  # (A plain "git pull" stopped every deploy once the server's copy had a commit of its own:
  # "Diverging branches can't be fast-forwarded".) Anything of the server's own is kept
  # aside first, never lost. .env, data/ and other ignored files aren't touched.
  local before upstream keep
  before="$(git rev-parse --short HEAD)"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo origin/main)"
  git fetch --quiet origin
  if ! git merge-base --is-ancestor HEAD "$upstream"; then
    keep="server-copy-$(date +%Y%m%d-%H%M%S)"
    git branch "$keep" HEAD
    echo "    The server's copy had commits GitHub doesn't; kept them as branch ${keep}"
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git stash push --quiet -m "edits on the server, before deploy $(date +%F_%T)"
    echo "    Edits made on the server were kept aside (see: git stash list)"
  fi
  git reset --hard --quiet "$upstream"
  echo "    ${before} -> $(git rev-parse --short HEAD)"

  echo "==> Building and starting containers"
  # Only containers whose image changed are restarted. A web-only change
  # doesn't interrupt the stream.
  docker compose up -d --build --remove-orphans

  echo "==> Updating the website in ${web_root}"
  rsync -a --delete "${repo}/web/" "${web_root}/"
  # Minify the served script and styles (comments and spaces out, names shortened): ~70 KB
  # less to download, gzipped, on every first visit and after every deploy, which counts on
  # slow lines (listeners in Iran pay for every KB from abroad). Done with esbuild in a
  # throwaway container, as this user; if anything goes wrong the readable files are
  # served as they are. The repo keeps the readable ones.
  if docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
      -v "${web_root}:/w" -w /w node:22-alpine sh -c \
      'npx -y esbuild@0.24.0 script.js --minify --target=es2017 --allow-overwrite --outfile=script.js --log-level=error &&
       npx -y esbuild@0.24.0 styles.css --minify --allow-overwrite --outfile=styles.css --log-level=error' >/dev/null 2>&1; then
    echo "    Minified script.js and styles.css"
  else
    echo "    Couldn't minify (serving the readable files)"
    rsync -a "${repo}/web/script.js" "${repo}/web/styles.css" "${web_root}/"
  fi
  # Stamp the CSS/JS links with this commit so browsers fetch the new files
  sed -i "s/__BUILD__/$(git rev-parse --short HEAD)/g" "${web_root}/index.html"

  # Nginx's files are installed by hand (they need sudo): just say when the repo has new ones
  local f live nginx_new=0
  for f in raadio-domain.conf:sites-available raadio-ip.conf:sites-available raadio-web.conf:snippets \
           raadio-headers.conf:snippets raadio-site.conf:snippets raadio-logs.conf:conf.d raadio-security.conf:conf.d; do
    live="/etc/nginx/${f#*:}/${f%%:*}"
    cmp -s "${repo}/deploy/nginx/${f%%:*}" "$live" 2>/dev/null || nginx_new=1
  done
  if [ "$nginx_new" -eq 1 ]; then
    echo "==> Nginx: the repo has changes the server doesn't. On the server run: raadio nginx"
  fi

  echo "==> Health check"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/status-json.xsl >/dev/null \
      && curl -fsS --max-time 3 http://127.0.0.1:8080/now-playing >/dev/null; then
      echo "    Icecast and controller are answering"
      docker image prune -f >/dev/null
      echo "==> Deployed $(git log -1 --format='%h %s')"
      return 0
    fi
    sleep 2
  done

  echo "Health check failed after 60 s" >&2
  docker compose ps >&2
  docker compose logs --tail 40 controller >&2
  exit 1
}

main "$@"
exit

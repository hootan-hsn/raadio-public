#!/usr/bin/env bash
# "raadio": the one command for looking after the server.
#
# Install once, on the server:
#   sudo ln -sf ~/raadio/deploy/raadio.sh /usr/local/bin/raadio
#
#   raadio                    how everything is doing (containers, website, Nginx, certificate)
#   raadio where              where every file lives
#   raadio logs [what]        follow a log: controller (default), icecast, nginx, errors
#   raadio restart [what]     restart controller (default), icecast or nginx
#   raadio deploy             what a push to main does: pull, rebuild, update the website
#   raadio nginx [--apply]    compare the server's Nginx files with the repo / install them
#   raadio net [--apply]      TCP settings: show them / switch BBR on (steadier streams)
#   raadio backup             copy the database and Telegram session to ~/raadio-backups
#   raadio users ...          studio accounts: list | add <name> | passwd <name> | remove <name>
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
WEB_ROOT="${WEB_ROOT:-/var/www/radio}"
DOMAIN="raadio.run.place"

dc() { docker compose --project-directory "$REPO" "$@"; }
say() { printf '%-14s %s\n' "$1" "$2"; }

status() {
  echo "Raadio on $(hostname), $(date '+%a %d %b %H:%M %Z')"
  echo
  say "Code" "$REPO  ($(git -C "$REPO" log -1 --format='%h %s, %cr'))"
  if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    say "" "!! files were changed on the server; the next deploy may refuse to pull:"
    git -C "$REPO" status --short | sed 's/^/                 /'
  fi
  echo
  dc ps --format '{{.Service}}|{{.Status}}' | while IFS='|' read -r svc st; do say "$svc" "$st"; done
  local np
  np="$(curl -fsS --max-time 3 http://127.0.0.1:8080/now-playing 2>/dev/null \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("title") or "?") + " - " + (d.get("artist") or ""))' 2>/dev/null)" \
     || np="(controller not answering)"
  say "On air" "$np"
  echo
  say "Nginx" "$(systemctl is-active nginx)$(nginx_same && echo ', same as the repo' || echo ', differs from the repo: run "raadio nginx"')"
  local end
  end="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null \
         | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)" || true
  say "Certificate" "${end:+good until $end (renews by itself)}"
  local built
  built="$(sed -n 's/.*?v=\([0-9a-f]\{7,\}\).*/\1/p' "$WEB_ROOT/index.html" 2>/dev/null | head -1)" || true
  say "Website" "$WEB_ROOT${built:+  (commit $built)}"
  say "Disk" "$(df -h / | awk 'NR==2 {print $4 " free of " $2}'), data folder $(du -sh "$REPO/data" 2>/dev/null | cut -f1)"
}

nginx_same() {
  cmp -s "$REPO/deploy/nginx/raadio-domain.conf" /etc/nginx/sites-available/raadio-domain.conf &&
  cmp -s "$REPO/deploy/nginx/raadio-ip.conf" /etc/nginx/sites-available/raadio-ip.conf &&
  cmp -s "$REPO/deploy/nginx/raadio-web.conf" /etc/nginx/snippets/raadio-web.conf &&
  cmp -s "$REPO/deploy/nginx/raadio-headers.conf" /etc/nginx/snippets/raadio-headers.conf &&
  cmp -s "$REPO/deploy/nginx/raadio-site.conf" /etc/nginx/snippets/raadio-site.conf &&
  cmp -s "$REPO/deploy/nginx/raadio-logs.conf" /etc/nginx/conf.d/raadio-logs.conf &&
  cmp -s "$REPO/deploy/nginx/raadio-security.conf" /etc/nginx/conf.d/raadio-security.conf
}

where() {
  cat <<EOF
Code (from GitHub; don't edit here)   $REPO
Settings and secrets                  $REPO/.env
Data (keep it safe)                   $REPO/data/
  studio.db                           users, shows, schedule, flamingo notes, listener stats
  radio_analytics.db                  what was played and voted
  *.session                           the Telegram login
  studio/media/                       uploaded and recorded audio
  downloads/ cache/                   songs being played (cleaned up by themselves)
Website (copied on every deploy)      $WEB_ROOT
Nginx                                 /etc/nginx/sites-available/raadio-domain.conf   https://$DOMAIN
                                      /etc/nginx/sites-available/raadio-ip.conf       plain address + relays
                                      /etc/nginx/snippets/raadio-web.conf             player files
                                      /etc/nginx/snippets/raadio-headers.conf         security headers
                                      /etc/nginx/snippets/raadio-site.conf            the site (raadio.xyz and $DOMAIN)
                                      /etc/nginx/conf.d/raadio-*.conf                 logs, limits, server_tokens
                                      (their source: $REPO/deploy/nginx/)
Relay addresses                       /etc/nginx/raadio-relays*.conf
Certificates                          /etc/letsencrypt/live/$DOMAIN/
Backups                               ~/raadio-backups/ (raadio backup), /var/backups/raadio-nginx/
Containers                            icecast on 127.0.0.1:8000, controller on 127.0.0.1:8080
Logs                                  raadio logs controller | icecast | nginx | errors
EOF
}

logs() {
  case "${1:-controller}" in
    controller|icecast) dc logs -f --tail 100 "${1:-controller}" ;;
    nginx) sudo tail -n 50 -f /var/log/nginx/access.log /var/log/nginx/error.log ;;
    errors) dc logs --since 24h 2>&1 | grep -iE 'error|exception|traceback|fail' | tail -n 60 ;;
    *) echo "raadio logs controller | icecast | nginx | errors" >&2; exit 1 ;;
  esac
}

restart() {
  case "${1:-controller}" in
    controller|icecast) dc restart "${1:-controller}" ;;
    nginx) sudo nginx -t && sudo systemctl reload nginx ;;
    *) echo "raadio restart controller | icecast | nginx" >&2; exit 1 ;;
  esac
}

backup() {
  local to
  to="$HOME/raadio-backups/$(date +%Y-%m-%d_%H%M%S)"
  mkdir -p "$to"
  local db
  for db in "$REPO"/data/*.db; do
    [ -e "$db" ] || continue
    # a consistent copy even while the controller is writing to it
    sqlite3 "$db" ".backup '$to/$(basename "$db")'" 2>/dev/null \
      || python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d)' "$db" "$to/$(basename "$db")"
  done
  cp -p "$REPO"/data/*.session "$to/" 2>/dev/null || true
  cp -p "$REPO/.env" "$to/env" 2>/dev/null || true
  chmod -R go-rwx "$to"
  echo "Saved in $to:"
  ls -lh "$to"
  echo "(Keep it private: it holds the Telegram login and passwords. Old backups: ls ~/raadio-backups)"
}

case "${1:-}" in
  ""|status) status ;;
  where) where ;;
  logs) logs "${2:-}" ;;
  restart) restart "${2:-}" ;;
  deploy) bash "$REPO/deploy/deploy.sh" ;;
  nginx) shift; sudo bash "$REPO/deploy/nginx/install.sh" "$@" ;;
  net) shift; sudo bash "$REPO/deploy/net.sh" "$@" ;;
  backup) backup ;;
  users) shift; dc exec controller python /app/controller/manage_users.py "$@" ;;
  help|-h|--help) sed -n '2,15p' "$(readlink -f "${BASH_SOURCE[0]}")" | sed 's/^# \{0,1\}//' ;;
  *) echo "Unknown: $1. Try: raadio help" >&2; exit 1 ;;
esac

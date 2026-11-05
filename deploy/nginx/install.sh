#!/usr/bin/env bash
# Puts this folder's Nginx files on the server under the same names, and tidies away the
# old ones (default, default.bak, raadio, raadio-ip without ".conf").
#
#   sudo bash ~/raadio/deploy/nginx/install.sh           show what would change (changes nothing)
#   sudo bash ~/raadio/deploy/nginx/install.sh --apply   install, test, reload
#   (or the short forms: raadio nginx / raadio nginx --apply)
#
# Afterwards, on the server:
#   /etc/nginx/sites-available/raadio-domain.conf   https://raadio.run.place
#   /etc/nginx/sites-available/raadio-ip.conf       http://<server address> and the Iran relays
#   /etc/nginx/snippets/raadio-web.conf             how the player's files are sent (both sites)
#   /etc/nginx/snippets/raadio-headers.conf         security headers (both sites)
#   /etc/nginx/snippets/raadio-site.conf            the site itself, shared by raadio.xyz and raadio.run.place
#   /etc/nginx/conf.d/raadio-logs.conf              access logs without full listener addresses
#   /etc/nginx/conf.d/raadio-security.conf          no version in headers, HSTS over HTTPS only, rate limits
#   /etc/nginx/sites-enabled/raadio-*.conf          links that switch the two sites on
#
# Never touched: raadio-host-* sites (deploy/add-studio-host.sh), the relay address lists
# (/etc/nginx/raadio-relays*.conf) and the certificates (/etc/letsencrypt).
# Every --apply first saves all of /etc/nginx to /var/backups/raadio-nginx/<time>/. If
# Nginx doesn't accept the new files, that copy is put back at once and nothing reloads.
set -euo pipefail

# The domain names Nginx serves with its current files, one per line
served_names() {
  { nginx -T 2>/dev/null || true; } | sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;]*\);.*/\1/p' |
    tr -s ' \t' '\n' | { grep -v -e '^_$' -e '^$' || true; } | sort -u   # (none at all is fine)
}

main() {
  local here apply=0 N=/etc/nginx
  here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
  case "${1:-}" in
    --apply) apply=1 ;;
    "") ;;
    *) echo "Usage: sudo bash $0 [--apply]" >&2; exit 1 ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then
    echo "Needs sudo: sudo bash $0 ${1:-}" >&2
    exit 1
  fi

  # repo file | where it goes | which file serves it today (before the first --apply)
  local rows=(
    "raadio-domain.conf|$N/sites-available/raadio-domain.conf|$N/sites-enabled/default"
    "raadio-ip.conf|$N/sites-available/raadio-ip.conf|$N/sites-enabled/raadio-ip"
    "raadio-web.conf|$N/snippets/raadio-web.conf|"
    "raadio-headers.conf|$N/snippets/raadio-headers.conf|"
    "raadio-site.conf|$N/snippets/raadio-site.conf|"
    "raadio-logs.conf|$N/conf.d/raadio-logs.conf|"
    "raadio-security.conf|$N/conf.d/raadio-security.conf|"
  )
  # left over from before: switched off and moved into the backup folder by --apply
  local old_enabled=("$N/sites-enabled/default" "$N/sites-enabled/raadio" "$N/sites-enabled/raadio-ip")
  local old_files=("$N/sites-available/default" "$N/sites-available/default.bak"
                   "$N/sites-available/raadio" "$N/sites-available/raadio-ip")

  echo "==> Nginx files: repo ($here) compared with the server"
  echo "    (comments and blank lines ignored)"
  local row src dst was live changed=0
  for row in "${rows[@]}"; do
    IFS='|' read -r src dst was <<<"$row"
    live="$dst"
    if [ ! -e "$live" ] && [ -n "$was" ] && [ -e "$was" ]; then live="$(readlink -f "$was")"; fi
    if [ ! -e "$live" ]; then
      echo "--- $src: not on the server yet (will be $dst)"
      changed=1
    elif diff -q <(strip "$live") <(strip "$here/$src") >/dev/null; then
      echo "--- $src: same as $live"
      [ "$live" = "$dst" ] || changed=1
    else
      echo "--- $src: differs from $live  (- server, + repo)"
      diff -u --label server --label repo <(strip "$live") <(strip "$here/$src") | tail -n +3 || true
      changed=1
    fi
  done

  local f leftovers=()
  for f in "${old_enabled[@]}" "${old_files[@]}"; do
    if [ -e "$f" ] || [ -L "$f" ]; then leftovers+=("$f"); fi
  done
  if [ "${#leftovers[@]}" -gt 0 ]; then
    echo "==> Old files that --apply switches off and moves into the backup folder:"
    printf '    %s\n' "${leftovers[@]}"
    changed=1
  fi
  local others
  others="$(find "$N/sites-enabled" -mindepth 1 -maxdepth 1 \
              ! -name 'raadio-domain.conf' ! -name 'raadio-ip.conf' \
              ! -name default ! -name raadio ! -name raadio-ip -printf '    %p\n')"
  if [ -n "$others" ]; then
    echo "==> Also switched on, left as they are:"
    echo "$others"
  fi

  if [ "$apply" -eq 0 ]; then
    if [ "$changed" -eq 0 ]; then
      echo "==> Nothing to do: the server already has the repo's Nginx files."
    else
      echo "==> Nothing changed yet. To install: sudo bash $0 --apply"
    fi
    return 0
  fi
  if [ "$changed" -eq 0 ]; then
    echo "==> Nothing to do: the server already has the repo's Nginx files."
    return 0
  fi

  # every domain Nginx serves now: the new files must still serve all of them (an --apply once
  # dropped raadio.xyz, which was only in a hand-made block)
  local served_before
  served_before="$(served_names)"

  local backup
  backup="/var/backups/raadio-nginx/$(date +%Y-%m-%d_%H%M%S)-$$"
  mkdir -p "$backup/old"
  tar -czf "$backup/etc-nginx.tar.gz" -C / etc/nginx
  echo "==> Saved the current /etc/nginx in $backup/etc-nginx.tar.gz"

  for row in "${rows[@]}"; do
    IFS='|' read -r src dst was <<<"$row"
    install -m 644 "$here/$src" "$dst"
  done
  for f in "${old_enabled[@]}"; do rm -f "$f"; done
  for f in "${old_files[@]}"; do
    if [ -e "$f" ]; then mv "$f" "$backup/old/"; fi
  done
  ln -sfn "$N/sites-available/raadio-domain.conf" "$N/sites-enabled/raadio-domain.conf"
  ln -sfn "$N/sites-available/raadio-ip.conf" "$N/sites-enabled/raadio-ip.conf"

  local lost=""
  if nginx -t; then
    # (no names before, e.g. a fresh server: printf still writes one empty line, dropped here)
    lost="$(comm -23 <(printf '%s\n' "$served_before" | sed '/^$/d') <(served_names) | tr '\n' ' ')"
  fi
  if [ -n "$lost" ] || ! nginx -t >/dev/null 2>&1; then
    if [ -n "$lost" ]; then
      echo "!! The new files no longer serve: $lost. Putting the old ones back; nothing was reloaded." >&2
    else
      echo "!! Nginx didn't accept the new files. Putting the old ones back; nothing was reloaded." >&2
    fi
    mv "$N" "$backup/nginx-rejected"
    tar -xzf "$backup/etc-nginx.tar.gz" -C /
    nginx -t >/dev/null 2>&1 && echo "   Old config restored. The rejected one is in $backup/nginx-rejected" >&2
    exit 1
  fi
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
    echo "==> Installed and reloaded. Old files are in $backup/old"
  else
    # (GitHub's check machine, or a server where Nginx is stopped: nothing to reload)
    echo "==> Installed. Nginx isn't running, so nothing was reloaded (start it: sudo systemctl start nginx)."
    echo "    Old files are in $backup/old"
    return 0
  fi

  # does the site still answer? (CI skips this: it has no containers to answer)
  if [ -n "${RAADIO_SKIP_LIVE_CHECK:-}" ]; then return 0; fi
  sleep 1
  local ok=1
  curl -fsS -o /dev/null --max-time 5 --resolve raadio.run.place:443:127.0.0.1 \
    https://raadio.run.place/now-playing || ok=0
  curl -fsS -o /dev/null --max-time 5 http://127.0.0.1/now-playing || ok=0
  if [ "$ok" -eq 1 ]; then
    echo "==> https://raadio.run.place and the plain address both answer."
  else
    echo "!! A test request failed. To go back to how it was:" >&2
    echo "   sudo mv /etc/nginx $backup/nginx-new && sudo tar -xzf $backup/etc-nginx.tar.gz -C / && sudo systemctl reload nginx" >&2
    exit 1
  fi
}

# the file without comments, blank lines and indentation, so only real settings are compared
strip() { sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e '/^$/d' "$1"; }

main "$@"

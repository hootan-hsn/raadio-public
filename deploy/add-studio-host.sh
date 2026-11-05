#!/usr/bin/env bash
# Main server: serve the whole site (player + studio) under a relay's studio name, with
# its own certificate, so the relay can pass the connection through sealed: encryption
# runs from the browser to this server, and the relay can't read anything.
#
#   cd ~/raadio && sudo bash deploy/add-studio-host.sh studio.example.ir
#
# First the relay must be set up with STUDIO_HOST=studio.example.ir (relay/README.md),
# because the certificate check reaches this server through the relay.
# Safe to run again. Undo: sudo rm /etc/nginx/sites-enabled/raadio-host-<name>; reload nginx.
set -euo pipefail

HOST="${1:-}"
cd "$(dirname "$0")/.."
REF=deploy/nginx/raadio-domain.conf
if [ -z "$HOST" ] || [ "$(id -u)" -ne 0 ]; then
  echo "Usage: sudo bash deploy/add-studio-host.sh <studio name>" >&2
  exit 1
fi
if ! [[ "$HOST" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "\"$HOST\" doesn't look like a domain name." >&2
  exit 1
fi
SITE="/etc/nginx/sites-enabled/raadio-host-$HOST"
CERT="/etc/letsencrypt/live/$HOST"

# 1. Port 80: answers the certificate check (which arrives through the relay)
cat > "$SITE" <<EOF
# Written by deploy/add-studio-host.sh
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
nginx -t && systemctl reload nginx

# 2. Certificate (renews by itself, like the main one)
if [ ! -f "$CERT/fullchain.pem" ]; then
  echo "==> Getting a certificate for $HOST"
  ACCOUNT=()
  if [ -z "$(ls -A /etc/letsencrypt/accounts 2>/dev/null)" ]; then
    ACCOUNT=(--agree-tos --register-unsafely-without-email)
  fi
  certbot certonly --webroot -w /var/www/html -d "$HOST" --non-interactive "${ACCOUNT[@]}" \
    --deploy-hook "systemctl reload nginx" || {
      echo "!! No certificate. Check that $HOST points to the relay, and that the relay was" >&2
      echo "   set up with STUDIO_HOST=$HOST. Then run this again." >&2
      exit 1
    }
fi

# 3. Port 443: the same site as raadio.run.place (copied from the reference config),
#    under the studio name and its certificate
{
  echo
  sed -n '/^# ---------- Main HTTPS site ----------/,$p' "$REF" \
    | sed -e "s#server_name raadio.run.place;#server_name $HOST;#" \
          -e "s#/etc/letsencrypt/live/raadio.run.place/#$CERT/#g" \
          -e "s#^\(    server_name .*\)\$#\1\n    absolute_redirect off;   \# the page is on port 8443 at the relay#"
} >> "$SITE"
nginx -t && systemctl reload nginx
echo "==> Done. Studio (and player) at https://$HOST:8443 through the relay."

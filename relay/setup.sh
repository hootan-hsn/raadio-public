#!/usr/bin/env bash
# Raadio relay: re-serves the station from a server inside Iran, under its own (sub)domain.
#
# Run on the relay server (Ubuntu or Debian), as root:
#   sudo bash setup.sh radio.example.ir [email-for-certificate-notices]
# With the studio too (a second name, also pointing to this server):
#   sudo STUDIO_HOST=studio.example.ir bash setup.sh radio.example.ir [email]
#
# Safe to run again (e.g. to change settings): it rewrites only its own files.
# What it sets up:
#   - Icecast on 127.0.0.1:8100 that pulls each stream from the main server only while
#     someone here is listening (one pull per stream, however many listeners)
#   - Nginx for the domain: the web player (cached, so it still loads if the link to the
#     main server blips), song title, voting, "Coming up", song saving, HTTPS
#   - The listener address never serves the studio (login, uploads)
#   - Optional studio address (STUDIO_HOST), port 8443: a sealed pipe to the main server.
#     The encryption runs from the browser all the way to the main server; this server
#     only passes encrypted bytes along and can't read logins, uploads or recordings.
#     Nothing from the studio is stored here.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
ORIGIN="${ORIGIN:-3.21.217.155}"          # the main server (plain HTTP by address)
ICE_PORT="${ICE_PORT:-8100}"
STUDIO_HOST="${STUDIO_HOST:-}"
STUDIO_PORT="${STUDIO_PORT:-8443}"

if [ -z "$DOMAIN" ] || [ "$(id -u)" -ne 0 ]; then
  echo "Usage: sudo bash setup.sh <domain> [email]" >&2
  exit 1
fi
command -v apt-get >/dev/null || { echo "Needs Ubuntu or Debian." >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }

# ---- 1. Packages ---------------------------------------------------------------
# If Icecast wasn't already in use here, its stock service gets turned off afterwards
# (it would listen publicly on :8000 with default passwords).
STOCK_ICECAST_ACTIVE=no
systemctl is-active --quiet icecast2 2>/dev/null && STOCK_ICECAST_ACTIVE=yes

say "Installing nginx, icecast2, certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx icecast2 certbot curl openssl
if [ -n "$STUDIO_HOST" ]; then
  # The sealed pipe uses nginx's stream module (built in on some setups, separate on others)
  apt-get install -y -q libnginx-mod-stream 2>/dev/null || true
fi

if [ "$STOCK_ICECAST_ACTIVE" = no ]; then
  systemctl disable --now icecast2 >/dev/null 2>&1 || true
fi

# ---- 2. Icecast relay ------------------------------------------------------------
say "Configuring the Icecast relay (127.0.0.1:$ICE_PORT, pulling from $ORIGIN)"
install -d -m 750 -o root -g icecast /etc/raadio-relay
install -d -m 755 -o icecast2 -g icecast /var/log/raadio-relay
CONF=/etc/raadio-relay/icecast.xml
if [ -f "$CONF" ]; then
  ADMIN_PW="$(sed -n 's:.*<admin-password>\(.*\)</admin-password>.*:\1:p' "$CONF")"
fi
ADMIN_PW="${ADMIN_PW:-$(openssl rand -hex 16)}"
SOURCE_PW="$(openssl rand -hex 16)"       # nobody streams into this server directly

relay_block() {
  cat <<EOF
    <relay>
        <server>$ORIGIN</server>
        <port>80</port>
        <mount>$1</mount>
        <local-mount>$1</local-mount>
        <on-demand>1</on-demand>
        <relay-shoutcast-metadata>0</relay-shoutcast-metadata>
    </relay>
    <mount type="normal">
        <mount-name>$1</mount-name>
        <burst-size>$2</burst-size>
    </mount>
EOF
}

{
  cat <<EOF
<!-- Written by raadio relay/setup.sh. Re-run setup.sh instead of editing. -->
<icecast>
    <hostname>$DOMAIN</hostname>
    <limits>
        <clients>2000</clients>
        <sources>6</sources>
        <queue-size>524288</queue-size>
        <client-timeout>30</client-timeout>
        <header-timeout>15</header-timeout>
        <source-timeout>20</source-timeout>
        <burst-on-connect>1</burst-on-connect>
        <burst-size>56000</burst-size>
    </limits>
    <authentication>
        <source-password>$SOURCE_PW</source-password>
        <relay-password>$SOURCE_PW</relay-password>
        <admin-user>admin</admin-user>
        <admin-password>$ADMIN_PW</admin-password>
    </authentication>
    <listen-socket>
        <port>$ICE_PORT</port>
        <bind-address>127.0.0.1</bind-address>
    </listen-socket>
EOF
  # what a new listener gets at once: just over what browsers wait for before playing
  # (~32 KB of Opus, ~128 KB of MP3), so the sound starts as soon as they press play
  relay_block /radio.opus 56000      # start threshold + 3 s of audio (see deploy/icecast)
  relay_block /radio-lite.opus 44000
  relay_block /radio.mp3 176000
  relay_block /radio-lite.mp3 152000
  cat <<EOF
    <fileserve>1</fileserve>
    <paths>
        <basedir>/usr/share/icecast2</basedir>
        <logdir>/var/log/raadio-relay</logdir>
        <webroot>/usr/share/icecast2/web</webroot>
        <adminroot>/usr/share/icecast2/admin</adminroot>
    </paths>
    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>2</loglevel>
        <logsize>10000</logsize>
    </logging>
    <security><chroot>0</chroot></security>
</icecast>
EOF
} > "$CONF.new"
chown root:icecast "$CONF.new"
chmod 640 "$CONF.new"
mv "$CONF.new" "$CONF"

cat > /etc/systemd/system/raadio-relay.service <<EOF
[Unit]
Description=Raadio relay (Icecast, pulls the streams from the main server)
After=network-online.target
Wants=network-online.target

[Service]
User=icecast2
Group=icecast
ExecStart=/usr/bin/icecast2 -c $CONF
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable raadio-relay >/dev/null 2>&1
systemctl restart raadio-relay

# ---- 3. Nginx ----------------------------------------------------------------------
SITE=/etc/nginx/sites-available/raadio-relay
ACME=/var/www/raadio-acme
install -d -m 755 "$ACME"
install -d -m 700 -o www-data -g www-data /var/cache/nginx/raadio
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

# The parts shared by the HTTP-only and the HTTPS versions
locations() {
  cat <<EOF
    # Text files go out compressed (the player's script and styles shrink ~4x)
    gzip on;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/css application/javascript text/javascript application/json application/manifest+json image/svg+xml text/plain;

    # Web player, from the main server; kept for a week so the page still loads
    # when the link abroad is slow or down. Fetched and stored uncompressed (one copy),
    # compressed here for each listener.
    location / {
        proxy_pass http://$ORIGIN;
        proxy_set_header Host $ORIGIN;
        proxy_set_header Accept-Encoding "";
        # keep our own copy by our own rules (the main server tells browsers to re-check
        # the page every time, which would otherwise stop it being stored here at all)
        proxy_ignore_headers Cache-Control Expires;
        proxy_cache raadio;
        proxy_cache_valid 200 301 5m;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_background_update on;
        proxy_cache_lock on;
        proxy_connect_timeout 10s;
        add_header X-Cache \$upstream_cache_status always;
    }

    # Streams, from the local Icecast relay
    location ~ ^/radio(-lite)?\.(mp3|opus)\$ {
        proxy_pass http://127.0.0.1:$ICE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
        proxy_method GET;              # Icecast refuses HEAD; players / bots that check first still work
        proxy_buffering off;
        proxy_request_buffering off;
        gzip off;
        proxy_read_timeout 7200s;
        proxy_send_timeout 7200s;
        add_header Cache-Control "no-store" always;
    }

    # Song title, voting, "Coming up", saving a song: straight to the main server.
    # X-Forwarded-For is overwritten (not appended), so listeners can't fake it;
    # the main server trusts it from this server's address only.
    location ~ ^/(skip|now-playing|note)\$ {
        proxy_pass http://$ORIGIN;
        proxy_set_header Host $ORIGIN;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_connect_timeout 10s;
        add_header Cache-Control "no-store" always;
    }
    location ~ ^/api/(upcoming|track/|wave/|chat\$) {
        proxy_pass http://$ORIGIN;
        proxy_set_header Host $ORIGIN;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_connect_timeout 10s;
        proxy_read_timeout 180s;
        add_header Cache-Control "no-store" always;
    }

    # The studio is never served through a relay (passwords would pass through it)
    location /api/ {
        return 403;
    }

    # Listener counts of this relay, for the station's curator stats
    location = /relay-status.json {
        proxy_pass http://127.0.0.1:$ICE_PORT/status-json.xsl;
        add_header Cache-Control "no-store" always;
        add_header Access-Control-Allow-Origin "*" always;
    }
EOF
}

write_site() {   # $1 = yes when a certificate exists
  {
    echo "# Written by raadio relay/setup.sh. Re-run setup.sh instead of editing."
    echo "proxy_cache_path /var/cache/nginx/raadio levels=1:2 keys_zone=raadio:10m max_size=50m inactive=7d use_temp_path=off;"
    echo
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN;"
    echo "    location /.well-known/acme-challenge/ { root $ACME; }"
    if [ "$1" = yes ]; then
      echo "    location / { return 301 https://\$host\$request_uri; }"
    else
      locations
    fi
    echo "}"
    if [ "$1" = yes ]; then
      echo
      echo "server {"
      echo "    listen 443 ssl http2;"
      echo "    listen [::]:443 ssl http2;"
      echo "    server_name $DOMAIN;"
      echo "    ssl_certificate     $CERT_DIR/fullchain.pem;"
      echo "    ssl_certificate_key $CERT_DIR/privkey.pem;"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo "    ssl_session_cache shared:raadio_ssl:10m;"
      locations
      echo "}"
    fi
  } > "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/raadio-relay
  nginx -t
  systemctl reload nginx
}

if [ -f "$CERT_DIR/fullchain.pem" ]; then
  say "Nginx for https://$DOMAIN (certificate already here)"
  write_site yes
else
  say "Nginx for http://$DOMAIN (getting a certificate next)"
  write_site no
fi

# ---- 3b. Studio: sealed pipe to the main server --------------------------------------
STREAM_CONF=/etc/nginx/raadio-studio-stream.conf
STUDIO_SITE=/etc/nginx/sites-available/raadio-studio
if [ -n "$STUDIO_HOST" ]; then
  say "Studio at https://$STUDIO_HOST:$STUDIO_PORT (sealed pipe to $ORIGIN)"
  cat > "$STREAM_CONF" <<EOF
# Written by raadio relay/setup.sh. The studio address: encrypted bytes go to the main
# server unopened (TLS ends there, not here). Only the studio name is let through.
stream {
    map \$ssl_preread_server_name \$raadio_studio_upstream {
        $STUDIO_HOST  $ORIGIN:443;
        default       127.0.0.1:9;
    }
    server {
        listen $STUDIO_PORT;
        listen [::]:$STUDIO_PORT;
        ssl_preread on;
        proxy_pass \$raadio_studio_upstream;
        proxy_connect_timeout 10s;
        proxy_timeout 1h;
    }
}
EOF
  # stream {} has to sit at the top level of nginx.conf, outside http {}
  grep -qF "include $STREAM_CONF;" /etc/nginx/nginx.conf || echo "include $STREAM_CONF;" >> /etc/nginx/nginx.conf
  # Port 80 for the studio name: certificate checks go to the main server (it holds the
  # studio's certificate); everything else is sent to the encrypted address
  cat > "$STUDIO_SITE" <<EOF
# Written by raadio relay/setup.sh.
server {
    listen 80;
    listen [::]:80;
    server_name $STUDIO_HOST;
    location /.well-known/acme-challenge/ {
        proxy_pass http://$ORIGIN;
        proxy_set_header Host \$host;
    }
    location / { return 301 https://\$host:$STUDIO_PORT\$request_uri; }
}
EOF
  ln -sf "$STUDIO_SITE" /etc/nginx/sites-enabled/raadio-studio
  nginx -t
  systemctl reload nginx
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  [ -z "$STUDIO_HOST" ] || ufw allow "$STUDIO_PORT/tcp" >/dev/null
fi

# ---- 4. HTTPS certificate (Let's Encrypt) --------------------------------------------
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  say "Getting an HTTPS certificate for $DOMAIN"
  if [ -n "$EMAIL" ]; then ACCOUNT=(--email "$EMAIL"); else ACCOUNT=(--register-unsafely-without-email); fi
  if certbot certonly --webroot -w "$ACME" -d "$DOMAIN" --non-interactive --agree-tos \
       "${ACCOUNT[@]}" --deploy-hook "systemctl reload nginx"; then
    write_site yes
  else
    echo
    echo "!! No certificate. The relay works over plain http://$DOMAIN for now."
    echo "   Check that $DOMAIN points to this server, then run this script again."
  fi
fi

# ---- 5. Check ----------------------------------------------------------------------
say "Checking"
sleep 2
ok=yes
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$ORIGIN/now-playing" || true)"
if [ "$code" = 200 ]; then echo "    main server reachable:   yes"
else echo "    main server reachable:   NO (HTTP $code). This server can't reach $ORIGIN."; ok=no; fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" http://127.0.0.1/now-playing || true)"
if [ "$code" = 200 ]; then echo "    song title via relay:    yes"
else echo "    song title via relay:    NO (HTTP $code)"; ok=no; fi
bytes="$(curl -s -o /dev/null -w '%{size_download}' --max-time 6 -H "Host: $DOMAIN" http://127.0.0.1/radio.opus || true)"
if [ "${bytes:-0}" -gt 20000 ]; then echo "    stream via relay:        yes ($bytes bytes in 6 s)"
else echo "    stream via relay:        NO (${bytes:-0} bytes). See: journalctl -u raadio-relay"; ok=no; fi

MYIP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[ -n "$MYIP" ] || MYIP="(the public IP from your hosting panel)"
SCHEME=http; [ -f "$CERT_DIR/fullchain.pem" ] && SCHEME=https
cat <<EOF

==> Done$([ "$ok" = yes ] || echo " (with problems above)"). Listeners open:  $SCHEME://$DOMAIN

    Send these to the station owner, for the main server:
      relay address:  $MYIP
      status URL:     $SCHEME://$DOMAIN/relay-status.json
EOF
if [ -n "$STUDIO_HOST" ]; then
  cat <<EOF
      studio name:    $STUDIO_HOST

    The studio opens at https://$STUDIO_HOST:$STUDIO_PORT once the station owner has run
    "sudo bash deploy/add-studio-host.sh $STUDIO_HOST" on the main server.
    If the hosting company has its own firewall, open TCP port $STUDIO_PORT there too.
EOF
fi

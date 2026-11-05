#!/bin/bash
# Renders icecast.xml from the template using values from .env, then starts Icecast.
set -euo pipefail

: "${ICECAST_SOURCE_PASSWORD:?Set ICECAST_SOURCE_PASSWORD in .env}"
: "${ICECAST_ADMIN_PASSWORD:?Set ICECAST_ADMIN_PASSWORD in .env}"
export ICECAST_RELAY_PASSWORD="${ICECAST_RELAY_PASSWORD:-$ICECAST_ADMIN_PASSWORD}"
export ICECAST_HOSTNAME="${ICECAST_HOSTNAME:-localhost}"
export ICECAST_ADMIN_EMAIL="${ICECAST_ADMIN_EMAIL:-admin@localhost}"
export ICECAST_MAX_LISTENERS="${ICECAST_MAX_LISTENERS:-500}"

# Only these variables are replaced, so a "$" anywhere else in the template stays as is
# The single quotes are on purpose: envsubst wants the literal names.
# shellcheck disable=SC2016
VARS='${ICECAST_SOURCE_PASSWORD} ${ICECAST_ADMIN_PASSWORD} ${ICECAST_RELAY_PASSWORD} ${ICECAST_HOSTNAME} ${ICECAST_ADMIN_EMAIL} ${ICECAST_MAX_LISTENERS}'
envsubst "$VARS" < /etc/icecast2/icecast.xml.template > /tmp/icecast.xml

# The access log would hold every listener's address and browser (many listen from Iran):
# it goes nowhere. Icecast can't switch it off, so the file is a link to /dev/null.
ln -sfn /dev/null /var/log/icecast2/access.log

# Show Icecast's error log in "docker compose logs" (it can't write to stdout itself)
touch /var/log/icecast2/error.log
tail -n0 -F /var/log/icecast2/error.log >&2 &

echo "Icecast starting on :8000 (hostname ${ICECAST_HOSTNAME}, max ${ICECAST_MAX_LISTENERS} listeners)"
exec icecast2 -c /tmp/icecast.xml

# Raadio Icecast: Debian's icecast2 package with a config rendered from .env at start
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends icecast2 gettext-base ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Log files live inside the container; entrypoint.sh copies the error log to the
# container output so "docker compose logs icecast" shows it
RUN mkdir -p /var/log/icecast2 && chown -R icecast2 /var/log/icecast2

COPY icecast.xml.template /etc/icecast2/icecast.xml.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

# Icecast refuses to run as root, so use the user the Debian package created
USER icecast2
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]

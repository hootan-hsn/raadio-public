# Raadio relay (a server inside Iran)

Listeners in Iran open the relay's own domain. Everything they need comes from that
server inside Iran:

```
listener in Iran ──HTTPS──▶ relay (radio.example.ir)  ──HTTP, one pull per stream──▶  main server (AWS)
                            ├─ web player (cached for a week)
                            ├─ streams (Icecast relay, on demand)
                            └─ song title, votes, "Coming up", save song → passed to the main server
```

- **Listeners never connect abroad.** For most Iranian mobile plans, domestic traffic is
  also cheaper.
- **The relay pulls each stream once,** and only while someone is listening, however many
  people listen.
- **The listener address never serves the studio** (login, uploads). The relay decrypts
  that address's traffic, so passwords must not go through it.
- **The studio has its own address** (optional), e.g. `https://studio.example.ir:8443`.
  There the relay is a sealed pipe: the encryption runs from the browser all the way to
  the main server, which holds that name's certificate. The relay passes encrypted bytes
  along and can't read logins, uploads or recordings. It stores none of them either.
- **No secrets live on the relay,** so nothing from the main server can leak from it.

### Space and load on the relay

| | |
|---|---|
| Disk | About 60 MB: packages ~40 MB, cached player page ~5 MB (capped at 200 MB), logs a few MB. Studio files are never stored here. |
| Memory | About 30–50 MB. CPU: hardly any (nothing is re-encoded). |
| Traffic out (inside Iran) | Per listener: ~29 MB an hour on HQ, ~14 MB on Saver. |
| Traffic in (from abroad) | Per stream in use, however many listeners: Opus 29 MB an hour (HQ) or 14 (Saver), MP3 58 (HQ) or 29 (Saver). Plus studio uploads passing through. |

## On the relay server (your friend)

Needs Ubuntu or Debian, root, ports 80 and 443, and a DNS **A record** for the
subdomain pointing to this server. Copy `setup.sh` to the server, then run:

```bash
sudo bash setup.sh radio.example.ir you@example.com
```

With the studio too (a second DNS A record, `studio.example.ir`, pointing to the same server):

```bash
sudo STUDIO_HOST=studio.example.ir bash setup.sh radio.example.ir you@example.com
```

The studio uses port 8443. If the hosting company has its own firewall panel, open TCP
port 8443 there.

It takes about a minute. It ends with three checks (main server reachable, song title,
stream), then prints the relay's address and a status URL. **Send both to the station
owner.**

Run it again at any time; it only rewrites its own files:
- `/etc/raadio-relay/`
- `/etc/systemd/system/raadio-relay.service`
- `/etc/nginx/sites-available/raadio-relay`
- with a studio: `/etc/nginx/sites-available/raadio-studio` and `/etc/nginx/raadio-studio-stream.conf`, plus one `include` line at the end of `/etc/nginx/nginx.conf`

To remove it:

```bash
sudo systemctl disable --now raadio-relay
sudo rm /etc/nginx/sites-enabled/raadio-relay
sudo systemctl reload nginx
```

If Let's Encrypt can't be reached from the server, the relay still works over plain
`http://`. In that case, put a certificate from another provider at the paths in
`/etc/nginx/sites-available/raadio-relay`.

## On the main server (station owner), once per relay

1. **Trust the relay's report of who is voting.** Without this, all of Iran counts as a
   single voter. This applies only to the plain-HTTP address the relay pulls from (see
   `deploy/nginx/raadio-ip.conf`). Use the relay address that `setup.sh` printed:
   ```bash
   echo 'set_real_ip_from RELAY_ADDRESS; real_ip_header X-Forwarded-For;' | sudo tee /etc/nginx/raadio-relays.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
   For more relays, repeat the `set_real_ip_from` line once per address.

2. **Count the relay's listeners in the curator stats.** In `~/raadio/.env`:
   ```
   RELAY_STATUS_URLS=https://radio.example.ir/relay-status.json
   ```
   Then run `docker compose up -d`. For several relays, separate the URLs with commas.

3. **Studio address** (only if the relay was set up with `STUDIO_HOST`). This gets that
   name its own certificate here, on the main server:
   ```bash
   cd ~/raadio && sudo bash deploy/add-studio-host.sh studio.example.ir
   ```
   Studio users then open `https://studio.example.ir:8443`.

## Limits

- **If Iran cuts international links,** the relay keeps serving the player page from its
  cache, but no new music arrives.
- **The pull from the main server is plain HTTP by address.** This is the route that
  already works from Iran. It carries only the public stream; the studio pipe is
  encrypted end to end.
- **Whoever controls the studio domain could, in principle, get their own certificate**
  for it and stop passing it through sealed. The pipe protects against snooping on the
  way and on the server as set up; it can't protect against the domain's owner deciding
  otherwise. To check, look up the name on https://crt.sh: only certificates issued to
  the main server should appear.

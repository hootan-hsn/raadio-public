<div align="center">

# Raadio

**A self-hosted 24/7 internet radio where the listeners decide what stays on air.**

[![CI](https://github.com/hootan-hsn/raadio-public/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/hootan-hsn/raadio-public/actions/workflows/ci-cd.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-FastAPI-3776AB)
![JavaScript](https://img.shields.io/badge/JavaScript-no%20build%20step-F7DF1E)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)
![Terraform](https://img.shields.io/badge/Terraform-AWS-7B42BC)

[**Try the demo**](https://hootan-hsn.github.io/raadio-public/) · [Listen at raadio.xyz](https://raadio.xyz) · English and Persian · installable as an app

![Raadio player](screenshot.png)

![Raadio playing](demo.gif)

</div>

One live station: everyone hears the same song at the same moment, and enough skip votes
move it along for everyone.

Raadio is a self-hosted internet radio station you run yourself. Songs come from a Telegram
channel you control, the controller lines them up and levels them, Icecast streams them to
everyone at once, and listeners vote songs off — no streaming service in the middle, and no
account needed to listen.

## Features

- **Live streaming** in Opus (64k HQ, 32k Saver) and MP3 (128k), with quality switching and
  an automatic drop to Saver on weak connections
- **Clean sound:** every song is leveled to -14 LUFS (EBU R128) and otherwise left as uploaded
- **Skip voting** with per-device and per-address limits
- **Studio for hosts:** scheduled shows, uploads, and live shows with several hosts
- **Listener analytics:** busiest hours, people and session lengths per country, with no
  addresses stored
- **Installable PWA** in English and Persian, with a first-visit guide and light and dark themes
- **Relay script** for serving listeners through a second server under its own domain
- **Infrastructure as code:** Docker Compose, Nginx and Terraform on AWS
- **Your music, your server:** the library is a Telegram channel you control, and the whole
  station runs on one server you own
- **No build step, no framework in the player:** vanilla JavaScript, plain HTML audio, and a
  Three.js sky — open `web/` and it runs

## How it works

```mermaid
flowchart LR
    TG[(Telegram channel<br/>music library)] --> C
    H[Hosts in the studio] --> C
    C[Controller<br/>FastAPI + Pyrogram] --> F[FFmpeg encoder]
    F --> I[Icecast]
    I --> N[Nginx]
    C --> N
    N --> L[Listeners<br/>web player / PWA]
    L -- skip votes --> N
```

| Layer | Tools |
| --- | --- |
| Backend | Python, FastAPI, Pyrogram, SQLite |
| Audio | FFmpeg, Icecast, Opus, MP3 |
| Frontend | Vanilla JavaScript PWA, Three.js for the background sky |
| Delivery | Nginx, Certbot, Docker Compose |
| Cloud | Terraform, AWS EC2, CloudWatch alarms |
| Checks | GitHub Actions: Python, JavaScript, ShellCheck, Nginx, Docker, Terraform |

## Run it

Two ways in: just listen at [raadio.xyz](https://raadio.xyz) — nothing to install — or run
your own station with Docker (below).

You need Docker and [Telegram API credentials](https://my.telegram.org), plus a Telegram
channel you control that holds your music.

```bash
git clone https://github.com/hootan-hsn/raadio-public.git
cd raadio-public
cp .env.example .env          # then fill in your values
docker compose up -d --build
docker compose ps             # both should say "healthy" after about 30 s
```

The containers listen only on 127.0.0.1 (Icecast on 8000, API on 8080). Put Nginx in front of
them using the files in [`deploy/nginx`](deploy/nginx). Then point `CONFIG.HOSTS` in
`web/script.js` at your own domain, as it starts out pointing at raadio.xyz.

Login starts as a demo: any name and password open the studio, nothing leaves the browser and
nothing is saved. For real accounts, set `DEMO_LOGIN: false` in `web/script.js` and create users
with `controller/manage_users.py`.

Only play music you have the right to broadcast. Licensing depends on your country.

## Project layout

```
controller/   FastAPI app, Telegram client, FFmpeg encoder, studio and analytics
web/          The player (PWA), with no build step
deploy/       Nginx, Icecast and deployment scripts
infra/        Terraform for the AWS server, firewall and alerts
relay/        One-command relay server
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see
[SECURITY.md](SECURITY.md).

## This repo and raadio.xyz

This is the open core of Raadio. The station at raadio.xyz runs a private version with extra
playback and music-programming features that aren't included here.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service, you must publish your changes.

Built by [Hootan Hosseini](https://github.com/hootan-hsn) ·
[portfolio](https://hootan-hsn.framer.website/)

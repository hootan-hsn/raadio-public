# Contributing

Bug fixes and small improvements are welcome. For anything bigger, open an issue first.

1. Fork the repo and branch from `main`.
2. Copy `.env.example` to `.env` and fill it in. See the README.
3. Keep the player plain JavaScript, with no build step.
4. Run the same checks as CI: Python syntax, `node --check web/script.js`, `shellcheck`
   on the scripts in `deploy/`.
5. Open a pull request saying what changed and how you tested it.

By contributing you agree that your work is licensed under AGPL-3.0.

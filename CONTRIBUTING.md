# Contributing

Thanks for your interest in improving Pagevoice. Bug reports, documentation fixes, and focused improvements are welcome.

## Before opening an issue or pull request

- Search existing issues to avoid duplicates.
- Include your macOS version, Mac chip, Node version, and Python version for environment-specific reports.
- Never attach a book or PDF containing private or copyrighted material. A short description or a synthetic sample is safer.
- Keep changes focused and explain the user-facing behavior they affect.

## Development setup

Follow the setup instructions in [README.md](README.md), then run the app with `sh ./start-local.sh`. The frontend is a Vite/React app in `src/`; the local FastAPI and Kokoro MLX service is in `backend/`.

Pagevoice is designed to keep document processing and speech synthesis on the user's Mac. Changes should preserve the loopback-only service and avoid sending PDF contents to third-party services.

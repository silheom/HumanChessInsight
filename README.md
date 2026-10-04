# Human Chess Insight

A mobile-first, browser-only chess analysis prototype.

## Architecture
- GitHub Pages for static hosting.
- Stockfish 19 Lite Single runs in the user's browser via Web Worker + WASM.
- GitHub Actions downloads the official Stockfish npm package during deployment and places the JS/WASM engine files in the Pages artifact. The engine is not a server-side service.
- PGN parsing and position handling happen in the browser.
- No Render, Flask, database, login, or paid API is required.

## GitHub Pages setup
Set **Settings → Pages → Source** to **GitHub Actions**. Every push to `main` runs `.github/workflows/pages.yml` and publishes the static site.

## Important
Stockfish.js is GPLv3. See `LICENSE-STOCKFISH.txt` and `THIRD-PARTY-NOTICES.txt`.

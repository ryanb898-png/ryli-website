# RYLI marketing site

Plain HTML/CSS/vanilla JS, no build step, no framework. Deployed via Cloudflare
Pages, auto-deploying on every push to this repo's default branch.

## Local preview

```
python -m http.server 8090
```
then open http://localhost:8090

## Structure

- `index.html` / `styles.css` / `script.js` — the whole site
- `assets/images/` — brand assets + real app screenshots
- `assets/favicon/` — generated favicon set (see below)
- `scripts/generate-favicons.mjs` — regenerate the favicon set from
  `assets/images/ryliring.png` (or a new logo file): `npm install && npm run favicons`

## Brand tokens

Palette (from the main RYLI app, `overlays/overlay.css`): Celestial Blue
`#6AAEFF`, Aurora Purple `#B388FF`, Soft Cyan `#7DE7FF`, Pearl White
`#FFFFFF`, Frost `#F2F6FF`, Slate `#0D1117`. Fonts: Saira Condensed
(display), Inter (body).

## Known TODOs

- `script.js`'s `FORMSPREE_ENDPOINT` is a placeholder — replace once the
  Formspree account exists.
- Every CTA is an email-capture signup, not a real download — there's no
  packaged installer yet. Each is marked `<!-- TODO: swap for real download
  link -->` in `index.html` for when packaging ships.
- Pricing is intentionally "revealed at launch" — no real price decided yet.
- Swap `assets/images/rylilogo-full.png` / `ryliring.png` for the updated
  logo file once it's provided, then re-run `npm run favicons`.

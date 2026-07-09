# Build Log

## 2026-07-01 — Initial build (prototype → real app)
- Explored the CoWork prototype (`field-assistant-deploy/index.html`, ~5,857 lines) and the
  empty `Code\Field Assistant` target.
- Decisions (with Travis): backend = **Microsoft/Entra (Azure)**; font = **Inter**;
  delivery = **installable PWA**; track scope = my call (records only + activity log);
  everyone has M365; **IT/admin will provision Azure**.
- Ported `index.html` **verbatim** into `public/`, then surgical edits: Inter `@font-face`
  + font swap, header logo lockup, PWA manifest link + service-worker registration, admin
  "Manage Users" tab (hidden), OCR endpoint → `/api/ocr-truck-ticket`, `app-sync.js` hook.
- Extracted the base64 EBCC logo → `icons/logo.png` (180×180); generated `icon-192/512`.
  Self-hosted Inter variable woff2 in `assets/inter/`.
- Wrote backend: `api/shared/auth.js`, `api/me`, `api/records`, `api/users`,
  `api/ocr-truck-ticket`; `staticwebapp.config.json`; `host.json` + `package.json`.
- Wrote `public/app-sync.js` (auth gate, offline sync, account menu, EWT capture, admin
  console) and branded `public/login.html`.
- **Verified in local preview** (mock admin via `dev/static-server.ps1`): login screen,
  full app + Inter + logo, admin tab reveal, Manage Users list + counts + role selects +
  per-user View. Formula parity confirmed: Lime 50000/33 → 91.7t/9 trucks; Flex Base
  50000/6/22 → 1666.7t/76 trucks.
- **Bug found & fixed:** ID collision — admin console reused `admin-panel` (already used by
  the Cost Per Yard Edit-rates panel). Renamed console ids to `adm-*`.
- Docs: `README.md`, `SETUP-AZURE.md`, memory files.

## 2026-07-09 — Deployment (LIVE)
- Travis created GitHub account + repo `Travis-EB/EBCC-Field-Assistant`; pushed `main`.
- Azure provisioned by Travis: rg `rg-ebcc-field-assistant`, Cosmos `ebcc-field-assistant`
  (free tier, westus2), SWA `EBCC-Field-Assistant` (app `./public`, api `api`).
- Travis lacked Entra app-registration rights → IT created the app registration.
  Client ID `f5ef35ef-006e-4143-b1f4-0420484a394a`, tenant `f95ee318-b7d4-49aa-b795-b188b614caca`.
- **Gotcha 1:** `staticwebapp.config.json` at repo root is IGNORED — must be inside
  `public/` (app location). First deploys served the app with NO auth. Moved + pushed.
- **Gotcha 2:** custom `auth` block requires the **Standard** SKU; Free-tier deploy failed
  with "auth configuration only supported on Standard." Travis upgraded to Standard.
- Re-ran the workflow (GitHub API); deploy succeeded. Verified live:
  `/`, `/index.html`, `/api/me` all 302 → `/login.html`; login chain reaches
  `login.microsoftonline.com/<tenant>` with IT's client id. App URL:
  https://black-sky-02b506c1e.7.azurestaticapps.net

### Next / open
- Travis to sign in as first user (auto-seeds admin via ADMIN_EMAILS) and confirm the
  Manage Users tab; then a second employee for the isolation check.
- Confirm SWA app settings all present: AAD_CLIENT_ID, AAD_CLIENT_SECRET, COSMOS_CONN,
  ADMIN_EMAILS; ANTHROPIC_API_KEY still needed for Truck Ticket OCR.
- Optional later: move photos to Blob Storage if ticket volume grows; consider syncing the
  calculators if Travis wants that visibility.

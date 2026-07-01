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

### Next / open
- IT to provision Azure (SETUP-AZURE.md), then deploy and run the end-to-end verification
  (two real users → isolation; admin disable → block).
- Optional later: move photos to Blob Storage if ticket volume grows; consider syncing the
  calculators if Travis wants that visibility.

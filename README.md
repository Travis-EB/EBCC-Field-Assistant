# EBCC Field Assistant

Field tools for Earth Basics Contracting foremen — Cost Per Yard, Flat Work, Lime
Trucks, Flex Base, Extra Work Ticket, Truck Tickets (AI OCR), and Load Count — now
delivered as an **installable PWA behind Microsoft (Entra) sign-in**, with per-user
data isolation and an admin console for managing users and reviewing their inputs.

This is a rebuild of the original single-file CoWork prototype. The 7 tabs, every
formula, the CA/TX equipment libraries, and the EBCC logo are ported **verbatim**; the
only visible change is the smoother **Inter** font and light polish. Everything new is
auth + sync + admin.

> The original prototype lives in `CoWork\Projects\EBCC Field Assistant\` and is left
> untouched. All work here is under `Code\Field Assistant\`.

## What's here

```
public/                 Frontend PWA (served as static content)
  index.html            The app — 7 tabs, ported verbatim + Inter font + logo + PWA
  login.html            Branded "Sign in with Microsoft" screen
  app-sync.js           Auth gate, offline-safe record sync, account menu, admin console
  service-worker.js     Offline app-shell caching
  manifest.webmanifest  PWA install metadata
  icons/                EBCC logo + 192/512 PWA icons
  assets/inter/         Self-hosted Inter variable font (works offline)
api/                    Azure Functions (SWA managed API)
  me/                   GET  identity + role (creates user on first sign-in)
  records/              GET/POST/DELETE per-user records (server-enforced isolation)
  users/                GET/PATCH admin-only user management
  ocr-truck-ticket/     POST image -> Claude vision OCR (ported from the Netlify fn)
  shared/auth.js        Identity parsing + Cosmos access + admin logic
staticwebapp.config.json  Auth provider, route protection, login redirect
dev/static-server.ps1   Dependency-free LOCAL UI preview (mock admin) — dev only
memory/                 Project knowledge base (summary, architecture, chat log)
SETUP-AZURE.md          Click-by-click provisioning guide for IT/admin
```

## How it works

- **Login:** Azure Static Web Apps handles Entra sign-in. Unauthenticated requests are
  redirected to `login.html`. Only `earthbasics.net` accounts (locked by tenant) can sign in.
- **Identity is trusted from the platform**, never the browser. Each API call reads the
  signed `x-ms-client-principal` header.
- **Isolation:** the `records` function only ever returns the caller's own data — unless
  the caller is an **admin**, who may pass `?userId=` to review one user. Enforced in the
  Function, so it can't be bypassed from the client.
- **Roles** live in the `users` container (`admin` | `user` | `disabled`). `travis@earthbasics.net`
  is seeded as admin (configurable via the `ADMIN_EMAILS` app setting).
- **Synced records:** Truck Tickets, Load Count days, and Extra Work Tickets. The four
  calculators stay local and instant. Saves go to `localStorage` immediately (unchanged
  field UX) and sync to Azure in the background; offline edits flush when back online.

## Run it locally

**UI-only preview (no Node needed)** — mock admin, for checking the frontend:
```
powershell -ExecutionPolicy Bypass -File dev\static-server.ps1 -Port 8791
# open http://localhost:8791/
```

**Full stack (real auth + data)** — requires Node 18+ and the SWA CLI:
```
npm i -g @azure/static-web-apps-cli
cd api && npm install && cd ..
# copy api/local.settings.json.example -> api/local.settings.json and fill in secrets
swa start public --api-location api
```

## Deploy

Provisioning is a one-time IT task — see **SETUP-AZURE.md**. After that, deploys are just a
push of this folder to the Static Web App (via GitHub Actions or the SWA CLI
`swa deploy`). Required app settings: `COSMOS_CONN`, `ANTHROPIC_API_KEY`, `AAD_CLIENT_ID`,
`AAD_CLIENT_SECRET`, and the tenant id in `staticwebapp.config.json`.

## Notes / decisions

- Photos & signatures are stored inline (compressed) in the record blobs — simplest, and
  well under Cosmos' 2 MB item limit. If ticket volume grows, move images to Blob Storage
  (the record already isolates them into their own type).
- Sync is last-write-wins per (user, record-type). That's correct for the common case of
  one foreman on one phone; server data hydrates a fresh device on first login.
- OCR model is `claude-sonnet-4-6` by default; override with the `OCR_MODEL` app setting.

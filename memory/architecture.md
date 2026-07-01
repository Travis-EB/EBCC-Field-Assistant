# Architecture & Internals

## Stack
- **Azure Static Web Apps** (free) — hosts `public/`, provides Entra login, links the `api/` Functions.
- **Azure Functions** (Node 18, v3 model: `function.json` + `index.js`) — the API.
- **Azure Cosmos DB for NoSQL** (free tier) — database `ebcc`, containers auto-created:
  - `users` (partition key `/id`): `{ id, email, name, role, createdAt, lastActiveAt, counts }`
  - `records` (partition key `/ownerId`): one doc per (user, type),
    id = `${ownerId}:${type}`, `{ ownerId, ownerEmail, type, data, updatedAt }`.

## Auth & authorization (the security model)
- Identity comes ONLY from the SWA-injected `x-ms-client-principal` header (base64 JSON).
  The browser cannot forge it. Parsed in `api/shared/auth.js` → `getPrincipal()`.
- `ensureUser()` upserts the user on first sight and stamps `lastActiveAt`. Emails in the
  `ADMIN_EMAILS` setting (default `travis@earthbasics.net`) are forced to `role: admin`.
- **Isolation:** `api/records` filters by `ownerId = caller`. Only an admin may pass
  `?userId=` to READ another user (admins review, never write others). Non-admins passing
  a foreign `userId` get 403.
- `api/users` is admin-only (GET list, PATCH role). An admin can't remove their own admin
  (anti-lockout).

## Endpoints
| Route | Method | Who | Purpose |
|---|---|---|---|
| `/api/me` | GET | any signed-in | identity + role; creates user on first login |
| `/api/records` | GET/POST/DELETE | user (own) / admin (read any) | sync record blobs |
| `/api/users` | GET/PATCH | admin | list users, change role/status |
| `/api/ocr-truck-ticket` | POST | signed-in | image → Claude vision OCR |

## Frontend integration (`public/app-sync.js`)
- Deferred script, loads after the main app. `boot()`:
  - `GET /api/me` → 401 redirects to `login.html`; `disabled` shows a block screen;
    else renders the account menu, reveals the admin tab if admin, hydrates records.
- **Sync:** wraps `localStorage.setItem`; when a synced key changes it debounces a
  `POST /api/records`. Offline-safe via a `ebcc_sync_pending` map flushed on `online` /
  `visibilitychange` / `pagehide`.
- **Hydrate:** on login, pulls the user's records and fills any EMPTY local key (never
  clobbers unsynced local edits); reloads once so the app renders them.
- **EWT capture:** listens on `#ewt-email-btn` / `#ewt-preview-btn`, scrapes the form into
  `ebcc_ewt_records_v1` (which then syncs).
- **Admin console:** `loadAdmin()` (in the `#tab-admin` section) lists users + counts and
  wires role `<select>`s and per-user "View" drill-downs.

## Routing / config
- `staticwebapp.config.json`: Entra provider (issuer must have the real tenant id),
  anonymous access to `/login.html` + static assets, `authenticated` required elsewhere,
  401/403 → redirect to `/login.html`, SPA navigation fallback to `/index.html`.

## Gotchas / decisions
- **ID collision fixed:** the Cost Per Yard "Edit rates" panel already uses
  `id="admin-panel"`. The admin console therefore uses an `adm-*` prefix
  (`adm-panel`, `adm-user-detail`, `adm-user-count`, ...). Don't reintroduce `admin-*` ids
  in the new section.
- Photos/signatures stored inline (compressed) in record blobs; under Cosmos' 2 MB item
  limit. Move to Blob Storage only if volume demands.
- Sync is last-write-wins per (user, type) — fine for one-phone-per-foreman.
- Local UI preview (no Node): `dev/static-server.ps1` mocks `/api/*` as an admin. Dev only.
- Real local full-stack test: SWA CLI `swa start public --api-location api`.

# EBCC Field Assistant — Project Summary

**What:** Rebuild of the EBCC Field Assistant prototype into a real, login-gated,
multi-user PWA with an admin console. Foremen use it on their phones; Travis (admin)
manages users and reviews their inputs.

**Where:** `Code\Field Assistant\` (this project). The original prototype is at
`CoWork\Projects\EBCC Field Assistant\field-assistant-deploy\index.html` and is the
read-only source of truth — **never edited**.

## The 7 tabs (ported verbatim — same flow, same formulas)
1. **Cost Per Yard** — equipment search, qty/round-time → cost/yard, daily totals, job projection. CA/TX state switch.
2. **Flat Work** — crew production (sq ft/day) → cost per sq ft.
3. **Lime Trucks** — area + spec rate → tons, trucks (round at 5-ton threshold), coverage.
4. **Flex Base** — area + depth → cubic yards × 1.8 compaction → trucks.
5. **Extra Work Ticket** — form + signature pad → PDF/email.
6. **Truck Tickets** — photo/camera → Claude vision OCR → structured review → batch PDF.
7. **Load Count** — truck cards, tap-in/out timestamps, daily summary PDF.

Key constants preserved: `SQFT_PER_SQYD=9`, `LIME_TRUCK_LBS=20000`,
`FLEXBASE_TONS_PER_CY=1.8`, `TRUCK_COUNT_TYPES`, CA/TX equipment libraries,
`STATE_EQUIVALENTS`, `EWT_SAVED_CONTACTS`. Verified in preview: Lime (50000/33 → 91.7t,
9 trucks) and Flex Base (50000/6/22 → 1666.7t, 76 trucks) match exactly.

## What changed from the prototype
- **Login gate:** Microsoft/Entra sign-in via Azure Static Web Apps. Only earthbasics.net.
- **Backend:** Azure Functions + Cosmos DB. Per-user record isolation enforced server-side.
- **Admin console (Travis only):** Manage Users tab — roles (admin/user/disabled), record
  counts, last-active, and read-only review of any user's records.
- **Aesthetics:** switched to self-hosted **Inter** font; header logo lockup; light polish.
  Orange accent, dark header, layout otherwise unchanged.
- **PWA:** manifest + service worker + icons; installable, offline-capable.
- **OCR** moved from Netlify function to `api/ocr-truck-ticket` (same prompt/logic).

## Synced vs local
- **Synced per user:** Truck Tickets (`ebcc_trucking_tickets_v1`), Load Count
  (`ebcc_load_count_v1`), Extra Work Tickets (`ebcc_ewt_records_v1`, captured on
  preview/email). Server type keys: `trucking_tickets`, `load_count`, `ewt_records`.
- **Local only:** the four calculators (Cost Per Yard, Flat Work, Lime, Flex Base).

## Status
Frontend + backend written and UI-verified against a mock admin. **Not yet deployed** —
waiting on IT to provision Azure per `SETUP-AZURE.md`. See `architecture.md` for internals.

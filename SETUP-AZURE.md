# Azure Setup — EBCC Field Assistant (for IT / admin)

This app runs on **Azure Static Web Apps** (hosting + login) with a **Cosmos DB** for
data. Everything below is a one-time setup. Estimated cost: **$0/month** on free tiers
for a small team (Cosmos free tier + SWA free plan); only the Anthropic OCR usage bills
(~$6/mo at 1,000 tickets).

You'll need: an Azure subscription, permission to create resources, and permission to
register an Entra (Azure AD) application in the `earthbasics.net` tenant.

---

## 1. Resource group
Azure Portal → **Resource groups** → **Create** → name `rg-ebcc-field-assistant`, pick a
region (e.g. West US 2) → Review + create.

## 2. Cosmos DB (records database)
1. Create a resource → **Azure Cosmos DB** → **Azure Cosmos DB for NoSQL** → Create.
2. Resource group = the one above; Account name = `ebcc-field-assistant`; region same as above.
3. **Apply Free Tier Discount = Apply** (first free-tier account per subscription).
4. Review + create. (Containers are created automatically by the app — no need to add them.)
5. After it deploys → **Keys** → copy the **PRIMARY CONNECTION STRING**. Save for step 5.

## 3. Static Web App (hosting + login)
1. Create a resource → **Static Web App** → Create.
2. Resource group = same; Name = `ebcc-field-assistant`; **Plan = Free**.
3. Deployment: choose **GitHub** (recommended) and point it at this project's repo, or
   choose **Other** to deploy manually with the SWA CLI later.
   - Build settings: **App location** = `public`, **Api location** = `api`, **Output
     location** = *(leave blank)*.
4. Create. Note the app URL, e.g. `https://ebcc-field-assistant.azurestaticapps.net`.

## 4. Entra (Azure AD) app registration — enables Microsoft sign-in
1. Entra ID → **App registrations** → **New registration**.
2. Name = `EBCC Field Assistant`; Supported accounts = **Accounts in this organizational
   directory only (earthbasics.net)** — this is what locks sign-in to your company.
3. Redirect URI → platform **Web** →
   `https://<your-swa-hostname>/.auth/login/aad/callback`.
4. Register. From **Overview**, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
5. **Certificates & secrets** → **New client secret** → copy the secret **Value** (shown once).

## 5. Static Web App → configuration (app settings)
SWA → your app → **Settings → Configuration** → **Application settings**, add:

| Name | Value |
|---|---|
| `AAD_CLIENT_ID` | Application (client) ID from step 4 |
| `AAD_CLIENT_SECRET` | client secret Value from step 4 |
| `COSMOS_CONN` | Cosmos primary connection string from step 2 |
| `ANTHROPIC_API_KEY` | the Anthropic API key (for Truck Ticket OCR) |
| `ADMIN_EMAILS` | `travis@earthbasics.net` (comma-separate to add more admins) |
| `OCR_MODEL` | *(optional)* defaults to `claude-sonnet-4-6` |

Save.

## 6. Wire the tenant into the app config
Edit `staticwebapp.config.json` in this project — replace `REPLACE_WITH_TENANT_ID` in the
`openIdIssuer` line with the **Directory (tenant) ID** from step 4, then redeploy:
```
"openIdIssuer": "https://login.microsoftonline.com/<TENANT_ID>/v2.0"
```

## 7. Deploy
- If you connected GitHub in step 3, the included GitHub Action deploys on every push.
- Otherwise: `npm i -g @azure/static-web-apps-cli` then
  `swa deploy public --api-location api --deployment-token <token>`
  (token from SWA → **Manage deployment token**).

---

## Verify it works
1. Open the app URL in a private window → you should be sent to the branded **Sign in with
   Microsoft** screen.
2. Sign in as `travis@earthbasics.net` → the app loads and a **Manage Users** tab appears.
3. Have another employee sign in → they see the app **without** Manage Users, and only
   their own tickets/counts.
4. Back as Travis → Manage Users lists everyone, their record counts, and last-active; open
   a user to review their records; set a user to **disabled** to block access.

## Enable direct EWT emailing (one-time, IT)
The app emails Extra Work Tickets (with the PDF attached) from the signed-in
user's own EBCC mailbox via Microsoft Graph. To turn it on:
1. Entra ID → App registrations → **EBCC Field Assistant** → **API permissions**
2. **Add a permission** → **Microsoft Graph** → **Application permissions** → search
   **Mail.Send** → add it
3. Click **Grant admin consent for Earth Basics**
Until consent is granted, the app automatically falls back to the device share
sheet (PDF attached, recipients added by hand). Optional hardening: restrict
which mailboxes the app can send as with an Exchange **ApplicationAccessPolicy**.

## Day-to-day admin (Travis, no Azure needed)
Use the in-app **Manage Users** tab: change anyone between **admin / user / disabled** and
review each person's Truck Tickets, Load Counts, and Extra Work Tickets. New employees
appear automatically the first time they sign in (as a normal `user`).

# integrations/hubspot-app

The HubSpot app definition for Lycert's CRM connector, built on HubSpot's Projects platform and deployed
with the HubSpot CLI. All runtime logic lives in the web app (`apps/web/lib/crm/` and
`apps/web/app/api/crm/`). This folder holds only what HubSpot needs to register the app.

```
hsproject.json                              project name + platform version
src/app/app-hsmeta.json                     app: privately distributed OAuth, redirect URL, scopes
src/app/webhooks/webhooks-hsmeta.json       webhook target URL + subscriptions
```

**Scopes requested:** contacts read/write, contact schemas read/write (to create the Lycert property group),
and `automation` for the custom workflow actions planned in milestone M4. Nothing else.

**Webhook subscriptions:** contact creation, property changes on the mapped fields, deletion, and merge.
Deliveries are verified with HubSpot's v3 signature over the exact configured target URL, then enqueued.
They are never processed inside the request.

URLs in this copy are placeholders. Each environment uses its own app and credentials.

```bash
hs project upload    # build + deploy the app definition
```

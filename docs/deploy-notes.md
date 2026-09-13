# Deploy notes

## Cloudflare Access

Zero Trust is not set up yet: no team, no login methods, and no Access application. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `env.production.vars` (`wrangler.jsonc`) are still placeholders (`https://TEAM.cloudflareaccess.com` and `AUD_TAG_FROM_DEPLOY_NOTES`) pending Dimitris setting up Zero Trust and the Access application for `clip-admin.dimitrismitsis.com`. Until then, the admin door fails closed (401 `{"error":"Owner sign-in required"}`) for everyone. Update these two values and redeploy once Access is configured.

## Production (deployed in Task 13, 2026-09-13)

- Worker: live-clipboard (env.production), custom domains clip.dimitrismitsis.com and clip-admin.dimitrismitsis.com
- R2 bucket: live-clipboard-files
- D1 database: live-clipboard, database_id 14f45d61-61f9-453a-9cd2-fa9daa07f580
- Probe Worker clip-probe: never deployed (Ruling R7)
- Manual production check: pending (needs Access)
- Room agna-2026: not created yet (needs Access)
- Automated smoke check (2026-09-13):
  - `GET https://clip.dimitrismitsis.com/` → 200, body "Open the room link shown on screen.", `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss://clip.dimitrismitsis.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  - `GET https://clip.dimitrismitsis.com/r/agna-2026` → 200, join form rendered (no room exists yet)
  - `GET https://clip-admin.dimitrismitsis.com/` → 401, body `{"error":"Owner sign-in required"}`
  - `GET https://clip.dimitrismitsis.com/api/rooms` → 404, body `{"error":"Not found"}`

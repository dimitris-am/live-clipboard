# Deploy notes

## Cloudflare Access

- ACCESS_TEAM_DOMAIN: https://cheapy.cloudflareaccess.com
- ACCESS_AUD: d29190a14b34ae309ae1240905a93f9e3ee14671a487b2deea7ffef59a6465d0
- Access application on clip-admin.dimitrismitsis.com, created by Dimitris 2026-09-13 (self-hosted, policy Owners → mitsosmitsis@gmail.com, login method One-time PIN)
- Verified 2026-09-13: team certs endpoint returns 2 RS256 keys; clip-admin redirects to cheapy.cloudflareaccess.com

## Production (deployed in Task 13, 2026-09-13)

- Worker: live-clipboard (env.production), custom domains clip.dimitrismitsis.com and clip-admin.dimitrismitsis.com
- R2 bucket: live-clipboard-files
- D1 database: live-clipboard, database_id 14f45d61-61f9-453a-9cd2-fa9daa07f580
- Probe Worker clip-probe: never deployed (Ruling R7)
- Deployed version b5552c1c-6fad-4dba-9f14-9bc808110a0f, 2026-09-13 (Cloudflare Access values configured)
- Manual production check: pending (needs Access)
- Room agna-2026: not created yet (needs Access)
- Automated smoke check (2026-09-13):
  - `GET https://clip.dimitrismitsis.com/` → 200, body "Open the room link shown on screen.", `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss://clip.dimitrismitsis.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  - `GET https://clip.dimitrismitsis.com/r/agna-2026` → 200, join form rendered (no room exists yet)
  - `GET https://clip-admin.dimitrismitsis.com/` → 401, body `{"error":"Owner sign-in required"}`
  - `GET https://clip.dimitrismitsis.com/api/rooms` → 404, body `{"error":"Not found"}`

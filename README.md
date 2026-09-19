# Live Clipboard

A live shared clipboard for courses and talks. Participants join a room on `clip.dimitrismitsis.com` with a PIN and their name. Owners run rooms on `clip-admin.dimitrismitsis.com`, behind Cloudflare Access (email one-time PIN). Text, links and files appear for everyone in real time, and anyone in the room can download the whole room as one Markdown file.

Design: `docs/superpowers/specs/2026-09-13-live-clipboard-design.md` · Plan: `docs/superpowers/plans/2026-09-13-live-clipboard.md` · Cloudflare values: `docs/deploy-notes.md`

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply live-clipboard --local
npm run dev
```

- Admin door: http://127.0.0.1:8787/ (you are the owner named by `DEV_OWNER_EMAIL`)
- Public door: http://localhost:8787/<slug>

The Worker decides who you are **by hostname**, so use the two hostnames exactly as shown.

Rooms live at the root of each host (`/<slug>`), so `api` and `assets` are reserved and can never be used as room names.

## Tests

```bash
npm test
npm run typecheck
```

## Deploy

```bash
npm run deploy   # wrangler deploy --env production
```

The production configuration is `env.production` in `wrangler.jsonc`, and the top level is for local development and tests. **Never add `routes` at the top level**: when routes exist, `wrangler dev` rewrites every request's host to the route's domain, and the two doors stop working locally.

## One-time Cloudflare setup

1. **Zero Trust:** enable the One-time PIN login method.
2. **Access application:** self-hosted, "Live Clipboard admin", on `clip-admin.dimitrismitsis.com` (no path), session 1 week, policy "Owners": Allow, Emails = the owner addresses.
3. **Copy the Access values:** put the team domain and the application's AUD tag into `env.production.vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`).
4. **Storage:** `npx wrangler r2 bucket create live-clipboard-files`, then `npx wrangler d1 create live-clipboard`, and put its `database_id` into both D1 blocks.
5. **Migrate:** `npx wrangler d1 migrations apply live-clipboard --remote --env production`
6. **Deploy:** `npm run deploy`

Only owners sign in through Access, so participants never take Zero Trust seats.

## Adding an owner

1. Add the email to the "Owners" policy of the "Live Clipboard admin" Access application.
2. Add `"email": "Display name"` to `OWNERS` in `env.production.vars`, then `npm run deploy`.

Both lists must match. The Worker checks `OWNERS` even after Access lets someone through.

## Before a course or talk

- **Room:** create it on the admin page and choose a PIN, so it can go on a slide in advance. Put the public link and the PIN on the slide.
- **Pins:** post and pin the first links, such as the practice repository.
- **Fallback:** keep a HackMD note with editing open to everyone, in case the venue network or the service fails.
- **WAF:** Check the WAF join rate-limit rule is enabled.

## During

- **Who is here:** on the owner board, click **N online** in the header. It lists everyone who joined with the current PIN, connected people first; owners only.
- **Leaked PIN:** if the PIN leaks (someone photographs the slide), use **Change PIN**. Everyone is signed out and rejoins with the new PIN.
- **Download:** everyone in the room gets a **Download** link in the header, which saves the room as one Markdown file: text posts as written, files as links, times in the reader's own timezone. File links only work while the reader is still joined.
- **Projecting:** use browser zoom.

## After

- **Archive** the room: it becomes read-only, and participants who still know the PIN can keep copying and downloading from it.
- **Delete** it when it is no longer needed. That removes every post and file. If file cleanup fails, the admin page shows "Deletion incomplete" with **Retry deletion**.

## Manual check after each deploy

1. **Owner sign-in:** open the admin door in a private window. Access asks for an email, and the emailed PIN signs you in.
2. **Join:** create a test room. Join it on a phone and on a laptop with different names.
3. **Posting:** post text containing a link, copy it, paste a screenshot on the laptop, attach a photo on the phone, and download a file.
4. **Owner controls:** pin a post from the owner board, then archive and unarchive the room.
5. **Download:** click **Download** on both the phone and the owner board, and open each file. Both hold every post, and a file link in the phone's copy still downloads.
6. **Change PIN:** the phone returns to the join form.
7. **Reconnect:** toggle Wi-Fi on the laptop. The board shows "Reconnecting…", then "Live".
8. **Clean up:** delete the test room.

# Live Clipboard — Design

**Date:** 2026-09-13 · **Owner:** Dimitris Mitsis · **Status:** approved in brainstorming, awaiting spec review

## 1. Purpose

A live shared clipboard for courses and talks. Each course or talk gets its own **room**, and everyone in the room sees new posts appear in real time. People drop text, commands, links and files. Owners run rooms from an admin page and sign in with Cloudflare Access (email one-time PIN). Participants join with a room PIN shown on screen during the session, plus a name they type.

First use: the AGNA Claude Code course, 17–18 September 2026, room `agna-2026`.

## 2. Decisions made in brainstorming

| Topic | Decision |
|---|---|
| Build or buy | Build. The closest hosted tools are shared documents anyone can overwrite, or boards that handle commands poorly. None of them combines owner email sign-in, per-room PINs, exact-copy commands, and files. A HackMD note with editing open to everyone is the day-of fallback. |
| Lifespan | Reusable: many rooms, one deployment. |
| Content | Text (including commands), links, and any file up to 25 MB. |
| Permissions | Everyone in a room posts. Participants delete only their own posts. Owners delete anything and pin. |
| Retention | Owner archives by hand. Archived rooms are read-only but still open. Owner deletes when they choose. |
| Address | `clip.dimitrismitsis.com` for participants, `clip-admin.dimitrismitsis.com` for owners. The domain is already on Cloudflare. |
| Owner identity | Cloudflare Access, one-time PIN by email, policy limited to owner emails. |
| Participant identity | Room PIN plus a typed display name. A server-side session lasts 7 days. |
| PIN lifecycle | The owner sets it (or generates it) when creating the room. Changing it signs every participant out. |

## 3. Architecture

```
participants ─► clip.dimitrismitsis.com ─────────────┐   (no Access)
owners ───────► Cloudflare Access ─► clip-admin.dimitrismitsis.com ─┤
                (email one-time PIN)                                │
                                                                    ▼
                                            Worker (TypeScript)
                                              ├─ routes by hostname; any other host → 404
                                              ├─ admin host: verifies Access token + OWNERS
                                              ├─ public host: verifies room session cookie
                                              ├─ serves page shells from static assets
                                              ├─► Room Durable Object (one per room, idFromName(slug))
                                              │     ├─ SQLite: settings, posts, sessions, rate counters
                                              │     └─ hibernating WebSockets
                                              ├─► R2 bucket: files at rooms/<slug>/<postId>/<name>
                                              └─► D1: room index (slug, created_at)
```

Principles:

1. **Two doors, one set of rooms.** Both hostnames reach the same Worker and the same Room objects. The hostname decides how a request proves identity: an Access token on the admin host, a session cookie on the public host. The public host never reads Access headers, so a forged one does nothing there.
2. **The room is the authority.** Settings, sessions, posts and rate counters live in the Room object's SQLite. Permission checks and writes happen in the same place, so changing the PIN or archiving takes effect at once.
3. **Changes go over HTTP; WebSockets only push.** Creating, deleting and pinning are plain HTTP requests with status codes. The socket carries server-to-client events only. Every connect, including reconnects, starts with a full snapshot.
4. **No bypass.** `workers_dev` and preview URLs are off. The Worker still verifies every admin request itself, as if Access were not there.
5. **The D1 index is only a list.** It exists so the admin page can enumerate rooms. Everything else about a room comes from its Room object.
6. **The Worker picks every page.** Static assets run with `"run_worker_first": true`, because both hosts share one asset directory but need different pages at the same path. The Worker maps `/` to `home.html` on the public host and `admin.html` on the admin host, and `/r/:slug` to `board.html` on both. It serves shared JS and CSS files to both hosts and returns 404 for any other HTML file requested directly.

## 4. Identity and sessions

### 4.1 Owners (admin host)

- A Cloudflare Access **self-hosted application** covers all of `clip-admin.dimitrismitsis.com`. The login method is one-time PIN, and the policy is Allow → Emails → the owner emails. The session lasts one week.
- On every request, the Worker verifies the `Cf-Access-Jwt-Assertion` header with `jose`:
  - the signature, against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
  - `aud` equals `ACCESS_AUD`
  - `iss` equals `ACCESS_TEAM_DOMAIN`
  - the token has not expired
- The `email` claim is lowercased and must be a key in `OWNERS`, e.g. `{"mitsosmitsis@gmail.com": "Dimitris"}`. Its value is the owner's display name.
- Every owner owns every room.
- The Access policy and `OWNERS` must list the same emails. The Worker check is defense in depth.

### 4.2 Participants (public host)

- **Join:** `POST /r/:slug/api/join` with `{pin, name}`.
  - `name` is trimmed, 1–40 characters, and may duplicate another participant's name.
  - The PIN is compared in constant time against the room's PIN.
  - An unknown room and a wrong PIN return the same `403 {"error":"Room or PIN not recognized"}`.
- **Session:** a random 128-bit ID, hex-encoded, stored in the room's `sessions` table with `name`, `pin_version`, `created_at` and `expires_at` (7 days after joining, not sliding).
- **Cookie:** `clip_session=<id>; Path=/r/<slug>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`.
  - The path keeps sessions per room. Under RFC 6265 path matching, `/r/agna` does not match `/r/agna-2026`.
- **Validity:** a session is valid when it exists, has not expired, and its `pin_version` equals the room's current `pin_version`. Expired sessions are purged whenever someone joins.
- **Leave:** `POST /r/:slug/api/leave` deletes the session and clears the cookie.

### 4.3 PIN rules

- 6–12 characters, letters and digits only, compared case-sensitively.
- The admin page offers **Generate**, which fills in 6 random digits (from `crypto.getRandomValues`).
- Stored as plain text in the Room object, so the admin page can show it back to the owner. Hashing a PIN this short adds no protection.
- **Changing the PIN** increments `pin_version`, deletes all sessions, and closes every participant socket with code `4401`. Owner sockets stay open.
- **Guessing limit:** 20 failed joins per IP (`CF-Connecting-IP`) per room in a rolling 10 minutes. Past that, joins return `429 {"error":"Too many attempts","retryAfter":<seconds>}`. The limit is generous because a whole class shares one venue IP.

### 4.4 Local development

`wrangler dev` serves both doors by treating `localhost:8787` as the public host and `127.0.0.1:8787` as the admin host. Browsers keep their cookies separate.

Those two hosts are the top-level `PUBLIC_HOST` and `ADMIN_HOST` vars in `wrangler.jsonc`. Production hosts and routes live in `env.production`. Verified 2026-09-13: whenever `routes` are configured, `wrangler dev` rewrites every request's host to the route's domain, so the top level must carry no routes. On the admin host, `DEV_OWNER_EMAIL` stands in for the Access token **only** when `ENVIRONMENT` is `development` **and** the request host is `127.0.0.1:8787`. Production config never sets either variable.

## 5. Data model

### 5.1 Room object SQLite

```sql
CREATE TABLE room (            -- exactly one row
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  pin TEXT NOT NULL,
  pin_version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  bytes_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,         -- time-sortable (ULID)
  kind TEXT NOT NULL,          -- 'text' | 'file'
  text TEXT,                   -- kind = 'text'
  file_name TEXT,              -- kind = 'file'
  file_size INTEGER,
  file_type TEXT,              -- type declared at upload, used for display and image check
  r2_key TEXT,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,   -- 'participant' | 'owner'
  author_session TEXT,         -- participant posts only; never sent to clients
  author_email TEXT,           -- owner posts only; never sent to clients
  created_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE rate_events (     -- join failures and post counts
  bucket TEXT NOT NULL,        -- 'join:<ip>' | 'post:<session id or owner email>'
  at INTEGER NOT NULL
);
CREATE INDEX rate_events_bucket_at ON rate_events (bucket, at);
```

Rows in `rate_events` older than 10 minutes are deleted whenever the table is written.

### 5.2 D1

```sql
CREATE TABLE rooms (slug TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
```

### 5.3 Limits

| Limit | Value |
|---|---|
| Text post | 1–20,000 characters, not whitespace-only |
| File | 1 byte – 25 MB, rejected by `Content-Length` before streaming |
| Files per room | 2 GB total (`bytes_used`) |
| Posts and uploads | 30 per minute per session (participants) or per email (owners) |
| Slug | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`, fixed once the room is created |
| Title | 1–80 characters |

## 6. HTTP API

All `/r/:slug/api/*` routes exist on both hosts. The actor is an **owner** on the admin host and a **participant** (session cookie) on the public host. Every non-GET request and every WebSocket upgrade must carry `Origin: https://<request host>` (or the `http://` dev origin); otherwise `403`.

| Method and path | Host | Who | Result |
|---|---|---|---|
| `GET /` | public | anyone | Static page: "Open the room link shown on screen." |
| `GET /` | admin | owner | Admin page shell |
| `GET /r/:slug` | public | anyone | Board shell. JS calls `/api/me` to choose between join form and board. |
| `GET /r/:slug` | admin | owner | Same board shell; `/api/me` returns the owner role. |
| `GET /r/:slug/api/me` | both | actor | `200 {name, role}` or `401` |
| `POST /r/:slug/api/join` | public | anyone | §4.2 |
| `POST /r/:slug/api/leave` | public | participant | `204` |
| `GET /r/:slug/api/live` | both | actor | WebSocket (§7) |
| `POST /r/:slug/api/posts` | both | actor; room not archived | `{text}` → `201 {id}` |
| `POST /r/:slug/api/files` | both | actor; room not archived | Raw body; headers `X-File-Name` (URI-encoded), `Content-Type`, `Content-Length` → `201 {id}` |
| `GET /r/:slug/files/:postId` | both | actor | File stream (§9) |
| `DELETE /r/:slug/api/posts/:id` | both | post author (same session) or owner | `204`. Owners may delete in archived rooms; participants may not. |
| `POST /r/:slug/api/posts/:id/pin` | admin | owner | `{pinned}` → `204` |
| `GET /api/rooms` | admin | owner | `[{slug, title, pin, archived, postCount, participantCount, bytesUsed, createdAt}]` |
| `POST /api/rooms` | admin | owner | `{slug, title, pin}` → `201`. `409` if the slug exists. |
| `PATCH /api/rooms/:slug` | admin | owner | `{title?, archived?}` → `204` |
| `PUT /api/rooms/:slug/pin` | admin | owner | `{pin}` → `204` (§4.3) |
| `DELETE /api/rooms/:slug` | admin | owner | `{confirm: "<slug>"}` → `204` |

`participantCount` is the number of valid sessions.

**Upload sequence:**
1. The Worker asks the room `authorizeUpload(actor, size)`, which checks session, archived, rate limit and room quota, and returns `{postId, r2Key}`.
2. The Worker streams the body to R2.
3. The Worker calls `commitFile(actor, postId, meta)`. The room inserts the post, adds to `bytes_used`, and broadcasts.
4. If step 3 fails, for example because the room was archived or the PIN changed mid-upload, the Worker deletes the R2 object and returns the room's error.

**Room creation:** insert the D1 row, then initialize the Room object. If initialization fails, delete the D1 row.

**Room deletion:**
1. The room closes all sockets with `4404` and runs `ctx.storage.deleteAll()`.
2. The Worker lists and deletes `rooms/<slug>/` in R2, 1,000 keys per call.
3. The Worker deletes the D1 row.

If R2 cleanup fails, the D1 row stays and the admin page shows the room as "deletion incomplete" with a Retry button. Retry repeats steps 2–3.

## 7. Live protocol

Server-to-client JSON messages over `/r/:slug/api/live`:

```jsonc
{ "type": "snapshot", "room": {"slug", "title", "archived"}, "you": {"name", "role"}, "online": 12, "posts": [Post] }
{ "type": "post.added", "post": Post }
{ "type": "post.deleted", "id": "..." }
{ "type": "post.pinned", "id": "...", "pinned": true, "pinnedAt": 1757750400000 }
{ "type": "room.updated", "room": {"title", "archived"} }
{ "type": "online", "count": 13 }
```

`Post` on the wire:

```jsonc
{ "id", "kind", "text"?, "file"?: {"name", "size", "type", "url"}, "authorName", "authorRole", "createdAt", "pinned", "pinnedAt", "mine" }
```

- `mine` is computed **per socket**: the socket's attachment holds its session ID or owner email, and the room compares it with the post's author. Session IDs and emails never leave the server.
- `online` counts open sockets, owners included. It is broadcast when a socket opens or closes.
- **Close codes:** `4401` session ended (PIN changed, left, or expired) → client shows the join form. `4404` room deleted → client shows "This room no longer exists."
- The server accepts no client messages. Anything received is ignored.

## 8. Screens

Plain HTML, CSS and JavaScript from static assets. No framework, no build step beyond Wrangler. Light and dark follow the system setting. Single column, usable at 400px width.

### 8.1 Join (public board URL, no valid session)

Room PIN field (plain text input with autocapitalize, autocorrect and spellcheck off, because PINs may contain letters), name field, **Join** button. The page cannot offer a numeric keyboard for all-digit PINs, since telling it which kind of PIN a room uses would also reveal that the room exists. Errors appear inline: "Room or PIN not recognized", "Too many attempts, try again in N minutes." Unknown slugs show this same form, so the page reveals nothing about which rooms exist.

### 8.2 Board

```
┌───────────────────────────────────────────────────────┐
│ Claude Code at AGNA            ● 12 online   Kristi ▾ │
├───────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────┐ │
│ │ Paste, type, or drop a file…                      │ │
│ │                                     [Post  ⌘↵]    │ │
│ └───────────────────────────────────────────────────┘ │
│ PINNED                                                │
│ │ https://github.com/dimitris-am/agna-starter  [Copy] │
│                                                       │
│ Dimitris (owner) · 2 min ago          [Copy] [Unpin]  │
│ │ claude --model sonnet --effort high                 │
│                                                       │
│ Kristi · 5 min ago                          [Delete]  │
│ │ 📎 error.png · 240 KB   [thumbnail]    [Download]   │
└───────────────────────────────────────────────────────┘
```

- **Composer:**
  - Enter inserts a newline; ⌘/Ctrl+Enter posts.
  - If a post fails, the text stays in the composer and a toast shows the error.
- **Paste and drop:**
  - Pasting while focus is outside the composer puts text into the composer.
  - Pasting a file or image anywhere uploads it at once.
  - Dropping files on the page uploads them.
  - Each upload shows a progress row. A failed row offers Retry.
- **Order:** pinned strip first (by `pinnedAt`), then the feed, newest first.
- **Text posts:**
  - Monospace, whitespace preserved.
  - `http(s)` URLs become links (`target="_blank" rel="noopener noreferrer"`).
  - Built with DOM nodes and `textContent`, never `innerHTML`.
  - Every text post has **Copy**, which copies the exact stored text.
- **File posts:** name and size. png, jpeg, gif and webp show a thumbnail that opens full size. Every file has **Download**.
- **Author line:** display name, an **owner** badge on owner posts, relative time. **Delete** shows when `mine` is true or the viewer is an owner. **Pin** and **Unpin** show to owners only.
- **Live cues:**
  - New posts highlight briefly.
  - The header shows the online count.
  - The name menu offers **Leave** (participants only).
- **Archived:** a read-only banner. The composer, paste upload and drop upload are disabled for participants. Owners see the banner but keep Delete, Pin and Unpin.
- **Connection:**
  - A status dot. "Reconnecting…" while the socket retries with backoff (1 s doubling to 30 s, with jitter).
  - A browser cannot see why a WebSocket upgrade failed, so after two failed reconnects the page fetches `/r/:slug/api/me` with `redirect: "manual"`:
    - On the public host, a `401` means the session ended, and the page shows the join form.
    - On the admin host, an opaque redirect means the Access session expired, and the page shows "Session expired — sign in again" with a reload button.
    - A `200` means the network is the problem, and reconnecting continues.
- **Owner view:** the same board at `clip-admin.dimitrismitsis.com/r/<slug>`.
- **Projection:** browser zoom. No separate projector mode.

### 8.3 Admin (`clip-admin.dimitrismitsis.com/`)

- **Rooms table:** title, slug, public link with a copy button, owner board link, PIN (shown) with **Change PIN**, participants, posts, storage used, archived, created.
- **Create room form:** slug, title, PIN with **Generate**.
- **Room actions:**
  - **Rename**
  - **Archive** / **Unarchive**
  - **Change PIN**, with a confirmation that says everyone will be signed out
  - **Delete**, which requires typing the slug
- A room whose deletion did not finish shows **Retry deletion**.

## 9. Security

- **Host routing:** requests whose host is neither `PUBLIC_HOST` nor `ADMIN_HOST` return 404.
- **Owner authentication:** §4.1 on every admin-host request, including static-shell requests routed through the Worker and WebSocket upgrades.
- **Participant authentication:** §4.2 session lookup on every public-host `/r/:slug/api/*` and `/r/:slug/files/*` request.
- **Cross-site requests:** `SameSite=Lax` cookies plus the `Origin` check on every non-GET request and WebSocket upgrade (§6).
- **Content Security Policy** on all HTML: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
- **Rendering:** posts are text only. No Markdown or HTML. Links are limited to `http:` and `https:` schemes.
- **Downloads:**
  - `X-Content-Type-Options: nosniff` on every response.
  - `image/png`, `image/jpeg`, `image/gif` and `image/webp` are served inline with that type.
  - Every other file is served as `application/octet-stream` with `Content-Disposition: attachment; filename*=UTF-8''<encoded name>`. SVG and HTML are included, so an uploaded file never runs on the clipboard's origin.
- **File names:** control characters, path separators and leading dots are stripped. Names are capped at 120 characters and fall back to `file` when nothing is left.
- **Rate limits:** §4.3 (joins) and §5.3 (posts).
- **Impersonation:** names are self-chosen. The owner badge comes only from the admin host.
- **Leaked PIN** (e.g. a photo of the slide): Change PIN.

## 10. Errors

| Status | Meaning | Client behavior |
|---|---|---|
| 400 | Validation failed | Inline or toast with the server's message |
| 401 | No valid session or token | Public host: join form. Admin host: session-expired prompt. |
| 403 | Wrong PIN, not the author, or bad `Origin` | Toast (join form shows inline) |
| 404 | Post or room gone | Toast; remove the post locally if present |
| 409 | Room archived, or slug already exists | Toast; the archived banner arrives via `room.updated` |
| 413 | File over 25 MB or room quota reached | Upload row shows the limit |
| 429 | Rate limited | Toast with the wait time |

Error bodies are `{"error": "<human-readable message>"}`.

## 11. Testing

Vitest with `@cloudflare/vitest-pool-workers`, which runs the Worker, Room objects, R2 and D1 locally.

**Unit tests**
- Slug, title, PIN, name and text validation
- File name sanitizing
- Download headers per file type (inline images; attachment for SVG, HTML and everything else)
- Access token verification: valid; wrong `aud`; wrong `iss`; expired; bad signature; email not in `OWNERS`. Test tokens are signed with a generated key and served from a stubbed JWKS.
- Rate-limit windows

**Integration tests**
- Join with the right PIN sets a cookie scoped to `/r/<slug>`. A wrong PIN and an unknown room return the identical 403.
- The 21st failed join from one IP within 10 minutes returns 429. A different IP is unaffected.
- Two participant sockets: a post from one arrives at the other with the right `mine` flag on each.
- A participant deleting someone else's post gets 403. An owner deleting it gets 204, and both sockets receive `post.deleted`.
- Archiving: participant posts return 409; `room.updated` is broadcast; an owner can still delete and pin.
- Change PIN: old cookies return 401, participant sockets close with 4401, owner sockets stay open.
- The public host ignores a forged `Cf-Access-Jwt-Assertion` header. The admin host rejects requests without a valid token.
- A request with a foreign `Origin` returns 403 for POST and for WebSocket upgrades.
- Upload: file stored and post broadcast. If commit fails after R2 storage, the R2 object is gone.
- Quota: an upload past 2 GB of room storage returns 413.
- Delete room: sockets close with 4404, R2 prefix empty, D1 row gone, the slug can be created again.

**Manual check after deploy** (checklist in the README)
- Owner sign-in by email one-time PIN on the admin host.
- Participant join on a phone and on a laptop.
- Text post with a link, copy, screenshot paste, file download, pin, archive and unarchive.
- Change PIN signs the phone out.
- Reconnect after toggling Wi-Fi.

## 12. Deployment and setup

1. **Probe first**, before any feature work. Deploy a throwaway Worker on `clip-admin.dimitrismitsis.com` behind the Access self-hosted application. It should serve a page that opens a WebSocket echo and prints the `Cf-Access-Jwt-Assertion` it received on the upgrade. Confirm from a browser after signing in, then replace the probe with the real Worker. If WebSockets fail through Access, stop and revisit the owner board. The fallback is to add `GET /r/:slug/api/snapshot` on the admin host, returning the snapshot message's payload, and have the owner board poll it every 3 seconds.
2. **Resources:** R2 bucket `live-clipboard-files`, D1 database `live-clipboard`, Durable Object migration with `new_sqlite_classes: ["Room"]`.
3. **`wrangler.jsonc`:**
   - Custom domains `clip.dimitrismitsis.com` and `clip-admin.dimitrismitsis.com`, in `env.production`; deploy with `wrangler deploy --env production` (§4.4)
   - `"workers_dev": false`, `"preview_urls": false`
   - Bindings `ROOMS` (Durable Object), `FILES` (R2), `DB` (D1), `ASSETS` (static assets)
4. **Zero Trust:**
   - Use the existing team, or create one.
   - Enable the one-time PIN login method (not on by default for new accounts).
   - Create a self-hosted application for `clip-admin.dimitrismitsis.com`, all paths, session one week.
   - Policy: Allow → Emails → owner emails.
   - Copy the application's AUD tag.
5. **Variables:** `PUBLIC_HOST`, `ADMIN_HOST`, `OWNERS` (JSON), `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`), `ACCESS_AUD`.
6. **Manual check** (§11).

Cost: all within free tiers (Workers, SQLite-backed Durable Objects, D1, R2 10 GB). Only owners take Zero Trust seats.

## 13. Out of scope

- Link previews (would fetch outside pages)
- Editing posts (delete and repost)
- Captions on files
- Markdown
- Search
- Removing one participant (Change PIN is the kill switch)
- A projector join card or QR codes (the PIN goes on the presenter's slide)
- A home page that lists rooms
- Per-room owners
- Offline support

## 14. Risks and assumptions to verify

| Item | Status | Handled by |
|---|---|---|
| WebSockets work through an Access self-hosted application (the per-Worker Access toggle does not support them) | Documented by Cloudflare, untested here | §12 step 1 probe; polling fallback |
| Access session duration offers "1 week" | Believed, unverified | Check in step 4; otherwise nearest option |
| R2 may require a payment method on file even on the free tier | Unverified | Check in step 2 |
| SQLite-backed Durable Objects are available on the Workers free plan | Believed, unverified | Check in step 2; Workers Paid ($5/month) otherwise |
| The whole venue shares one IP, so typos count against one join limit | Known | Limit set at 20 per 10 minutes |
| A photo of the PIN slide spreads | Known | Change PIN |
| Venue network fails | Known | Clipboard is unavailable, same as the deck's CDN fonts. The HackMD fallback also needs a network. |

## 15. First use: AGNA course

Before 17 September 2026:
- Create room `agna-2026`, titled "Claude Code at AGNA", with a PIN.
- Pin the `agna-starter` repository link.
- Prepare the HackMD fallback note.

Showing the room URL and PIN on a deck slide is a change to the course deck in the `agna-prospectus` repository. It is a separate task, not part of this build.

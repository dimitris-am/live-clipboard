# Live Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable live shared clipboard. Participants join a room with a PIN and a name on `clip.dimitrismitsis.com`; owners run rooms from `clip-admin.dimitrismitsis.com` behind Cloudflare Access; everyone sees text, links and files appear in real time.

**Architecture:** One TypeScript Cloudflare Worker serves both hostnames and decides identity by hostname: an Access token on the admin host, a room session cookie on the public host. Each room is a SQLite-backed Durable Object that owns its settings, sessions, posts, rate counters and hibernating WebSockets. Files stream to R2. D1 holds only the list of room slugs. Changes go over HTTP, and WebSockets only push. The front end is plain HTML, CSS and JavaScript served from static assets.

**Tech Stack:** Cloudflare Workers, Durable Objects (SQLite, WebSocket Hibernation), R2, D1, Workers Static Assets, Cloudflare Access (one-time PIN), TypeScript, `jose`, Vitest with `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-09-13-live-clipboard-design.md`. Read it before starting any task.

## Global Constraints

Every task implicitly includes these.

**Toolchain.** A spike on 2026-09-13 verified these exact versions on Node v25.9.0:
- Exact devDependency versions: `@cloudflare/vitest-plugin` 1.1.8, `vitest` 4.1.11, `wrangler` 4.131.1, `jose` 6.2.12, `typescript` 6.0.3.
- `jose` is the only package the Worker imports at runtime. No front-end framework, no bundler beyond Wrangler.
- Do **not** use `@cloudflare/vitest-pool-workers`. It was renamed to `@cloudflare/vitest-plugin` and pins an older workerd.
- `compatibility_date` is `"2026-09-01"`. Dates from 2026-08-04 onward enable `nodejs_compat` by default, so add no compatibility flags.
- Tests import `SELF` and `runInDurableObject` from `"cloudflare:test"` and `env` from `"cloudflare:workers"`. `SELF` is marked deprecated but was verified for HTTP, WebSockets and R2 uploads.
- Storage is fresh per test file but shared between tests inside one file. Every test uses its own room slug.

**Runtime rules the spike found:**
- **R2 uploads:** stream request bodies through `new FixedLengthStream(contentLength)` with `Promise.all([body.pipeTo(writable), bucket.put(key, readable, …)])`. A raw `request.body` fails with "Provided readable stream must have a known length".
- **Assets:** use `"html_handling": "none"` and `"not_found_handling": "none"`, so `env.ASSETS.fetch("/board.html")` returns the file instead of a 307.
- **`ctx.storage.deleteAll()`** drops the SQLite tables. Re-run the schema afterwards.
- **WebSocket close codes:** workerd accepts 1000, 3000 and 4000–4999 only.
- **`wrangler dev` rewrites the host whenever `routes` are configured.** Verified 2026-09-13: with the two custom-domain routes present, both `localhost` and `127.0.0.1` reached the Worker as `clip.dimitrismitsis.com`. Therefore:
  - The **top level** of `wrangler.jsonc` is the local and test configuration: no routes, local hosts.
  - **Production** lives in `env.production`, which repeats the non-inheritable bindings and vars and adds the routes. A dry-run deploy of that layout showed the right bindings and hosts.
  - Deploy only with `wrangler deploy --env production` (`npm run deploy`).

**Spec values, verbatim:**
- **Hosts:** public `clip.dimitrismitsis.com`, admin `clip-admin.dimitrismitsis.com`. Local dev: public `localhost:8787`, admin `127.0.0.1:8787`.
- **Room identity:**
  - Slug: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`, fixed after creation. Title: 1–80 characters.
  - PIN: 6–12 letters or digits, case-sensitive. Name: trimmed, 1–40 characters.
- **Content limits:**
  - Text post: 1–20,000 characters, not whitespace-only, stored exactly as sent.
  - File: 1 byte to 25 MB. Room file quota: 2 GB.
- **Rate limits:**
  - Posts and uploads: 30 per minute per session (participants) or per email (owners).
  - Join failures: 20 per IP per room in a rolling 10 minutes, then `429 {"error":"Too many attempts","retryAfter":<seconds>}`.
- **Session:**
  - 128-bit random ID, hex, 7 days from joining, not sliding.
  - Cookie: `clip_session=<id>; Path=/r/<slug>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`.
- **Close codes:** `4401` session ended (PIN changed, left, or expired). `4404` room deleted.
- **Error messages** (bodies are `{"error": "<message>"}`):
  - Join, wrong PIN or unknown room: exactly `Room or PIN not recognized` (403).
  - Every other message string in this plan is the exact text to use.
- **Inline images:** exactly `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Everything else downloads as `application/octet-stream` with `Content-Disposition: attachment`.
- **CSP on every HTML page:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' <ws origin>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. `<ws origin>` is the request origin with `http` replaced by `ws`, e.g. `wss://clip.dimitrismitsis.com`. It is added because older Safari does not match WebSockets against `'self'`.

**Addition to the spec:** the board's composer has an **Attach file** button (a file picker). Spec §8.2 lists only paste and drop, and neither works on phones, where many participants will be.

**Front-end rules:**
- No `innerHTML`: build nodes with `textContent`. No inline `<script>` or `<style>`, and no `style=""` attributes in HTML.
- No `alert`, `confirm` or `prompt`: use inline forms, so a headless browser can drive every page.
- All user-facing copy is American English.

**Commits:** end every commit message with these two lines:
```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C8HYh5ZNPMr2S4BdvD2k3T
```

**One deliberate reading of the spec:** posting and uploading are closed for **everyone**, owners included, while a room is archived. §6 lists "room not archived" for both actors. Owners keep delete, pin and unpin.

## File Structure

```
live-clipboard/
├── package.json, package-lock.json
├── wrangler.jsonc               Worker config: hosts, bindings, vars
├── vitest.config.ts             test pool config + test-only bindings
├── tsconfig.json                one config for src, test, public JS
├── .gitignore, .dev.vars.example
├── README.md                    setup, local dev, deploy, manual checklist
├── docs/deploy-notes.md         Access team domain + AUD recorded by Task 1
├── migrations/0001_rooms.sql    D1 room index
├── probe/                       throwaway Access + WebSocket probe (Task 1, deleted in Task 13)
│   ├── wrangler.jsonc
│   └── src/index.ts
├── src/
│   ├── index.ts                 entry: host routing, origin check, pages; re-exports Room
│   ├── limits.ts                every numeric limit, in one place
│   ├── results.ts               Result<T> type shared by Worker and Room
│   ├── validate.ts              slug/title/pin/name/text parsing
│   ├── ids.ts                   post IDs, session IDs, constant-time compare
│   ├── files.ts                 file name sanitizing, content types, download headers
│   ├── owners.ts                OWNERS parsing, Access token verification, dev identity
│   ├── http.ts                  JSON/error responses, cookies, page + asset serving
│   ├── board-api.ts             /r/:slug/* routes for both hosts
│   ├── upload.ts                upload orchestration (authorize → R2 → commit → cleanup)
│   ├── admin-api.ts             /api/rooms* routes (admin host)
│   ├── r2.ts                    delete every object under a prefix
│   └── room/
│       ├── types.ts             Cred, Actor, RoomInfo, WirePost, …
│       ├── schema.ts            SQLite schema + migrate()
│       ├── rate.ts              rate_events helpers
│       ├── wire.ts              PostRow → WirePost for one viewer
│       └── room.ts              Room Durable Object
├── public/
│   ├── home.html, board.html, admin.html
│   └── assets/
│       ├── app.css
│       ├── common.js            api(), toast(), el(), splitLinks(), relativeTime(), formatBytes()
│       ├── board.js             join form, live board, composer, uploads
│       └── admin.js             rooms table, create, manage
└── test/
    ├── apply-migrations.ts, env.d.ts, helpers.ts
    ├── smoke.test.ts            Task 2
    ├── validate.test.ts, files.test.ts        Task 3
    ├── owners.test.ts                         Task 4
    ├── room-join.test.ts                      Task 5
    ├── room-live.test.ts                      Task 6
    ├── room-files.test.ts                     Task 7
    ├── board-api.test.ts, upload.test.ts      Task 8
    ├── admin-api.test.ts                      Task 9
    └── common.test.ts                         Task 10
```

## Task Order

| # | Task | Deliverable |
|---|---|---|
| 1 | Access + WebSocket probe | Proof that WebSockets pass through Access on `clip-admin`; team domain + AUD recorded |
| 2 | Scaffold and test harness | Green smoke test; config verified |
| 3 | Validation, IDs, file helpers | Pure modules with unit tests |
| 4 | Owner authentication | Access token verification + dev identity, unit-tested |
| 5 | Room: settings, join, sessions | Room object RPC with PIN, sessions, rate limit |
| 6 | Room: posts and live sockets | Posts, delete, pin, archive, broadcasts, close codes |
| 7 | Room: files | Upload grants, commit, quota, file lookup |
| 8 | Worker board routes | Both hosts' `/r/:slug/*` over HTTP and WebSocket |
| 9 | Admin API | Create, list, rename, archive, change PIN, delete with retry |
| 10 | Front-end foundation | CSS, shared JS helpers (tested), home page |
| 11 | Admin page | Rooms table, create form, manage panel (built first so Task 12 can create rooms in a browser) |
| 12 | Board page | Join form, live board, composer, paste/drop uploads |
| 13 | Deploy and hand-off | Production deploy, README, manual checklist, `agna-2026` room |

Tasks 1 and 13 need Dimitris at the Cloudflare dashboard and a browser; each marks exactly where to stop and hand over.

---

### Task 1: Access + WebSocket probe (throwaway)

Proves the one untested assumption before any feature work: WebSockets reach a Worker through a Cloudflare Access **self-hosted application**, with the `Cf-Access-Jwt-Assertion` header present on the upgrade. It also creates the Access application the real Worker will reuse, since the application is tied to the hostname, not to a Worker.

**Files:**
- Create: `probe/wrangler.jsonc`
- Create: `probe/src/index.ts`
- Create: `docs/deploy-notes.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/deploy-notes.md` containing the exact `ACCESS_TEAM_DOMAIN` (e.g. `https://<team>.cloudflareaccess.com`) and `ACCESS_AUD` values that Task 2 writes into `wrangler.jsonc`, plus the probe result.

- [ ] **Step 1: Confirm the Cloudflare account**

Run: `npx --yes wrangler@4.131.1 whoami`
Expected: signed in to the account that holds the `dimitrismitsis.com` zone. If not signed in, stop and ask Dimitris to run `! npx wrangler@4.131.1 login`.

- [ ] **Step 2: Write the probe Worker config**

`probe/wrangler.jsonc`:

```jsonc
{
  "name": "clip-probe",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "clip-admin.dimitrismitsis.com", "custom_domain": true }]
}
```

- [ ] **Step 3: Write the probe Worker**

`probe/src/index.ts`:

```ts
// Throwaway probe: does a WebSocket reach this Worker through Cloudflare Access,
// and does the upgrade request carry the Access token? Deleted in Task 13.

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>clip probe</title></head>
<body>
<h1>clip probe</h1>
<pre id="log"></pre>
<script>
const log = (m) => { document.getElementById("log").textContent += m + "\\n"; };
fetch("/whoami").then((r) => r.json()).then((j) => log("HTTP: " + JSON.stringify(j)));
const ws = new WebSocket("wss://" + location.host + "/ws");
ws.onopen = () => { log("WS open"); ws.send("ping"); };
ws.onmessage = (e) => log("WS message: " + e.data);
ws.onclose = (e) => log("WS closed " + e.code);
ws.onerror = () => log("WS error");
</script>
</body>
</html>`;

function claimsOf(jwt: string | null): Record<string, unknown> | null {
  if (!jwt) return null;
  const part = jwt.split(".")[1] ?? "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  try {
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    const claims = claimsOf(jwt);

    if (url.pathname === "/whoami") {
      return Response.json({
        hasJwt: jwt !== null,
        email: claims?.email ?? null,
        iss: claims?.iss ?? null,
        aud: claims?.aud ?? null,
      });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.send(JSON.stringify({ hasJwt: jwt !== null, email: claims?.email ?? null }));
      server.addEventListener("message", (event) => server.send(`echo: ${event.data}`));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
```

- [ ] **Step 4: Deploy the probe**

Run: `npx --yes wrangler@4.131.1 deploy --config probe/wrangler.jsonc`
Expected: the deploy output lists `clip-admin.dimitrismitsis.com (custom domain)`.

- [ ] **Step 5: HAND OVER to Dimitris for the Zero Trust setup**

Stop and ask Dimitris to do the following in the Cloudflare dashboard. The dashboard's navigation labels move around, so search for the named setting if a path doesn't match.

1. **Zero Trust:** open it, and create a team if the account has none. Note the **team domain** (`<team>.cloudflareaccess.com`).
2. **Login methods:** under Settings → Authentication, add **One-time PIN**. It is not on by default for new accounts.
3. **Access application:** Access → Applications → Add an application → **Self-hosted**.
   - Application name: `Live Clipboard admin`
   - Domain: `clip-admin.dimitrismitsis.com`, with no path
   - Session duration: **1 week**, or the nearest option offered
   - Identity providers: One-time PIN only
4. **Policy:** name `Owners`, action **Allow**, include rule **Emails** = `mitsosmitsis@gmail.com`. Dimitris confirms this is the address he wants to sign in with.
5. **AUD tag:** after saving, copy the application's **Application Audience (AUD) Tag** from its overview.

- [ ] **Step 6: HAND OVER to Dimitris for the browser check**

Ask Dimitris to open `https://clip-admin.dimitrismitsis.com` in a normal browser window, sign in with the emailed PIN, and paste the page's log back. Expected log (order of the first lines may vary):

```
WS open
HTTP: {"hasJwt":true,"email":"mitsosmitsis@gmail.com","iss":"https://<team>.cloudflareaccess.com","aud":["<AUD tag>"]}
WS message: {"hasJwt":true,"email":"mitsosmitsis@gmail.com"}
WS message: echo: ping
```

Then ask him to open the same URL in a private window. Expected: the Cloudflare Access sign-in page, not the probe page.

**Decision gate:**
- If `WS open` and both `WS message` lines appear, continue.
- If the WebSocket fails, or `hasJwt` is `false` on the WS line, **stop the plan** and report to Dimitris. The spec's fallback applies: an owner board that polls a snapshot endpoint every 3 seconds. That is a plan change he must approve.

- [ ] **Step 7: Record the values**

`docs/deploy-notes.md`, filled with the real values from Steps 5–6:

```markdown
# Deploy notes

## Cloudflare Access (recorded in Task 1, YYYY-MM-DD)

- ACCESS_TEAM_DOMAIN: https://<team>.cloudflareaccess.com
- ACCESS_AUD: <AUD tag>
- Access application: "Live Clipboard admin", self-hosted, clip-admin.dimitrismitsis.com, session 1 week, policy "Owners" (Emails: mitsosmitsis@gmail.com), login method One-time PIN
- Probe result: WebSocket through Access works; Cf-Access-Jwt-Assertion present on the upgrade request.
- The throwaway Worker `clip-probe` still owns the clip-admin custom domain. Task 13 deletes it before the real deploy.
```

Replace `YYYY-MM-DD`, `<team>` and `<AUD tag>` with the recorded values. The file must not keep angle-bracket placeholders.

- [ ] **Step 8: Commit**

```bash
git add probe docs/deploy-notes.md
git commit -m "Add throwaway Access WebSocket probe and record Access settings"
```

(Plus the two trailer lines from Global Constraints.)

---

### Task 2: Scaffold and test harness

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `vitest.config.ts`, `tsconfig.json`, `.gitignore`, `.dev.vars.example`
- Create: `migrations/0001_rooms.sql`
- Create: `src/index.ts`, `src/room/room.ts` (skeletons, replaced in later tasks)
- Create: `public/home.html`, `public/board.html`, `public/admin.html`, `public/assets/app.css` (placeholders, replaced in Tasks 10–12)
- Create: `test/apply-migrations.ts`, `test/env.d.ts`, `test/helpers.ts`, `test/smoke.test.ts`

**Interfaces:**
- Consumes: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` from `docs/deploy-notes.md` (Task 1), used in `env.production`.
- Produces:
  - Bindings `ROOMS` (`DurableObjectNamespace<Room>`), `FILES` (`R2Bucket`), `DB` (`D1Database`), `ASSETS` (`Fetcher`).
  - Vars `PUBLIC_HOST`, `ADMIN_HOST`, `OWNERS`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`: local values at the top level, real values in `env.production`.
  - Test-only bindings `ENVIRONMENT` and `DEV_OWNER_EMAIL`, added in `vitest.config.ts` (new keys, nothing overridden).
  - Test helpers `PUBLIC`, `ADMIN`, `OWNER`, `acceptSocket(res): TestSocket` with `next()`, `nextOfType(type)`, `closed()`.
  - The page marker `<meta name="clip-page" content="home|board|admin">`, which every HTML page keeps forever because tests look for it.

- [ ] **Step 1: Create `package.json` and install**

```json
{
  "name": "live-clipboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --ip 127.0.0.1 --port 8787",
    "test": "vitest run",
    "typecheck": "wrangler types && tsc --noEmit",
    "deploy": "wrangler deploy --env production"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.1.8",
    "jose": "6.2.12",
    "typescript": "6.0.3",
    "vitest": "4.1.11",
    "wrangler": "4.131.1"
  }
}
```

Run: `npm install`
Expected: installs without errors and writes `package-lock.json`.

- [ ] **Step 2: Create `wrangler.jsonc`**

The top level is the **local and test** configuration: no routes, so `wrangler dev` keeps the real host (see Global Constraints). `env.production` repeats the bindings and vars, because Wrangler does not inherit them, and adds the routes.
- In `env.production`, replace the two `ACCESS_*` values with the ones in `docs/deploy-notes.md`.
- The all-zero `database_id` (both places) is replaced in Task 13. Tests and local dev don't need a real one.
- The top-level `ACCESS_*` values are deliberately fake. Local owners use the development identity instead.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "live-clipboard",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "workers_dev": false,
  "preview_urls": false,
  "assets": {
    "directory": "public",
    "binding": "ASSETS",
    "run_worker_first": true,
    "html_handling": "none",
    "not_found_handling": "none"
  },
  "durable_objects": {
    "bindings": [{ "name": "ROOMS", "class_name": "Room" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "live-clipboard-files" }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "live-clipboard",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "PUBLIC_HOST": "localhost:8787",
    "ADMIN_HOST": "127.0.0.1:8787",
    "OWNERS": "{\"mitsosmitsis@gmail.com\":\"Dimitris\"}",
    "ACCESS_TEAM_DOMAIN": "https://local.invalid",
    "ACCESS_AUD": "local"
  },
  "env": {
    "production": {
      "name": "live-clipboard",
      "routes": [
        { "pattern": "clip.dimitrismitsis.com", "custom_domain": true },
        { "pattern": "clip-admin.dimitrismitsis.com", "custom_domain": true }
      ],
      "durable_objects": {
        "bindings": [{ "name": "ROOMS", "class_name": "Room" }]
      },
      "r2_buckets": [{ "binding": "FILES", "bucket_name": "live-clipboard-files" }],
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "live-clipboard",
          "database_id": "00000000-0000-0000-0000-000000000000",
          "migrations_dir": "migrations"
        }
      ],
      "vars": {
        "PUBLIC_HOST": "clip.dimitrismitsis.com",
        "ADMIN_HOST": "clip-admin.dimitrismitsis.com",
        "OWNERS": "{\"mitsosmitsis@gmail.com\":\"Dimitris\"}",
        "ACCESS_TEAM_DOMAIN": "https://TEAM.cloudflareaccess.com",
        "ACCESS_AUD": "AUD_TAG_FROM_DEPLOY_NOTES"
      }
    }
  }
}
```

Run: `npx wrangler deploy --dry-run --env production --outdir .wrangler/dry-run`
Expected: the binding table lists `env.ROOMS (Room)`, `env.DB (live-clipboard)`, `env.FILES (live-clipboard-files)`, `env.ASSETS`, and `env.PUBLIC_HOST ("clip.dimitrismitsis.com")`, then `--dry-run: exiting now.` Nothing is uploaded.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Runs in Node.js: read the SQL files and hand them to the runtime as a test-only binding.
      const migrations = await readD1Migrations("./migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The top-level vars already use the local doors. These add the development
            // owner identity, so admin-host requests in tests act as the owner in OWNERS.
            ENVIRONMENT: "development",
            DEV_OWNER_EMAIL: "mitsosmitsis@gmail.com",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
```

- [ ] **Step 4: Create `tsconfig.json`, `.gitignore`, `.dev.vars.example`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/vitest-plugin/types"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": false,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["worker-configuration.d.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
worker-configuration.d.ts
.DS_Store
```

`.dev.vars.example`. Copy it to `.dev.vars` for `wrangler dev`. `DEV_OWNER_EMAIL` must be a key in `OWNERS`.

```
ENVIRONMENT=development
DEV_OWNER_EMAIL=mitsosmitsis@gmail.com
```

- [ ] **Step 5: Create the D1 migration**

`migrations/0001_rooms.sql`:

```sql
CREATE TABLE rooms (
  slug TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 6: Create skeleton Worker, Room and placeholder pages**

`src/room/room.ts` (replaced in Task 5):

```ts
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject<Env> {}
```

`src/index.ts` (replaced in Task 8):

```ts
export { Room } from "./room/room";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`public/home.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="clip-page" content="home">
<title>Live Clipboard</title>
</head>
<body></body>
</html>
```

`public/board.html`: the same file, with `content="board"`. `public/admin.html`: the same file, with `content="admin"`.

`public/assets/app.css`:

```css
/* Replaced in Task 10. */
```

- [ ] **Step 7: Create the test support files**

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs inside workerd before each test file. applyD1Migrations is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`test/env.d.ts`:

```ts
// Test-only bindings added through `miniflare.bindings` in vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

`test/helpers.ts`:

```ts
export const PUBLIC = "http://localhost:8787";
export const ADMIN = "http://127.0.0.1:8787";
/** Matches OWNERS in wrangler.jsonc and DEV_OWNER_EMAIL in vitest.config.ts. */
export const OWNER = { email: "mitsosmitsis@gmail.com", name: "Dimitris" } as const;

export type Msg = { type: string; [key: string]: unknown };

export interface TestSocket {
  ws: WebSocket;
  /** Resolves with the next unread JSON message (queued, so nothing is lost). */
  next(timeoutMs?: number): Promise<Msg>;
  /** Skips messages until one of the given type arrives. */
  nextOfType(type: string, timeoutMs?: number): Promise<Msg>;
  /** Resolves when the socket's close event fires. */
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms),
    ),
  ]);
}

/**
 * Wraps the client end of a 101 response. Listeners are attached BEFORE accept(),
 * so a snapshot the server sent before the upgrade completed is captured.
 */
export function acceptSocket(res: Response): TestSocket {
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected webSocket on response, got status ${res.status}`);

  const queue: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  let resolveClosed!: (v: { code: number; reason: string }) => void;
  const closedPromise = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Msg;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  ws.addEventListener("close", (event) => {
    resolveClosed({ code: event.code, reason: event.reason });
  });
  ws.accept();

  const socket: TestSocket = {
    ws,
    next(timeoutMs = 2000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return withTimeout(new Promise<Msg>((r) => waiters.push(r)), timeoutMs, "ws message");
    },
    async nextOfType(type, timeoutMs = 2000) {
      for (;;) {
        const msg = await socket.next(timeoutMs);
        if (msg.type === type) return msg;
      }
    },
    closed(timeoutMs = 2000) {
      return withTimeout(closedPromise, timeoutMs, "ws close");
    },
  };
  return socket;
}
```

- [ ] **Step 8: Write the smoke test**

`test/smoke.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PUBLIC } from "./helpers";

describe("harness", () => {
  it("uses the local doors and the test-only owner identity", () => {
    expect(env.PUBLIC_HOST).toBe("localhost:8787");
    expect(env.ADMIN_HOST).toBe("127.0.0.1:8787");
    const testOnly = env as unknown as { ENVIRONMENT?: string; DEV_OWNER_EMAIL?: string };
    expect(testOnly.ENVIRONMENT).toBe("development");
    expect(testOnly.DEV_OWNER_EMAIL).toBe("mitsosmitsis@gmail.com");
  });

  it("applies the D1 migration", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'",
    ).all();
    expect(tables.results).toHaveLength(1);
  });

  it("serves assets through the ASSETS binding with html_handling none", async () => {
    const res = await env.ASSETS.fetch(new URL("/board.html", PUBLIC));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="board"');
  });

  it("reaches the Worker", async () => {
    const res = await SELF.fetch(`${PUBLIC}/`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });
});
```

- [ ] **Step 9: Run the tests and the type check**

Run: `npm test`
Expected: `Test Files  1 passed (1)`, `Tests  4 passed (4)`.

Run: `npm run typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc vitest.config.ts tsconfig.json .gitignore .dev.vars.example migrations src public test
git commit -m "Scaffold Worker, bindings and Vitest harness"
```

---

### Task 3: Limits, results, validation, IDs, file helpers

Pure modules with no bindings. Everything later imports its limits and parsers from here.

**Files:**
- Create: `src/limits.ts`, `src/results.ts`, `src/validate.ts`, `src/ids.ts`, `src/files.ts`
- Test: `test/validate.test.ts`, `test/files.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `limits.ts`: `MAX_TEXT_CHARS`, `MAX_FILE_BYTES`, `ROOM_QUOTA_BYTES`, `POSTS_PER_MINUTE`, `POST_WINDOW_MS`, `JOIN_FAILURES_PER_WINDOW`, `JOIN_WINDOW_MS`, `SESSION_MS`, `MAX_FILE_NAME_CHARS`
  - `results.ts`: `type Fail`, `type Ok<T>`, `type Result<T>`, `ok(value)`, `fail(status, error, retryAfter?)`
  - `validate.ts`: `isSlug(v): v is string`, `parseTitle(v): string | null`, `parsePin(v): string | null`, `parseName(v): string | null`, `parsePostText(v): string | null`
  - `ids.ts`: `newPostId(now?): string`, `newSessionId(): string`, `isSessionId(v): v is string`, `constantTimeEqual(a, b): boolean`
  - `files.ts`: `INLINE_IMAGE_TYPES`, `sanitizeFileName(raw): string`, `normalizeContentType(raw): string`, `isInlineImage(type): boolean`, `downloadHeaders(type, name): Headers`

- [ ] **Step 1: Write the failing validation tests**

`test/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { constantTimeEqual, isSessionId, newPostId, newSessionId } from "../src/ids";
import { isSlug, parseName, parsePin, parsePostText, parseTitle } from "../src/validate";

describe("isSlug", () => {
  it.each(["agna-2026", "a", "a1", "x".repeat(40)])("accepts %s", (slug) => {
    expect(isSlug(slug)).toBe(true);
  });
  it.each(["", "-a", "a-", "A", "a_b", "x".repeat(41), "a/b", 12])("rejects %s", (slug) => {
    expect(isSlug(slug)).toBe(false);
  });
});

describe("parseTitle", () => {
  it("trims and accepts 1–80 characters", () => {
    expect(parseTitle("  Claude Code at AGNA ")).toBe("Claude Code at AGNA");
    expect(parseTitle("x".repeat(80))).toBe("x".repeat(80));
  });
  it("rejects empty, too long and non-strings", () => {
    expect(parseTitle("   ")).toBeNull();
    expect(parseTitle("x".repeat(81))).toBeNull();
    expect(parseTitle(5)).toBeNull();
  });
});

describe("parsePin", () => {
  it("accepts 6–12 letters or digits, unchanged", () => {
    expect(parsePin("482913")).toBe("482913");
    expect(parsePin("AgnaAgna2026")).toBe("AgnaAgna2026");
  });
  it("rejects short, long, symbols, spaces and non-strings", () => {
    for (const bad of ["12345", "1234567890123", "12345!", "123 456", 123456]) {
      expect(parsePin(bad)).toBeNull();
    }
  });
});

describe("parseName", () => {
  it("trims and accepts 1–40 characters", () => {
    expect(parseName("  Kristi ")).toBe("Kristi");
    expect(parseName("x".repeat(40))).toBe("x".repeat(40));
  });
  it("rejects empty, too long, control characters and non-strings", () => {
    expect(parseName("  ")).toBeNull();
    expect(parseName("x".repeat(41))).toBeNull();
    expect(parseName("Kri" + String.fromCharCode(0) + "sti")).toBeNull();
    expect(parseName(null)).toBeNull();
  });
});

describe("parsePostText", () => {
  it("keeps text exactly, including surrounding whitespace", () => {
    expect(parsePostText("  claude --model sonnet\n")).toBe("  claude --model sonnet\n");
    expect(parsePostText("x".repeat(20_000))).toHaveLength(20_000);
  });
  it("rejects empty, whitespace-only, too long and non-strings", () => {
    expect(parsePostText("")).toBeNull();
    expect(parsePostText(" \n\t ")).toBeNull();
    expect(parsePostText("x".repeat(20_001))).toBeNull();
    expect(parsePostText({ text: "hi" })).toBeNull();
  });
});

describe("ids", () => {
  it("post IDs sort by creation time", () => {
    const earlier = newPostId(1_700_000_000_000);
    const later = newPostId(1_700_000_000_001);
    expect(earlier < later).toBe(true);
    expect(earlier).toMatch(/^[0-9a-z]{10}[0-9a-f]{16}$/);
  });
  it("session IDs are 32 hex characters and unique", () => {
    const a = newSessionId();
    expect(isSessionId(a)).toBe(true);
    expect(a).not.toBe(newSessionId());
    expect(isSessionId("not-a-session")).toBe(false);
  });
  it("constantTimeEqual compares exactly", () => {
    expect(constantTimeEqual("482913", "482913")).toBe(true);
    expect(constantTimeEqual("482913", "482914")).toBe(false);
    expect(constantTimeEqual("482913", "4829130")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing file helper tests**

`test/files.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { downloadHeaders, isInlineImage, normalizeContentType, sanitizeFileName } from "../src/files";

describe("sanitizeFileName", () => {
  it("keeps ordinary names", () => {
    expect(sanitizeFileName("error screenshot.png")).toBe("error screenshot.png");
    expect(sanitizeFileName("τιμές.csv")).toBe("τιμές.csv");
  });
  it("strips path separators, control characters and leading dots", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFileName("a\\b/c.txt")).toBe("abc.txt");
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("bad" + String.fromCharCode(0, 31, 127) + "name.txt")).toBe("badname.txt");
  });
  it("caps at 120 characters and falls back to 'file'", () => {
    expect(Array.from(sanitizeFileName("é".repeat(200)))).toHaveLength(120);
    expect(sanitizeFileName("../")).toBe("file");
    expect(sanitizeFileName("   ")).toBe("file");
  });
});

describe("normalizeContentType", () => {
  it("lowercases and drops parameters", () => {
    expect(normalizeContentType("Image/PNG; charset=binary")).toBe("image/png");
  });
  it("falls back to application/octet-stream", () => {
    expect(normalizeContentType(null)).toBe("application/octet-stream");
    expect(normalizeContentType("")).toBe("application/octet-stream");
    expect(normalizeContentType("not a type")).toBe("application/octet-stream");
  });
});

describe("downloadHeaders", () => {
  it("serves the four image types inline with their own type", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isInlineImage(type)).toBe(true);
      const h = downloadHeaders(type, "shot.png");
      expect(h.get("Content-Type")).toBe(type);
      expect(h.get("Content-Disposition")).toBe("inline; filename*=UTF-8''shot.png");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
  it("forces SVG, HTML and everything else to download as octet-stream", () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf"]) {
      expect(isInlineImage(type)).toBe(false);
      const h = downloadHeaders(type, "page (1).html");
      expect(h.get("Content-Type")).toBe("application/octet-stream");
      expect(h.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''page%20%281%29.html");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/validate.test.ts test/files.test.ts`
Expected: FAIL. Imports of `../src/validate`, `../src/ids` and `../src/files` cannot be resolved.

- [ ] **Step 4: Implement `limits.ts` and `results.ts`**

`src/limits.ts`:

```ts
export const MAX_TEXT_CHARS = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ROOM_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const POSTS_PER_MINUTE = 30;
export const POST_WINDOW_MS = 60 * 1000;
export const JOIN_FAILURES_PER_WINDOW = 20;
export const JOIN_WINDOW_MS = 10 * 60 * 1000;
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FILE_NAME_CHARS = 120;
```

`src/results.ts`:

```ts
// Plain objects so they cross Durable Object RPC unchanged.
export type Fail = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  error: string;
  retryAfter?: number;
};
export type Ok<T> = { ok: true; value: T };
export type Result<T> = Ok<T> | Fail;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export function fail(status: Fail["status"], error: string, retryAfter?: number): Fail {
  return retryAfter === undefined ? { ok: false, status, error } : { ok: false, status, error, retryAfter };
}
```

- [ ] **Step 5: Implement `validate.ts` and `ids.ts`**

`src/validate.ts`:

```ts
import { MAX_TEXT_CHARS } from "./limits";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PIN_RE = /^[A-Za-z0-9]{6,12}$/;
const CONTROL_RE = /\p{Cc}/u;

export function isSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}

export function parseTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const title = v.trim();
  return title.length >= 1 && title.length <= 80 && !CONTROL_RE.test(title) ? title : null;
}

export function parsePin(v: unknown): string | null {
  return typeof v === "string" && PIN_RE.test(v) ? v : null;
}

export function parseName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  return name.length >= 1 && name.length <= 40 && !CONTROL_RE.test(name) ? name : null;
}

export function parsePostText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length < 1 || v.length > MAX_TEXT_CHARS) return null;
  return v.trim().length === 0 ? null : v;
}
```

`src/ids.ts`:

```ts
function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 10 base-36 time characters + 16 hex random characters; sorts by creation time. */
export function newPostId(now: number = Date.now()): string {
  return now.toString(36).padStart(10, "0") + randomHex(8);
}

/** 128-bit random session ID, hex-encoded. */
export function newSessionId(): string {
  return randomHex(16);
}

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/** Compares without returning early on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
```

- [ ] **Step 6: Implement `files.ts`**

`src/files.ts`:

```ts
import { MAX_FILE_NAME_CHARS } from "./limits";

export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(/\p{Cc}/gu, "")
    .replace(/[/\\]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const capped = Array.from(cleaned).slice(0, MAX_FILE_NAME_CHARS).join("");
  return capped.length > 0 ? capped : "file";
}

export function normalizeContentType(raw: string | null): string {
  const type = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) && type.length <= 100
    ? type
    : "application/octet-stream";
}

export function isInlineImage(type: string): boolean {
  return INLINE_IMAGE_TYPES.has(type);
}

function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function downloadHeaders(type: string, name: string): Headers {
  const inline = isInlineImage(type);
  return new Headers({
    "Content-Type": inline ? type : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeRfc5987(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/validate.test.ts test/files.test.ts`
Expected: PASS, both files green.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/limits.ts src/results.ts src/validate.ts src/ids.ts src/files.ts test/validate.test.ts test/files.test.ts
git commit -m "Add limits, results, validation, IDs and file helpers"
```

---

### Task 4: Owner authentication

**Files:**
- Create: `src/owners.ts`
- Test: `test/owners.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Owner = { email: string; name: string }`
  - `type OwnerEnv = { ADMIN_HOST: string; OWNERS: string; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ENVIRONMENT?: string; DEV_OWNER_EMAIL?: string }`
  - `parseOwners(raw: string): Map<string, string>`, whose keys are lowercased emails and values are display names
  - `authenticateOwner(request: Request, env: OwnerEnv, keys?: JWTVerifyGetKey): Promise<Owner | null>`

- [ ] **Step 1: Write the failing tests**

`test/owners.test.ts`:

```ts
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticateOwner, parseOwners, type OwnerEnv } from "../src/owners";

type CryptoKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const env: OwnerEnv = {
  ADMIN_HOST: "clip-admin.example.com",
  OWNERS: JSON.stringify({ "dimitris@example.com": "Dimitris" }),
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ACCESS_AUD: "aud-123",
};

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] });
});

async function token(opts: { email?: string; aud?: string; iss?: string; exp?: number; key?: CryptoKey } = {}) {
  return new SignJWT({ email: opts.email ?? "dimitris@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(opts.aud ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(opts.key ?? privateKey);
}

function request(host: string, jwt?: string): Request {
  return new Request(`https://${host}/`, {
    headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
}

describe("parseOwners", () => {
  it("lowercases emails", () => {
    expect(parseOwners('{"Dimitris@Example.com":"Dimitris"}').get("dimitris@example.com")).toBe("Dimitris");
  });
  it("returns an empty map for invalid input", () => {
    expect(parseOwners("not json").size).toBe(0);
    expect(parseOwners('["a"]').size).toBe(0);
    expect(parseOwners('{"a@b.c": 5}').size).toBe(0);
  });
});

describe("authenticateOwner with Access tokens", () => {
  it("accepts a valid token for a listed owner", async () => {
    const owner = await authenticateOwner(request(env.ADMIN_HOST, await token()), env, keys);
    expect(owner).toEqual({ email: "dimitris@example.com", name: "Dimitris" });
  });

  it("matches the email case-insensitively", async () => {
    const jwt = await token({ email: "Dimitris@Example.COM" });
    expect(await authenticateOwner(request(env.ADMIN_HOST, jwt), env, keys)).toEqual({
      email: "dimitris@example.com",
      name: "Dimitris",
    });
  });

  it.each([
    ["wrong audience", { aud: "other-aud" }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["email not in OWNERS", { email: "stranger@example.com" }],
  ])("rejects a token with %s", async (_label, opts) => {
    const jwt = await token(opts);
    expect(await authenticateOwner(request(env.ADMIN_HOST, jwt), env, keys)).toBeNull();
  });

  it("rejects a token signed by another key", async () => {
    const jwt = await token({ key: otherKey });
    expect(await authenticateOwner(request(env.ADMIN_HOST, jwt), env, keys)).toBeNull();
  });

  it("rejects a missing token and garbage", async () => {
    expect(await authenticateOwner(request(env.ADMIN_HOST), env, keys)).toBeNull();
    expect(await authenticateOwner(request(env.ADMIN_HOST, "a.b.c"), env, keys)).toBeNull();
  });

  it("rejects valid tokens on any other host", async () => {
    expect(await authenticateOwner(request("clip.example.com", await token()), env, keys)).toBeNull();
  });
});

describe("authenticateOwner development identity", () => {
  const dev: OwnerEnv = {
    ...env,
    ADMIN_HOST: "127.0.0.1:8787",
    ENVIRONMENT: "development",
    DEV_OWNER_EMAIL: "dimitris@example.com",
  };

  it("uses DEV_OWNER_EMAIL only on 127.0.0.1:8787 in development", async () => {
    expect(await authenticateOwner(request("127.0.0.1:8787"), dev, keys)).toEqual({
      email: "dimitris@example.com",
      name: "Dimitris",
    });
  });

  it("ignores DEV_OWNER_EMAIL when ENVIRONMENT is not development", async () => {
    const prod = { ...dev, ENVIRONMENT: "production" };
    expect(await authenticateOwner(request("127.0.0.1:8787"), prod, keys)).toBeNull();
  });

  it("ignores DEV_OWNER_EMAIL on a production admin host", async () => {
    const devOnProdHost = { ...dev, ADMIN_HOST: "clip-admin.example.com" };
    expect(await authenticateOwner(request("clip-admin.example.com"), devOnProdHost, keys)).toBeNull();
  });

  it("still requires DEV_OWNER_EMAIL to be listed in OWNERS", async () => {
    const unlisted = { ...dev, DEV_OWNER_EMAIL: "stranger@example.com" };
    expect(await authenticateOwner(request("127.0.0.1:8787"), unlisted, keys)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/owners.test.ts`
Expected: FAIL. `../src/owners` cannot be resolved.

- [ ] **Step 3: Implement `owners.ts`**

`src/owners.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type Owner = { email: string; name: string };

export type OwnerEnv = {
  ADMIN_HOST: string;
  OWNERS: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ENVIRONMENT?: string;
  DEV_OWNER_EMAIL?: string;
};

const DEV_ADMIN_HOST = "127.0.0.1:8787";

export function parseOwners(raw: string): Map<string, string> {
  const owners = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return owners;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return owners;
  for (const [email, name] of Object.entries(parsed)) {
    if (typeof name !== "string") return new Map();
    owners.set(email.toLowerCase(), name);
  }
  return owners;
}

// One remote key set per team domain, reused across requests in the same isolate.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
}

/**
 * Returns the owner for an admin-host request, or null.
 * Verifies the Access token itself even though Access sits in front of the host.
 */
export async function authenticateOwner(
  request: Request,
  env: OwnerEnv,
  keys?: JWTVerifyGetKey,
): Promise<Owner | null> {
  const host = new URL(request.url).host;
  if (host !== env.ADMIN_HOST) return null;
  const owners = parseOwners(env.OWNERS);

  const devIdentity =
    env.ENVIRONMENT === "development" && env.DEV_OWNER_EMAIL && host === DEV_ADMIN_HOST;
  if (devIdentity) {
    const email = env.DEV_OWNER_EMAIL!.toLowerCase();
    const name = owners.get(email);
    return name ? { email, name } : null;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys ?? remoteKeys(env.ACCESS_TEAM_DOMAIN), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    if (typeof payload.email !== "string") return null;
    const email = payload.email.toLowerCase();
    const name = owners.get(email);
    return name ? { email, name } : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/owners.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exits 0. If `tsc` reports that `createLocalJWKSet(...)` is not assignable to `JWTVerifyGetKey`, declare the parameter as `keys?: Parameters<typeof jwtVerify>[1]` instead. Use the same type in the test and change nothing else.

- [ ] **Step 5: Commit**

```bash
git add src/owners.ts test/owners.test.ts
git commit -m "Verify Access tokens and resolve owners"
```

---

### Task 5: Room object — settings, join and sessions

**Files:**
- Create: `src/room/types.ts`, `src/room/schema.ts`, `src/room/rate.ts`
- Replace: `src/room/room.ts` (the Task 2 skeleton)
- Test: `test/room-join.test.ts`

**Interfaces:**
- Consumes: `ok`, `fail`, `Result`, `Fail` (`src/results.ts`); `constantTimeEqual`, `newSessionId` (`src/ids.ts`); `JOIN_FAILURES_PER_WINDOW`, `JOIN_WINDOW_MS`, `SESSION_MS` (`src/limits.ts`).
- Produces:
  - **All room types**, including those used by Tasks 6–9:
    - `Cred`, `Actor`, `RoomRow`, `SessionRow`, `PostRow`, `RoomInfo`, `JoinOk`
    - `WirePost`, `UploadGrant`, `FileMeta`, `FileRef`, `ServerMessage`
    - `ownerCred(owner): Cred`
  - `migrate(sql: SqlStorage): void`
  - Rate helpers `record`, `countSince`, `oldestSince`, `pruneBefore`
  - **`Room` RPC methods:**
    - `init({slug, title, pin}): Result<null>`
    - `info(): RoomInfo | null`
    - `join({pin, name, ip}): Result<JoinOk>`
    - `me(cred): Result<{name, role}>`
    - `leave(cred): Result<null>`
    - `changePin(cred, pin): Result<null>`
  - **Private helpers Tasks 6–7 use:** `room()`, `resolve()`, `gate()`, `closeSockets()`.
- **Room error messages** (exact):
  - `Room not found` (404)
  - `Your session has ended. Join again.` (401)
  - `Only owners can do that` (403)
  - `This room is archived` (409)
  - `A room with that slug already exists` (409)
  - `Room or PIN not recognized` (403)
  - `Too many attempts` (429)

- [ ] **Step 1: Create `src/room/types.ts`**

```ts
/** What the Worker hands the room. Owner creds are only built after authenticateOwner(). */
export type Cred =
  | { kind: "owner"; email: string; name: string }
  | { kind: "session"; sessionId: string };

/** A resolved, currently valid identity. Stored as each WebSocket's attachment. */
export type Actor =
  | { role: "owner"; email: string; name: string }
  | { role: "participant"; sessionId: string; name: string };

export type RoomRow = {
  slug: string;
  title: string;
  pin: string;
  pin_version: number;
  archived: number;
  bytes_used: number;
  created_at: number;
};

export type SessionRow = {
  id: string;
  name: string;
  pin_version: number;
  expires_at: number;
};

export type PostRow = {
  id: string;
  kind: string;
  text: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  r2_key: string | null;
  author_name: string;
  author_role: string;
  author_session: string | null;
  author_email: string | null;
  created_at: number;
  pinned: number;
  pinned_at: number | null;
};

export type RoomInfo = {
  slug: string;
  title: string;
  pin: string;
  archived: boolean;
  postCount: number;
  participantCount: number;
  bytesUsed: number;
  createdAt: number;
};

export type JoinOk = { sessionId: string; name: string; maxAgeSeconds: number };

export type WirePost = {
  id: string;
  kind: "text" | "file";
  text?: string;
  file?: { name: string; size: number; type: string; url: string };
  authorName: string;
  authorRole: "owner" | "participant";
  createdAt: number;
  pinned: boolean;
  pinnedAt: number | null;
  mine: boolean;
};

export type UploadGrant = { postId: string; r2Key: string };
export type FileMeta = { postId: string; r2Key: string; name: string; size: number; type: string };
export type FileRef = { r2Key: string; name: string; type: string };

export type ServerMessage =
  | {
      type: "snapshot";
      room: { slug: string; title: string; archived: boolean };
      you: { name: string; role: Actor["role"] };
      online: number;
      posts: WirePost[];
    }
  | { type: "post.added"; post: WirePost }
  | { type: "post.deleted"; id: string }
  | { type: "post.pinned"; id: string; pinned: boolean; pinnedAt: number | null }
  | { type: "room.updated"; room: { title: string; archived: boolean } }
  | { type: "online"; count: number };

export function ownerCred(owner: { email: string; name: string }): Cred {
  return { kind: "owner", email: owner.email, name: owner.name };
}
```

- [ ] **Step 2: Create `src/room/schema.ts` and `src/room/rate.ts`**

`src/room/schema.ts`:

```ts
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS room (
     slug TEXT NOT NULL,
     title TEXT NOT NULL,
     pin TEXT NOT NULL,
     pin_version INTEGER NOT NULL DEFAULT 1,
     archived INTEGER NOT NULL DEFAULT 0,
     bytes_used INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS posts (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     text TEXT,
     file_name TEXT,
     file_size INTEGER,
     file_type TEXT,
     r2_key TEXT,
     author_name TEXT NOT NULL,
     author_role TEXT NOT NULL,
     author_session TEXT,
     author_email TEXT,
     created_at INTEGER NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     pinned_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     pin_version INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rate_events (
     bucket TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rate_events_bucket_at ON rate_events (bucket, at)`,
];

/** Idempotent. Runs at construction and again after deleteAll(), which drops every table. */
export function migrate(sql: SqlStorage): void {
  for (const statement of STATEMENTS) sql.exec(statement);
}
```

`src/room/rate.ts`:

```ts
export function record(sql: SqlStorage, bucket: string, at: number): void {
  sql.exec("INSERT INTO rate_events (bucket, at) VALUES (?, ?)", bucket, at);
}

export function countSince(sql: SqlStorage, bucket: string, since: number): number {
  return sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND at > ?", bucket, since)
    .one().n;
}

export function oldestSince(sql: SqlStorage, bucket: string, since: number): number | null {
  return sql
    .exec<{ at: number | null }>("SELECT MIN(at) AS at FROM rate_events WHERE bucket = ? AND at > ?", bucket, since)
    .one().at;
}

export function pruneBefore(sql: SqlStorage, before: number): void {
  sql.exec("DELETE FROM rate_events WHERE at <= ?", before);
}
```

- [ ] **Step 3: Write the failing tests**

`test/room-join.test.ts`:

```ts
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Room } from "../src/room/room";
import { ownerCred, type Cred } from "../src/room/types";
import { OWNER } from "./helpers";

const owner = ownerCred(OWNER);
const stub = (slug: string) => env.ROOMS.getByName(slug);

async function createRoom(slug: string, pin = "482913") {
  expect(await stub(slug).init({ slug, title: "Test room", pin })).toEqual({ ok: true, value: null });
  return stub(slug);
}

async function joinAs(slug: string, name = "Kristi", pin = "482913"): Promise<Cred> {
  const joined = await stub(slug).join({ pin, name, ip: "198.51.100.7" });
  if (!joined.ok) throw new Error(joined.error);
  return { kind: "session", sessionId: joined.value.sessionId };
}

describe("room settings", () => {
  it("creates a room once and reports its settings", async () => {
    const room = await createRoom("join-init");
    expect(await room.info()).toMatchObject({
      slug: "join-init",
      title: "Test room",
      pin: "482913",
      archived: false,
      postCount: 0,
      participantCount: 0,
      bytesUsed: 0,
    });
    expect(await room.init({ slug: "join-init", title: "Again", pin: "111111" })).toEqual({
      ok: false,
      status: 409,
      error: "A room with that slug already exists",
    });
  });

  it("reports nothing for a room that was never created", async () => {
    expect(await stub("join-never").info()).toBeNull();
    expect(await stub("join-never").me(owner)).toEqual({ ok: false, status: 404, error: "Room not found" });
  });
});

describe("joining", () => {
  it("joins with the right PIN and resolves the session", async () => {
    const room = await createRoom("join-ok");
    const joined = await room.join({ pin: "482913", name: "Kristi", ip: "198.51.100.7" });
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.value.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(joined.value).toMatchObject({ name: "Kristi", maxAgeSeconds: 604800 });
    const cred: Cred = { kind: "session", sessionId: joined.value.sessionId };
    expect(await room.me(cred)).toEqual({ ok: true, value: { name: "Kristi", role: "participant" } });
    expect((await room.info())?.participantCount).toBe(1);
  });

  it("answers a wrong PIN and an unknown room identically", async () => {
    const room = await createRoom("join-wrong");
    const wrong = await room.join({ pin: "000000", name: "Kristi", ip: "198.51.100.8" });
    const unknown = await stub("join-unknown").join({ pin: "482913", name: "Kristi", ip: "198.51.100.8" });
    expect(wrong).toEqual({ ok: false, status: 403, error: "Room or PIN not recognized" });
    expect(unknown).toEqual(wrong);
  });

  it("allows 20 failed joins per IP, then returns 429", async () => {
    const room = await createRoom("join-limit");
    for (let i = 0; i < 20; i++) {
      expect(await room.join({ pin: "000000", name: "x", ip: "203.0.113.1" })).toMatchObject({ status: 403 });
    }
    const limited = await room.join({ pin: "482913", name: "x", ip: "203.0.113.1" });
    expect(limited).toMatchObject({ ok: false, status: 429, error: "Too many attempts" });
    if (limited.ok) throw new Error("expected a failure");
    expect(limited.retryAfter).toBeGreaterThanOrEqual(1);
    expect(limited.retryAfter).toBeLessThanOrEqual(600);
    expect((await room.join({ pin: "482913", name: "y", ip: "203.0.113.2" })).ok).toBe(true);
  });

  it("ends a session after it expires", async () => {
    const room = await createRoom("join-expiry");
    const cred = await joinAs("join-expiry");
    await runInDurableObject(room, (_instance: Room, state) => {
      state.storage.sql.exec("UPDATE sessions SET expires_at = ?", Date.now() - 1);
    });
    expect(await room.me(cred)).toEqual({ ok: false, status: 401, error: "Your session has ended. Join again." });
  });

  it("leave ends the session", async () => {
    const room = await createRoom("join-leave");
    const cred = await joinAs("join-leave");
    expect(await room.leave(cred)).toEqual({ ok: true, value: null });
    expect((await room.me(cred)).ok).toBe(false);
  });

  it("resolves owners without a session", async () => {
    const room = await createRoom("join-owner");
    expect(await room.me(owner)).toEqual({ ok: true, value: { name: "Dimitris", role: "owner" } });
  });
});

describe("changing the PIN", () => {
  it("is owner-only and signs every participant out", async () => {
    const room = await createRoom("join-change");
    const cred = await joinAs("join-change");
    expect(await room.changePin(cred, "999999")).toEqual({ ok: false, status: 403, error: "Only owners can do that" });
    expect(await room.changePin(owner, "999999")).toEqual({ ok: true, value: null });
    expect((await room.me(cred)).ok).toBe(false);
    expect((await room.join({ pin: "482913", name: "K", ip: "198.51.100.9" })).ok).toBe(false);
    expect((await room.join({ pin: "999999", name: "K", ip: "198.51.100.9" })).ok).toBe(true);
    expect((await room.info())?.pin).toBe("999999");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/room-join.test.ts`
Expected: FAIL. `init` is not a function (the skeleton `Room` has no methods), or `../src/room/types` cannot be resolved.

- [ ] **Step 5: Implement the Room object**

`src/room/room.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { constantTimeEqual, newSessionId } from "../ids";
import { JOIN_FAILURES_PER_WINDOW, JOIN_WINDOW_MS, SESSION_MS } from "../limits";
import { fail, ok, type Result } from "../results";
import { countSince, oldestSince, pruneBefore, record } from "./rate";
import { migrate } from "./schema";
import type { Actor, Cred, JoinOk, RoomInfo, RoomRow, SessionRow } from "./types";

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.ctx.storage.sql);
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private room(): RoomRow | null {
    return (
      this.sql
        .exec<RoomRow>("SELECT slug, title, pin, pin_version, archived, bytes_used, created_at FROM room LIMIT 1")
        .toArray()[0] ?? null
    );
  }

  private resolve(cred: Cred, room: RoomRow): Actor | null {
    if (cred.kind === "owner") return { role: "owner", email: cred.email, name: cred.name };
    const session = this.sql
      .exec<SessionRow>("SELECT id, name, pin_version, expires_at FROM sessions WHERE id = ?", cred.sessionId)
      .toArray()[0];
    if (!session || session.expires_at <= Date.now() || session.pin_version !== room.pin_version) return null;
    return { role: "participant", sessionId: session.id, name: session.name };
  }

  private gate(
    cred: Cred,
    opts: { owner?: boolean; write?: boolean } = {},
  ): Result<{ room: RoomRow; actor: Actor }> {
    const room = this.room();
    if (!room) return fail(404, "Room not found");
    const actor = this.resolve(cred, room);
    if (!actor) return fail(401, "Your session has ended. Join again.");
    if (opts.owner && actor.role !== "owner") return fail(403, "Only owners can do that");
    if (opts.write && room.archived) return fail(409, "This room is archived");
    return ok({ room, actor });
  }

  private closeSockets(match: (actor: Actor) => boolean, code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const actor = ws.deserializeAttachment() as Actor | null;
      if (!actor || !match(actor)) continue;
      try {
        ws.close(code, reason);
      } catch {
        // already closing
      }
    }
  }

  // ── Settings and sessions ────────────────────────────────────────────────

  init(input: { slug: string; title: string; pin: string }): Result<null> {
    if (this.room()) return fail(409, "A room with that slug already exists");
    this.sql.exec(
      "INSERT INTO room (slug, title, pin, pin_version, archived, bytes_used, created_at) VALUES (?, ?, ?, 1, 0, 0, ?)",
      input.slug,
      input.title,
      input.pin,
      Date.now(),
    );
    return ok(null);
  }

  info(): RoomInfo | null {
    const room = this.room();
    if (!room) return null;
    const postCount = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM posts").one().n;
    const participantCount = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ? AND pin_version = ?",
        Date.now(),
        room.pin_version,
      )
      .one().n;
    return {
      slug: room.slug,
      title: room.title,
      pin: room.pin,
      archived: room.archived === 1,
      postCount,
      participantCount,
      bytesUsed: room.bytes_used,
      createdAt: room.created_at,
    };
  }

  join(input: { pin: string; name: string; ip: string }): Result<JoinOk> {
    const now = Date.now();
    const since = now - JOIN_WINDOW_MS;
    const bucket = `join:${input.ip}`;
    pruneBefore(this.sql, since);
    if (countSince(this.sql, bucket, since) >= JOIN_FAILURES_PER_WINDOW) {
      const oldest = oldestSince(this.sql, bucket, since) ?? now;
      return fail(429, "Too many attempts", Math.max(1, Math.ceil((oldest + JOIN_WINDOW_MS - now) / 1000)));
    }

    const room = this.room();
    if (!room || !constantTimeEqual(input.pin, room.pin)) {
      record(this.sql, bucket, now);
      return fail(403, "Room or PIN not recognized");
    }

    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    const sessionId = newSessionId();
    this.sql.exec(
      "INSERT INTO sessions (id, name, pin_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      sessionId,
      input.name,
      room.pin_version,
      now,
      now + SESSION_MS,
    );
    return ok({ sessionId, name: input.name, maxAgeSeconds: SESSION_MS / 1000 });
  }

  me(cred: Cred): Result<{ name: string; role: Actor["role"] }> {
    const gated = this.gate(cred);
    if (!gated.ok) return gated;
    return ok({ name: gated.value.actor.name, role: gated.value.actor.role });
  }

  leave(cred: Cred): Result<null> {
    if (cred.kind !== "session") return ok(null);
    this.sql.exec("DELETE FROM sessions WHERE id = ?", cred.sessionId);
    this.closeSockets((a) => a.role === "participant" && a.sessionId === cred.sessionId, 4401, "Left the room");
    return ok(null);
  }

  changePin(cred: Cred, pin: string): Result<null> {
    const gated = this.gate(cred, { owner: true });
    if (!gated.ok) return gated;
    this.sql.exec("UPDATE room SET pin = ?, pin_version = pin_version + 1", pin);
    this.sql.exec("DELETE FROM sessions");
    this.closeSockets((a) => a.role === "participant", 4401, "PIN changed");
    return ok(null);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/room-join.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: every test file passes; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/room test/room-join.test.ts
git commit -m "Add Room settings, PIN join, sessions and join rate limit"
```

---

### Task 6: Room object — posts and live sockets

**Files:**
- Create: `src/room/wire.ts`
- Modify: `src/room/room.ts` (import block; new private helpers; new methods)
- Test: `test/room-live.test.ts`

**Interfaces:**
- Consumes:
  - Task 5's `gate()`, `room()`, `resolve()`, `closeSockets()`, rate helpers and types.
  - `newPostId` (`src/ids.ts`); `POSTS_PER_MINUTE`, `POST_WINDOW_MS` (`src/limits.ts`).
  - `acceptSocket` (`test/helpers.ts`).
- Produces:
  - **`toWirePost(row: PostRow, slug: string, viewer: Actor): WirePost`**
  - **`Room` RPC methods:**
    - `addText(cred, text): Result<{id}>`
    - `deletePost(cred, id): Promise<Result<null>>`
    - `setPinned(cred, id, pinned): Result<null>`
    - `update(cred, {title?, archived?}): Result<null>`
    - `destroy(cred): Promise<Result<null>>`
  - **`Room.fetch(request)`:** WebSocket upgrade. It requires `Upgrade: websocket` and an `X-Clip-Cred` header holding `JSON.stringify(cred)`, and returns 101, 400, 401, 404 or 426.
  - **Private helpers Task 7 uses:** `post(id)`, `authorColumns(actor)`, `takePostSlot(actor)`, `broadcast(msg, except?)`, `broadcastPost(row, slug)`.
- **New error messages** (exact):
  - `Post not found` (404)
  - `You can only delete your own posts` (403)
  - `Too many posts. Wait a moment.` (429)

- [ ] **Step 1: Write the failing tests**

`test/room-live.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ownerCred, type Cred, type WirePost } from "../src/room/types";
import { acceptSocket, OWNER, type TestSocket } from "./helpers";

const owner = ownerCred(OWNER);
const stub = (slug: string) => env.ROOMS.getByName(slug);

async function createRoom(slug: string) {
  expect((await stub(slug).init({ slug, title: "Live room", pin: "482913" })).ok).toBe(true);
  return stub(slug);
}

async function joinAs(slug: string, name: string): Promise<Cred> {
  const joined = await stub(slug).join({ pin: "482913", name, ip: "198.51.100.20" });
  if (!joined.ok) throw new Error(joined.error);
  return { kind: "session", sessionId: joined.value.sessionId };
}

function openSocket(slug: string, cred: Cred): Promise<Response> {
  return stub(slug).fetch("https://room.internal/live", {
    headers: { Upgrade: "websocket", "X-Clip-Cred": JSON.stringify(cred) },
  });
}

async function connect(slug: string, cred: Cred): Promise<TestSocket> {
  const res = await openSocket(slug, cred);
  expect(res.status).toBe(101);
  return acceptSocket(res);
}

describe("live board", () => {
  it("sends a snapshot, then each post with a per-viewer mine flag", async () => {
    await createRoom("live-mine");
    const kristi = await joinAs("live-mine", "Kristi");
    const jani = await joinAs("live-mine", "Jani");
    const a = await connect("live-mine", kristi);
    const b = await connect("live-mine", jani);
    const o = await connect("live-mine", owner);

    expect(await a.nextOfType("snapshot")).toMatchObject({
      room: { slug: "live-mine", title: "Live room", archived: false },
      you: { name: "Kristi", role: "participant" },
      posts: [],
    });
    expect((await o.nextOfType("snapshot")).you).toEqual({ name: "Dimitris", role: "owner" });

    expect((await stub("live-mine").addText(kristi, "claude --model sonnet")).ok).toBe(true);
    const [pa, pb, po] = await Promise.all([
      a.nextOfType("post.added"),
      b.nextOfType("post.added"),
      o.nextOfType("post.added"),
    ]);
    expect(pa.post).toMatchObject({
      kind: "text",
      text: "claude --model sonnet",
      authorName: "Kristi",
      authorRole: "participant",
      pinned: false,
      pinnedAt: null,
      mine: true,
    });
    expect((pb.post as WirePost).mine).toBe(false);
    expect((po.post as WirePost).mine).toBe(false);
    if (kristi.kind !== "session") throw new Error("expected a session");
    expect(JSON.stringify(pa)).not.toContain(kristi.sessionId);
  });

  it("lists existing posts newest first and broadcasts the online count", async () => {
    await createRoom("live-order");
    const kristi = await joinAs("live-order", "Kristi");
    await stub("live-order").addText(kristi, "first");
    await stub("live-order").addText(kristi, "second");

    const a = await connect("live-order", kristi);
    const snapshot = await a.nextOfType("snapshot");
    expect((snapshot.posts as WirePost[]).map((p) => p.text)).toEqual(["second", "first"]);
    expect(await a.nextOfType("online")).toEqual({ type: "online", count: 1 });

    const b = await connect("live-order", owner);
    expect(await a.nextOfType("online")).toEqual({ type: "online", count: 2 });
    b.ws.close(1000, "done");
    expect(await a.nextOfType("online")).toEqual({ type: "online", count: 1 });
  });

  it("lets authors delete their own posts and owners delete any", async () => {
    await createRoom("live-delete");
    const kristi = await joinAs("live-delete", "Kristi");
    const jani = await joinAs("live-delete", "Jani");
    const a = await connect("live-delete", kristi);
    const kp = await stub("live-delete").addText(kristi, "kristi's");
    const jp = await stub("live-delete").addText(jani, "jani's");
    if (!kp.ok || !jp.ok) throw new Error("posting failed");

    expect(await stub("live-delete").deletePost(jani, kp.value.id)).toEqual({
      ok: false,
      status: 403,
      error: "You can only delete your own posts",
    });
    expect(await stub("live-delete").deletePost(kristi, kp.value.id)).toEqual({ ok: true, value: null });
    expect(await a.nextOfType("post.deleted")).toEqual({ type: "post.deleted", id: kp.value.id });
    expect(await stub("live-delete").deletePost(owner, jp.value.id)).toEqual({ ok: true, value: null });
    expect(await stub("live-delete").deletePost(owner, "missing")).toEqual({
      ok: false,
      status: 404,
      error: "Post not found",
    });
  });

  it("only owners pin, and pins are broadcast and kept in snapshots", async () => {
    await createRoom("live-pin");
    const kristi = await joinAs("live-pin", "Kristi");
    const a = await connect("live-pin", kristi);
    const posted = await stub("live-pin").addText(owner, "https://github.com/dimitris-am/agna-starter");
    if (!posted.ok) throw new Error(posted.error);

    expect(await stub("live-pin").setPinned(kristi, posted.value.id, true)).toEqual({
      ok: false,
      status: 403,
      error: "Only owners can do that",
    });
    expect(await stub("live-pin").setPinned(owner, posted.value.id, true)).toEqual({ ok: true, value: null });
    const pinned = await a.nextOfType("post.pinned");
    expect(pinned).toMatchObject({ id: posted.value.id, pinned: true });
    expect(typeof pinned.pinnedAt).toBe("number");

    const later = await connect("live-pin", kristi);
    const snapshot = await later.nextOfType("snapshot");
    expect((snapshot.posts as WirePost[])[0]).toMatchObject({ pinned: true, authorRole: "owner", mine: false });
  });

  it("archiving closes posting for everyone but keeps owner moderation", async () => {
    await createRoom("live-archive");
    const kristi = await joinAs("live-archive", "Kristi");
    const a = await connect("live-archive", kristi);
    const kp = await stub("live-archive").addText(kristi, "before archive");
    if (!kp.ok) throw new Error(kp.error);

    expect(await stub("live-archive").update(kristi, { archived: true })).toEqual({
      ok: false,
      status: 403,
      error: "Only owners can do that",
    });
    expect(await stub("live-archive").update(owner, { archived: true, title: "Renamed" })).toEqual({
      ok: true,
      value: null,
    });
    expect(await a.nextOfType("room.updated")).toEqual({
      type: "room.updated",
      room: { title: "Renamed", archived: true },
    });

    const archived = { ok: false, status: 409, error: "This room is archived" };
    expect(await stub("live-archive").addText(kristi, "after")).toEqual(archived);
    expect(await stub("live-archive").addText(owner, "after")).toEqual(archived);
    expect(await stub("live-archive").deletePost(kristi, kp.value.id)).toEqual(archived);
    expect((await stub("live-archive").deletePost(owner, kp.value.id)).ok).toBe(true);
  });

  it("changing the PIN closes participant sockets with 4401 and keeps owners connected", async () => {
    await createRoom("live-pinchange");
    const kristi = await joinAs("live-pinchange", "Kristi");
    const a = await connect("live-pinchange", kristi);
    const o = await connect("live-pinchange", owner);
    await o.nextOfType("snapshot");

    expect((await stub("live-pinchange").changePin(owner, "777777")).ok).toBe(true);
    expect(await a.closed()).toEqual({ code: 4401, reason: "PIN changed" });
    expect((await stub("live-pinchange").addText(owner, "still here")).ok).toBe(true);
    expect((await o.nextOfType("post.added")).post).toMatchObject({ text: "still here", mine: true });
  });

  it("leaving closes that person's sockets with 4401", async () => {
    await createRoom("live-leave");
    const kristi = await joinAs("live-leave", "Kristi");
    const a = await connect("live-leave", kristi);
    await stub("live-leave").leave(kristi);
    expect(await a.closed()).toEqual({ code: 4401, reason: "Left the room" });
  });

  it("refuses sockets for ended sessions, unknown rooms and plain requests", async () => {
    await createRoom("live-refuse");
    const ended = await openSocket("live-refuse", { kind: "session", sessionId: "0".repeat(32) });
    expect(ended.status).toBe(401);
    await ended.body?.cancel();

    const ghost = await openSocket("live-ghost", owner);
    expect(ghost.status).toBe(404);
    await ghost.body?.cancel();

    const plain = await stub("live-refuse").fetch("https://room.internal/live");
    expect(plain.status).toBe(426);
    await plain.body?.cancel();
  });

  it("limits posts to 30 per minute per person", async () => {
    await createRoom("live-rate");
    const kristi = await joinAs("live-rate", "Kristi");
    for (let i = 0; i < 30; i++) {
      expect((await stub("live-rate").addText(kristi, `post ${i}`)).ok).toBe(true);
    }
    expect(await stub("live-rate").addText(kristi, "one too many")).toMatchObject({
      ok: false,
      status: 429,
      error: "Too many posts. Wait a moment.",
    });
    expect((await stub("live-rate").addText(owner, "owner unaffected")).ok).toBe(true);
  });

  it("destroy closes sockets with 4404, forgets the room and is idempotent", async () => {
    await createRoom("live-destroy");
    const kristi = await joinAs("live-destroy", "Kristi");
    const a = await connect("live-destroy", kristi);
    await stub("live-destroy").addText(kristi, "doomed");

    expect(await stub("live-destroy").destroy(kristi)).toEqual({
      ok: false,
      status: 403,
      error: "Only owners can do that",
    });
    expect(await stub("live-destroy").destroy(owner)).toEqual({ ok: true, value: null });
    expect(await a.closed()).toEqual({ code: 4404, reason: "Room deleted" });
    expect(await stub("live-destroy").info()).toBeNull();
    expect(await stub("live-destroy").destroy(owner)).toEqual({ ok: true, value: null });
    expect((await stub("live-destroy").init({ slug: "live-destroy", title: "Again", pin: "482913" })).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/room-live.test.ts`
Expected: FAIL. `addText` is not a function, and `fetch` returns a non-101 response.

- [ ] **Step 3: Create `src/room/wire.ts`**

```ts
import type { Actor, PostRow, WirePost } from "./types";

/** Shapes one stored post for one viewer. Session IDs and emails never leave the server. */
export function toWirePost(row: PostRow, slug: string, viewer: Actor): WirePost {
  const mine =
    viewer.role === "owner" ? row.author_email === viewer.email : row.author_session === viewer.sessionId;
  const base = {
    id: row.id,
    authorName: row.author_name,
    authorRole: row.author_role === "owner" ? ("owner" as const) : ("participant" as const),
    createdAt: row.created_at,
    pinned: row.pinned === 1,
    pinnedAt: row.pinned_at,
    mine,
  };
  if (row.kind === "file") {
    return {
      ...base,
      kind: "file",
      file: {
        name: row.file_name ?? "file",
        size: row.file_size ?? 0,
        type: row.file_type ?? "application/octet-stream",
        url: `/r/${slug}/files/${row.id}`,
      },
    };
  }
  return { ...base, kind: "text", text: row.text ?? "" };
}
```

- [ ] **Step 4: Update the import block of `src/room/room.ts`**

Replace the existing imports at the top of the file with:

```ts
import { DurableObject } from "cloudflare:workers";
import { constantTimeEqual, newPostId, newSessionId } from "../ids";
import { JOIN_FAILURES_PER_WINDOW, JOIN_WINDOW_MS, POST_WINDOW_MS, POSTS_PER_MINUTE, SESSION_MS } from "../limits";
import { fail, ok, type Fail, type Result } from "../results";
import { countSince, oldestSince, pruneBefore, record } from "./rate";
import { migrate } from "./schema";
import type { Actor, Cred, JoinOk, PostRow, RoomInfo, RoomRow, ServerMessage, SessionRow } from "./types";
import { toWirePost } from "./wire";
```

- [ ] **Step 5: Add the private helpers**

Insert these methods directly after `closeSockets` (still inside the `// ── Internals` section):

```ts
  private post(id: string): PostRow | null {
    return this.sql.exec<PostRow>("SELECT * FROM posts WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** [author_name, author_role, author_session, author_email] */
  private authorColumns(actor: Actor): [string, string, string | null, string | null] {
    return actor.role === "owner"
      ? [actor.name, "owner", null, actor.email]
      : [actor.name, "participant", actor.sessionId, null];
  }

  /** Records one post or upload, or returns a 429 when the per-minute limit is reached. */
  private takePostSlot(actor: Actor): Fail | null {
    const now = Date.now();
    const since = now - POST_WINDOW_MS;
    const bucket = actor.role === "owner" ? `post:owner:${actor.email}` : `post:session:${actor.sessionId}`;
    pruneBefore(this.sql, now - JOIN_WINDOW_MS);
    if (countSince(this.sql, bucket, since) >= POSTS_PER_MINUTE) {
      const oldest = oldestSince(this.sql, bucket, since) ?? now;
      return fail(429, "Too many posts. Wait a moment.", Math.max(1, Math.ceil((oldest + POST_WINDOW_MS - now) / 1000)));
    }
    record(this.sql, bucket, now);
    return null;
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // closed between getWebSockets() and send()
      }
    }
  }

  /** Sends post.added to every socket, with `mine` computed for that socket's viewer. */
  private broadcastPost(row: PostRow, slug: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const viewer = ws.deserializeAttachment() as Actor | null;
      if (!viewer) continue;
      const msg: ServerMessage = { type: "post.added", post: toWirePost(row, slug, viewer) };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // closed between getWebSockets() and send()
      }
    }
  }

  private snapshot(room: RoomRow, actor: Actor): ServerMessage {
    const rows = this.sql.exec<PostRow>("SELECT * FROM posts ORDER BY created_at DESC, rowid DESC").toArray();
    return {
      type: "snapshot",
      room: { slug: room.slug, title: room.title, archived: room.archived === 1 },
      you: { name: actor.name, role: actor.role },
      online: this.ctx.getWebSockets().length,
      posts: rows.map((row) => toWirePost(row, room.slug, actor)),
    };
  }
```

- [ ] **Step 6: Add the live-connection handlers and post methods**

Append inside the class, after `changePin`:

```ts
  // ── Live connections ─────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    let cred: Cred;
    try {
      cred = JSON.parse(request.headers.get("X-Clip-Cred") ?? "") as Cred;
    } catch {
      return new Response("Missing credentials", { status: 400 });
    }
    const room = this.room();
    if (!room) return new Response("Room not found", { status: 404 });
    const actor = this.resolve(cred, room);
    if (!actor) return new Response("Your session has ended. Join again.", { status: 401 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(actor);
    server.send(JSON.stringify(this.snapshot(room, actor)));
    this.broadcast({ type: "online", count: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // Clients send nothing; every change arrives over HTTP.
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const count = this.ctx.getWebSockets().filter((socket) => socket !== ws).length;
    this.broadcast({ type: "online", count }, ws);
  }

  // ── Posts ────────────────────────────────────────────────────────────────

  addText(cred: Cred, text: string): Result<{ id: string }> {
    const gated = this.gate(cred, { write: true });
    if (!gated.ok) return gated;
    const { room, actor } = gated.value;
    const limited = this.takePostSlot(actor);
    if (limited) return limited;

    const id = newPostId();
    const [name, role, session, email] = this.authorColumns(actor);
    this.sql.exec(
      "INSERT INTO posts (id, kind, text, author_name, author_role, author_session, author_email, created_at) VALUES (?, 'text', ?, ?, ?, ?, ?, ?)",
      id,
      text,
      name,
      role,
      session,
      email,
      Date.now(),
    );
    this.broadcastPost(this.post(id)!, room.slug);
    return ok({ id });
  }

  async deletePost(cred: Cred, id: string): Promise<Result<null>> {
    const gated = this.gate(cred);
    if (!gated.ok) return gated;
    const { room, actor } = gated.value;
    const row = this.post(id);
    if (!row) return fail(404, "Post not found");
    if (actor.role !== "owner") {
      if (row.author_session !== actor.sessionId) return fail(403, "You can only delete your own posts");
      if (room.archived) return fail(409, "This room is archived");
    }

    this.sql.exec("DELETE FROM posts WHERE id = ?", id);
    if (row.kind === "file") {
      this.sql.exec("UPDATE room SET bytes_used = MAX(0, bytes_used - ?)", row.file_size ?? 0);
      if (row.r2_key) {
        try {
          await this.env.FILES.delete(row.r2_key);
        } catch (err) {
          console.error("R2 delete failed", row.r2_key, err);
        }
      }
    }
    this.broadcast({ type: "post.deleted", id });
    return ok(null);
  }

  setPinned(cred: Cred, id: string, pinned: boolean): Result<null> {
    const gated = this.gate(cred, { owner: true });
    if (!gated.ok) return gated;
    if (!this.post(id)) return fail(404, "Post not found");
    const pinnedAt = pinned ? Date.now() : null;
    this.sql.exec("UPDATE posts SET pinned = ?, pinned_at = ? WHERE id = ?", pinned ? 1 : 0, pinnedAt, id);
    this.broadcast({ type: "post.pinned", id, pinned, pinnedAt });
    return ok(null);
  }

  update(cred: Cred, patch: { title?: string; archived?: boolean }): Result<null> {
    const gated = this.gate(cred, { owner: true });
    if (!gated.ok) return gated;
    if (patch.title !== undefined) this.sql.exec("UPDATE room SET title = ?", patch.title);
    if (patch.archived !== undefined) this.sql.exec("UPDATE room SET archived = ?", patch.archived ? 1 : 0);
    const room = this.room()!;
    this.broadcast({ type: "room.updated", room: { title: room.title, archived: room.archived === 1 } });
    return ok(null);
  }

  /** Owner-only and idempotent. The Worker removes R2 files and the D1 row afterwards. */
  async destroy(cred: Cred): Promise<Result<null>> {
    if (cred.kind !== "owner") return fail(403, "Only owners can do that");
    this.closeSockets(() => true, 4404, "Room deleted");
    await this.ctx.storage.deleteAll();
    migrate(this.sql);
    return ok(null);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/room-live.test.ts`
Expected: PASS. Hibernation logs from one test may print under the next test's name; that is harmless.

Run: `npm test && npm run typecheck`
Expected: all green; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/room test/room-live.test.ts
git commit -m "Add posts, pins, archiving and live WebSocket broadcasts to Room"
```

---

### Task 7: Room object — files

**Files:**
- Modify: `src/room/room.ts` (limits import; new methods)
- Test: `test/room-files.test.ts`

**Interfaces:**
- Consumes:
  - Task 6's `gate()`, `post()`, `authorColumns()`, `takePostSlot()`, `broadcastPost()`
  - `MAX_FILE_BYTES`, `ROOM_QUOTA_BYTES` (`src/limits.ts`)
  - `FileMeta`, `FileRef`, `UploadGrant` (`src/room/types.ts`)
- Produces `Room` RPC methods:
  - `authorizeUpload(cred, size: number, name: string): Result<UploadGrant>`: `name` must already be sanitized; the key is `rooms/<slug>/<postId>/<name>`
  - `commitFile(cred, meta: FileMeta): Result<{id}>`
  - `getFile(cred, postId): Result<FileRef>`
- New error messages (exact):
  - `Files can be at most 25 MB` (413)
  - `This room's file storage is full` (413)
  - `Choose a file that is not empty` (400)
  - `Upload does not match its grant` (400)
  - `File not found` (404)

- [ ] **Step 1: Write the failing tests**

`test/room-files.test.ts`:

```ts
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, ROOM_QUOTA_BYTES } from "../src/limits";
import type { Room } from "../src/room/room";
import { ownerCred, type Cred } from "../src/room/types";
import { acceptSocket, OWNER } from "./helpers";

const owner = ownerCred(OWNER);
const stub = (slug: string) => env.ROOMS.getByName(slug);

async function createRoom(slug: string) {
  expect((await stub(slug).init({ slug, title: "Files room", pin: "482913" })).ok).toBe(true);
  return stub(slug);
}

async function joinAs(slug: string): Promise<Cred> {
  const joined = await stub(slug).join({ pin: "482913", name: "Kristi", ip: "198.51.100.40" });
  if (!joined.ok) throw new Error(joined.error);
  return { kind: "session", sessionId: joined.value.sessionId };
}

describe("room files", () => {
  it("grants an upload, commits it and broadcasts a file post", async () => {
    const room = await createRoom("files-commit");
    const kristi = await joinAs("files-commit");
    const res = await room.fetch("https://room.internal/live", {
      headers: { Upgrade: "websocket", "X-Clip-Cred": JSON.stringify(kristi) },
    });
    const socket = acceptSocket(res);

    const grant = await room.authorizeUpload(kristi, 1234, "report.pdf");
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.value.r2Key).toBe(`rooms/files-commit/${grant.value.postId}/report.pdf`);

    const commit = await room.commitFile(kristi, {
      postId: grant.value.postId,
      r2Key: grant.value.r2Key,
      name: "report.pdf",
      size: 1234,
      type: "application/pdf",
    });
    expect(commit).toEqual({ ok: true, value: { id: grant.value.postId } });

    expect((await socket.nextOfType("post.added")).post).toMatchObject({
      kind: "file",
      file: {
        name: "report.pdf",
        size: 1234,
        type: "application/pdf",
        url: `/r/files-commit/files/${grant.value.postId}`,
      },
      mine: true,
    });
    expect((await room.info())?.bytesUsed).toBe(1234);
    expect(await room.getFile(kristi, grant.value.postId)).toEqual({
      ok: true,
      value: { r2Key: grant.value.r2Key, name: "report.pdf", type: "application/pdf" },
    });
  });

  it("enforces the file size limit and the room quota", async () => {
    const room = await createRoom("files-limits");
    const kristi = await joinAs("files-limits");
    expect(await room.authorizeUpload(kristi, MAX_FILE_BYTES + 1, "big.bin")).toEqual({
      ok: false,
      status: 413,
      error: "Files can be at most 25 MB",
    });
    expect(await room.authorizeUpload(kristi, 0, "empty.bin")).toEqual({
      ok: false,
      status: 400,
      error: "Choose a file that is not empty",
    });

    await runInDurableObject(room, (_instance: Room, state) => {
      state.storage.sql.exec("UPDATE room SET bytes_used = ?", ROOM_QUOTA_BYTES - 10);
    });
    expect(await room.authorizeUpload(kristi, 11, "a.txt")).toEqual({
      ok: false,
      status: 413,
      error: "This room's file storage is full",
    });
    expect((await room.authorizeUpload(kristi, 10, "a.txt")).ok).toBe(true);
  });

  it("rejects a commit that does not match its grant", async () => {
    const room = await createRoom("files-mismatch");
    const grant = await room.authorizeUpload(owner, 5, "a.txt");
    if (!grant.ok) throw new Error(grant.error);
    expect(
      await room.commitFile(owner, {
        postId: grant.value.postId,
        r2Key: `rooms/other-room/${grant.value.postId}/a.txt`,
        name: "a.txt",
        size: 5,
        type: "text/plain",
      }),
    ).toEqual({ ok: false, status: 400, error: "Upload does not match its grant" });
  });

  it("closes uploads in archived rooms", async () => {
    const room = await createRoom("files-archived");
    const kristi = await joinAs("files-archived");
    await room.update(owner, { archived: true });
    expect(await room.authorizeUpload(kristi, 5, "a.txt")).toEqual({
      ok: false,
      status: 409,
      error: "This room is archived",
    });
  });

  it("deleting a file post removes the R2 object and frees quota", async () => {
    const room = await createRoom("files-delete");
    const kristi = await joinAs("files-delete");
    const grant = await room.authorizeUpload(kristi, 5, "hello.txt");
    if (!grant.ok) throw new Error(grant.error);
    await env.FILES.put(grant.value.r2Key, "hello");
    await room.commitFile(kristi, { ...grant.value, name: "hello.txt", size: 5, type: "text/plain" });

    expect(await room.deletePost(kristi, grant.value.postId)).toEqual({ ok: true, value: null });
    expect(await env.FILES.get(grant.value.r2Key)).toBeNull();
    expect((await room.info())?.bytesUsed).toBe(0);
  });

  it("getFile returns 404 for text posts and missing posts", async () => {
    const room = await createRoom("files-lookup");
    const text = await room.addText(owner, "not a file");
    if (!text.ok) throw new Error(text.error);
    const notFound = { ok: false, status: 404, error: "File not found" };
    expect(await room.getFile(owner, text.value.id)).toEqual(notFound);
    expect(await room.getFile(owner, "missing")).toEqual(notFound);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/room-files.test.ts`
Expected: FAIL, because `authorizeUpload` is not a function.

- [ ] **Step 3: Update the limits import**

In `src/room/room.ts`, replace the limits import line with:

```ts
import {
  JOIN_FAILURES_PER_WINDOW,
  JOIN_WINDOW_MS,
  MAX_FILE_BYTES,
  POST_WINDOW_MS,
  POSTS_PER_MINUTE,
  ROOM_QUOTA_BYTES,
  SESSION_MS,
} from "../limits";
```

and replace the types import line with:

```ts
import type {
  Actor,
  Cred,
  FileMeta,
  FileRef,
  JoinOk,
  PostRow,
  RoomInfo,
  RoomRow,
  ServerMessage,
  SessionRow,
  UploadGrant,
} from "./types";
```

- [ ] **Step 4: Add the file methods**

Append inside the class, after `destroy`:

```ts
  // ── Files ────────────────────────────────────────────────────────────────

  authorizeUpload(cred: Cred, size: number, name: string): Result<UploadGrant> {
    const gated = this.gate(cred, { write: true });
    if (!gated.ok) return gated;
    const { room, actor } = gated.value;
    if (!Number.isInteger(size) || size < 1) return fail(400, "Choose a file that is not empty");
    if (size > MAX_FILE_BYTES) return fail(413, "Files can be at most 25 MB");
    if (room.bytes_used + size > ROOM_QUOTA_BYTES) return fail(413, "This room's file storage is full");
    const limited = this.takePostSlot(actor);
    if (limited) return limited;
    const postId = newPostId();
    return ok({ postId, r2Key: `rooms/${room.slug}/${postId}/${name}` });
  }

  commitFile(cred: Cred, meta: FileMeta): Result<{ id: string }> {
    const gated = this.gate(cred, { write: true });
    if (!gated.ok) return gated;
    const { room, actor } = gated.value;
    if (meta.r2Key !== `rooms/${room.slug}/${meta.postId}/${meta.name}`) {
      return fail(400, "Upload does not match its grant");
    }
    if (room.bytes_used + meta.size > ROOM_QUOTA_BYTES) return fail(413, "This room's file storage is full");

    const [name, role, session, email] = this.authorColumns(actor);
    this.sql.exec(
      "INSERT INTO posts (id, kind, file_name, file_size, file_type, r2_key, author_name, author_role, author_session, author_email, created_at) VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      meta.postId,
      meta.name,
      meta.size,
      meta.type,
      meta.r2Key,
      name,
      role,
      session,
      email,
      Date.now(),
    );
    this.sql.exec("UPDATE room SET bytes_used = bytes_used + ?", meta.size);
    this.broadcastPost(this.post(meta.postId)!, room.slug);
    return ok({ id: meta.postId });
  }

  getFile(cred: Cred, postId: string): Result<FileRef> {
    const gated = this.gate(cred);
    if (!gated.ok) return gated;
    const row = this.post(postId);
    if (!row || row.kind !== "file" || !row.r2_key) return fail(404, "File not found");
    return ok({
      r2Key: row.r2_key,
      name: row.file_name ?? "file",
      type: row.file_type ?? "application/octet-stream",
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/room-files.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: all green; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/room/room.ts test/room-files.test.ts
git commit -m "Add upload grants, file posts and room quota to Room"
```

---

### Task 8: Worker board routes

Connects both hostnames to the Room object. After this task every `/r/:slug/*` route in spec §6 works over HTTP and WebSocket.

**Files:**
- Create: `src/http.ts`, `src/upload.ts`, `src/board-api.ts`
- Replace: `src/index.ts`
- Modify: `test/helpers.ts` (append request helpers)
- Test: `test/upload.test.ts`, `test/board-api.test.ts`

**Interfaces:**
- Consumes:
  - Every Room RPC method from Tasks 5–7
  - `authenticateOwner`, `Owner` (Task 4)
  - `isSlug`, `parseName`, `parsePostText` (Task 3)
  - `downloadHeaders`, `sanitizeFileName`, `normalizeContentType` (Task 3)
  - `isSessionId` (Task 3)
- Produces:
  - `http.ts`:
    - `json`, `notFound`, `errorResponse(fail)`, `readJson`
    - `isSameOrigin(request)`, `readCookie`, `sessionCookie`, `clearedSessionCookie`, `SESSION_COOKIE`
    - `contentSecurityPolicy(url)`, `servePage(request, assets, page)`, `serveAsset(request, assets)`
  - `upload.ts`: `type UploadRoom`, `uploadFile(request, files, room, cred): Promise<Response>`
  - `board-api.ts`: `type Door = "public" | "admin"`, `type BoardContext`, `handleBoard(request, env, ctx): Promise<Response>`
  - Test helpers: `publicFetch(path, init?)`, `adminFetch(path, init?)`, `makeRoom(slug, pin?)`, `joinRoom(slug, name?, ip?): Promise<string>` (returns the `clip_session=<id>` cookie pair)
- New error messages (exact):
  - `Cross-site request refused` (403)
  - `Owner sign-in required` (401)
  - `Not found` (404)
  - `Join the room first` (401)
  - `Enter a name of 1 to 40 characters` (400)
  - `Posts must be 1 to 20,000 characters and not only spaces` (400)
  - `Expected a WebSocket upgrade` (426)
  - `Send pinned as true or false` (400)
  - `The file name could not be read` (400)
  - `The upload did not complete` (400)
  - `The upload could not be saved` (500)

- [ ] **Step 1: Write the failing upload test**

`test/upload.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../src/limits";
import { fail, ok } from "../src/results";
import type { Cred, FileMeta } from "../src/room/types";
import { uploadFile, type UploadRoom } from "../src/upload";

const cred: Cred = { kind: "session", sessionId: "a".repeat(32) };

function uploadRequest(bytes: Uint8Array, name = "notes.txt"): Request {
  return new Request("http://localhost:8787/r/upload-unit/api/files", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "X-File-Name": encodeURIComponent(name),
    },
    body: bytes,
  });
}

const untouchable: UploadRoom = {
  authorizeUpload: async () => {
    throw new Error("authorizeUpload should not be called");
  },
  commitFile: async () => {
    throw new Error("commitFile should not be called");
  },
};

describe("uploadFile", () => {
  it("stores the file under its grant, then commits it", async () => {
    const commits: FileMeta[] = [];
    const room: UploadRoom = {
      authorizeUpload: async (_c, _size, name) => ok({ postId: "p1", r2Key: `rooms/upload-unit/p1/${name}` }),
      commitFile: async (_c, meta) => {
        commits.push(meta);
        return ok({ id: meta.postId });
      },
    };
    const res = await uploadFile(uploadRequest(new TextEncoder().encode("hello"), "../notes.txt"), env.FILES, room, cred);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "p1" });
    expect(commits).toEqual([
      { postId: "p1", r2Key: "rooms/upload-unit/p1/notes.txt", name: "notes.txt", size: 5, type: "text/plain" },
    ]);
    const stored = await env.FILES.get("rooms/upload-unit/p1/notes.txt");
    expect(await stored?.text()).toBe("hello");
    expect(stored?.httpMetadata?.contentType).toBe("text/plain");
  });

  it("deletes the stored file when the commit fails", async () => {
    const room: UploadRoom = {
      authorizeUpload: async () => ok({ postId: "p2", r2Key: "rooms/upload-unit/p2/notes.txt" }),
      commitFile: async () => fail(409, "This room is archived"),
    };
    const res = await uploadFile(uploadRequest(new TextEncoder().encode("hello")), env.FILES, room, cred);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This room is archived" });
    expect(await env.FILES.get("rooms/upload-unit/p2/notes.txt")).toBeNull();
  });

  it("returns the room's refusal without storing anything", async () => {
    const room: UploadRoom = {
      authorizeUpload: async () => fail(413, "This room's file storage is full"),
      commitFile: untouchable.commitFile,
    };
    const res = await uploadFile(uploadRequest(new TextEncoder().encode("hello")), env.FILES, room, cred);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "This room's file storage is full" });
  });

  it("rejects oversized and empty uploads before asking the room", async () => {
    const tooBig = await uploadFile(uploadRequest(new Uint8Array(MAX_FILE_BYTES + 1)), env.FILES, untouchable, cred);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ error: "Files can be at most 25 MB" });

    const empty = await uploadFile(uploadRequest(new Uint8Array(0)), env.FILES, untouchable, cred);
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Choose a file that is not empty" });
  });
});
```

- [ ] **Step 2: Run the upload test to verify it fails**

Run: `npx vitest run test/upload.test.ts`
Expected: FAIL. `../src/upload` cannot be resolved.

- [ ] **Step 3: Create `src/http.ts`**

```ts
import type { Fail } from "./results";

export const SESSION_COOKIE = "clip_session";

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

export function errorResponse(failure: Fail): Response {
  if (failure.retryAfter === undefined) return json({ error: failure.error }, failure.status);
  return json({ error: failure.error, retryAfter: failure.retryAfter }, failure.status, {
    "Retry-After": String(failure.retryAfter),
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** GET and HEAD pass; every other method and every WebSocket upgrade must come from this origin. */
export function isSameOrigin(request: Request): boolean {
  const upgrade = request.headers.get("Upgrade") === "websocket";
  if (!upgrade && (request.method === "GET" || request.method === "HEAD")) return true;
  return request.headers.get("Origin") === new URL(request.url).origin;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(slug: string, sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/r/${slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(slug: string): string {
  return `${SESSION_COOKIE}=; Path=/r/${slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function contentSecurityPolicy(url: URL): string {
  const wsOrigin = url.origin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src 'self' ${wsOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export type Page = "home.html" | "board.html" | "admin.html";

export async function servePage(request: Request, assets: Fetcher, page: Page): Promise<Response> {
  const url = new URL(request.url);
  const asset = await assets.fetch(new URL(`/${page}`, url));
  if (!asset.ok) return notFound();
  return new Response(asset.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": contentSecurityPolicy(url),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-cache",
    },
  });
}

/** Serves /assets/<name>.js and /assets/<name>.css only; HTML files are never served directly. */
export async function serveAsset(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  if (!/^\/assets\/[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return notFound();
  const asset = await assets.fetch(new URL(url.pathname, url));
  if (!asset.ok) return notFound();
  const headers = new Headers(asset.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-cache");
  return new Response(asset.body, { status: 200, headers });
}
```

- [ ] **Step 4: Create `src/upload.ts`**

```ts
import { normalizeContentType, sanitizeFileName } from "./files";
import { errorResponse, json } from "./http";
import { MAX_FILE_BYTES } from "./limits";
import type { Result } from "./results";
import type { Cred, FileMeta, UploadGrant } from "./room/types";

/** The two Room methods an upload needs; tests pass fakes. */
export type UploadRoom = {
  authorizeUpload(cred: Cred, size: number, name: string): Promise<Result<UploadGrant>>;
  commitFile(cred: Cred, meta: FileMeta): Promise<Result<{ id: string }>>;
};

/** authorize → stream to R2 → commit; deletes the R2 object if anything after storing fails. */
export async function uploadFile(request: Request, files: R2Bucket, room: UploadRoom, cred: Cred): Promise<Response> {
  const size = Number(request.headers.get("Content-Length"));
  if (!request.body || !Number.isInteger(size) || size < 1) {
    return json({ error: "Choose a file that is not empty" }, 400);
  }
  if (size > MAX_FILE_BYTES) return json({ error: "Files can be at most 25 MB" }, 413);

  let rawName: string;
  try {
    rawName = decodeURIComponent(request.headers.get("X-File-Name") ?? "");
  } catch {
    return json({ error: "The file name could not be read" }, 400);
  }
  const name = sanitizeFileName(rawName);
  const type = normalizeContentType(request.headers.get("Content-Type"));

  const grant = await room.authorizeUpload(cred, size, name);
  if (!grant.ok) return errorResponse(grant);
  const { postId, r2Key } = grant.value;

  // A raw request.body fails R2 with "Provided readable stream must have a known length".
  const { readable, writable } = new FixedLengthStream(size);
  try {
    await Promise.all([
      request.body.pipeTo(writable),
      files.put(r2Key, readable, { httpMetadata: { contentType: type } }),
    ]);
  } catch {
    await files.delete(r2Key);
    return json({ error: "The upload did not complete" }, 400);
  }

  let committed: Result<{ id: string }>;
  try {
    committed = await room.commitFile(cred, { postId, r2Key, name, size, type });
  } catch {
    committed = { ok: false, status: 500, error: "The upload could not be saved" };
  }
  if (!committed.ok) {
    await files.delete(r2Key);
    return errorResponse(committed);
  }
  return json({ id: committed.value.id }, 201);
}
```

- [ ] **Step 5: Run the upload test to verify it passes**

Run: `npx vitest run test/upload.test.ts`
Expected: PASS.

- [ ] **Step 6: Append the request helpers to `test/helpers.ts`**

Add these imports at the top of `test/helpers.ts`:

```ts
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
```

Append at the end of the file:

```ts
function withOrigin(origin: string, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", origin);
  return { ...init, headers };
}

/** Request to the participants' door, with a same-origin Origin header unless one is given. */
export function publicFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${PUBLIC}${path}`, withOrigin(PUBLIC, init));
}

/** Request to the owners' door; tests act as OWNER through the development identity. */
export function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ADMIN}${path}`, withOrigin(ADMIN, init));
}

export async function makeRoom(slug: string, pin = "482913"): Promise<void> {
  const created = await env.ROOMS.getByName(slug).init({ slug, title: "API room", pin });
  if (!created.ok) throw new Error(created.error);
}

/** Joins through the public door and returns the "clip_session=<id>" cookie pair. */
export async function joinRoom(slug: string, name = "Kristi", ip = "198.51.100.30", pin = "482913"): Promise<string> {
  const res = await publicFetch(`/r/${slug}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ pin, name }),
  });
  if (res.status !== 200) throw new Error(`join failed with ${res.status}: ${await res.text()}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}
```

- [ ] **Step 7: Write the failing board API tests**

`test/board-api.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WirePost } from "../src/room/types";
import { acceptSocket, adminFetch, joinRoom, makeRoom, publicFetch } from "./helpers";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("doors and pages", () => {
  it("returns 404 for any host that is not a door", async () => {
    const res = await SELF.fetch("http://example.com/");
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("serves the home page on the public door with the security headers", async () => {
    const res = await publicFetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws://localhost:8787; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toContain('content="home"');
  });

  it("serves the admin page on the admin door and the board page on both", async () => {
    expect(await (await adminFetch("/")).text()).toContain('content="admin"');
    expect(await (await publicFetch("/r/any-room")).text()).toContain('content="board"');
    expect(await (await adminFetch("/r/any-room")).text()).toContain('content="board"');
  });

  it("serves CSS and JS assets but never HTML files directly", async () => {
    const css = await publicFetch("/assets/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await css.body?.cancel();
    const html = await publicFetch("/board.html");
    expect(html.status).toBe(404);
    await html.body?.cancel();
  });
});

describe("joining through the public door", () => {
  it("sets a room-scoped session cookie", async () => {
    await makeRoom("api-join");
    const res = await publicFetch("/r/api-join/api/join", json({ pin: "482913", name: "  Kristi " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Kristi" });
    expect(res.headers.getSetCookie()[0]).toMatch(
      /^clip_session=[0-9a-f]{32}; Path=\/r\/api-join; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/,
    );
  });

  it("answers a wrong PIN and an unknown room identically", async () => {
    await makeRoom("api-wrong");
    const wrong = await publicFetch("/r/api-wrong/api/join", json({ pin: "000000", name: "Kristi" }));
    const unknown = await publicFetch("/r/api-nowhere/api/join", json({ pin: "482913", name: "Kristi" }));
    expect(wrong.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "Room or PIN not recognized" });
    expect(await unknown.json()).toEqual({ error: "Room or PIN not recognized" });
  });

  it("requires a name", async () => {
    await makeRoom("api-name");
    const res = await publicFetch("/r/api-name/api/join", json({ pin: "482913", name: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter a name of 1 to 40 characters" });
  });

  it("returns 429 with Retry-After on the 21st failure from one IP", async () => {
    await makeRoom("api-limit");
    const attempt = () =>
      publicFetch("/r/api-limit/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.50" },
        body: JSON.stringify({ pin: "000000", name: "x" }),
      });
    for (let i = 0; i < 20; i++) {
      const res = await attempt();
      expect(res.status).toBe(403);
      await res.body?.cancel();
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ error: "Too many attempts" });
  });

  it("does not offer joining on the admin door", async () => {
    await makeRoom("api-adminjoin");
    const res = await adminFetch("/r/api-adminjoin/api/join", json({ pin: "482913", name: "Kristi" }));
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });
});

describe("participant API", () => {
  it("resolves the session cookie and rejects missing or forged credentials", async () => {
    await makeRoom("api-me");
    const cookie = await joinRoom("api-me");
    expect(await (await publicFetch("/r/api-me/api/me", { headers: { Cookie: cookie } })).json()).toEqual({
      name: "Kristi",
      role: "participant",
    });

    const anonymous = await publicFetch("/r/api-me/api/me");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Join the room first" });

    const forged = await publicFetch("/r/api-me/api/posts", {
      ...json({ text: "hi" }),
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": "forged.token.value" },
    });
    expect(forged.status).toBe(401);
    await forged.body?.cancel();
  });

  it("posts text and validates it", async () => {
    await makeRoom("api-posts");
    const cookie = await joinRoom("api-posts");
    const withCookie = (body: unknown) => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

    const created = await publicFetch("/r/api-posts/api/posts", withCookie({ text: "claude --effort high" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: expect.stringMatching(/^[0-9a-z]{26}$/) });

    const blank = await publicFetch("/r/api-posts/api/posts", withCookie({ text: "   " }));
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "Posts must be 1 to 20,000 characters and not only spaces" });
  });

  it("refuses POSTs and WebSocket upgrades from another origin", async () => {
    await makeRoom("api-origin");
    const cookie = await joinRoom("api-origin");
    const post = await publicFetch("/r/api-origin/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://evil.example" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: "Cross-site request refused" });

    const upgrade = await publicFetch("/r/api-origin/api/live", {
      headers: { Upgrade: "websocket", Cookie: cookie, Origin: "https://evil.example" },
    });
    expect(upgrade.status).toBe(403);
    await upgrade.body?.cancel();
  });

  it("opens the live socket with the session cookie", async () => {
    await makeRoom("api-live");
    const cookie = await joinRoom("api-live");
    const res = await publicFetch("/r/api-live/api/live", { headers: { Upgrade: "websocket", Cookie: cookie } });
    expect(res.status).toBe(101);
    const socket = acceptSocket(res);
    expect((await socket.nextOfType("snapshot")).you).toEqual({ name: "Kristi", role: "participant" });
  });

  it("leave clears the cookie and ends the session", async () => {
    await makeRoom("api-leave");
    const cookie = await joinRoom("api-leave");
    const res = await publicFetch("/r/api-leave/api/leave", { method: "POST", headers: { Cookie: cookie } });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toBe(
      "clip_session=; Path=/r/api-leave; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    const me = await publicFetch("/r/api-leave/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
    await me.body?.cancel();
  });

  it("does not accept one room's session in another room", async () => {
    await makeRoom("api-room-a");
    await makeRoom("api-room-b");
    const cookie = await joinRoom("api-room-a");
    const res = await publicFetch("/r/api-room-b/api/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("lets participants delete their own posts but not pin", async () => {
    await makeRoom("api-delete");
    const cookie = await joinRoom("api-delete");
    const created = await publicFetch("/r/api-delete/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "mine" }),
    });
    const { id } = await created.json<{ id: string }>();

    const pin = await publicFetch(`/r/api-delete/api/posts/${id}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(404);
    await pin.body?.cancel();

    const deleted = await publicFetch(`/r/api-delete/api/posts/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(deleted.status).toBe(204);
  });
});

describe("owner API on the admin door", () => {
  it("acts as the owner, pins and deletes any post", async () => {
    await makeRoom("api-owner");
    const cookie = await joinRoom("api-owner");
    const created = await publicFetch("/r/api-owner/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "participant post" }),
    });
    const { id } = await created.json<{ id: string }>();

    expect(await (await adminFetch("/r/api-owner/api/me")).json()).toEqual({ name: "Dimitris", role: "owner" });

    const pin = await adminFetch(`/r/api-owner/api/posts/${id}/pin`, json({ pinned: true }));
    expect(pin.status).toBe(204);

    const live = await adminFetch("/r/api-owner/api/live", { headers: { Upgrade: "websocket" } });
    const snapshot = await acceptSocket(live).nextOfType("snapshot");
    expect((snapshot.posts as WirePost[])[0]).toMatchObject({ id, pinned: true, mine: false });

    const badPin = await adminFetch(`/r/api-owner/api/posts/${id}/pin`, json({ pinned: "yes" }));
    expect(badPin.status).toBe(400);
    expect(await badPin.json()).toEqual({ error: "Send pinned as true or false" });

    const deleted = await adminFetch(`/r/api-owner/api/posts/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });
});

describe("files over HTTP", () => {
  async function upload(slug: string, cookie: string, bytes: Uint8Array, name: string, type: string) {
    return publicFetch(`/r/${slug}/api/files`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": type,
        "Content-Length": String(bytes.byteLength),
        "X-File-Name": encodeURIComponent(name),
      },
      body: bytes,
    });
  }

  it("uploads and serves an image inline", async () => {
    await makeRoom("api-files");
    const cookie = await joinRoom("api-files");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const res = await upload("api-files", cookie, bytes, "error shot.png", "image/png");
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const file = await publicFetch(`/r/api-files/files/${id}`, { headers: { Cookie: cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect(file.headers.get("Content-Disposition")).toBe("inline; filename*=UTF-8''error%20shot.png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("forces SVG to download and hides files from other rooms and strangers", async () => {
    await makeRoom("api-svg");
    await makeRoom("api-svg-other");
    const cookie = await joinRoom("api-svg");
    const otherCookie = await joinRoom("api-svg-other");
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const { id } = await (await upload("api-svg", cookie, svg, "logo.svg", "image/svg+xml")).json<{ id: string }>();

    const file = await publicFetch(`/r/api-svg/files/${id}`, { headers: { Cookie: cookie } });
    expect(file.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(file.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''logo.svg");
    await file.body?.cancel();

    const otherRoom = await publicFetch(`/r/api-svg-other/files/${id}`, { headers: { Cookie: otherCookie } });
    expect(otherRoom.status).toBe(404);
    await otherRoom.body?.cancel();

    const stranger = await publicFetch(`/r/api-svg/files/${id}`);
    expect(stranger.status).toBe(401);
    await stranger.body?.cancel();
  });
});
```

- [ ] **Step 8: Run the board API tests to verify they fail**

Run: `npx vitest run test/board-api.test.ts`
Expected: FAIL. The skeleton Worker answers 404 to everything, and `../src/board-api` is not yet imported anywhere.

- [ ] **Step 9: Create `src/board-api.ts`**

```ts
import { downloadHeaders } from "./files";
import {
  clearedSessionCookie,
  errorResponse,
  json,
  notFound,
  readCookie,
  readJson,
  servePage,
  SESSION_COOKIE,
  sessionCookie,
} from "./http";
import { isSessionId } from "./ids";
import type { Owner } from "./owners";
import type { Result } from "./results";
import { ownerCred, type Cred, type UploadGrant } from "./room/types";
import { uploadFile } from "./upload";
import { parseName, parsePostText } from "./validate";

export type Door = "public" | "admin";

export type BoardContext = {
  door: Door;
  /** Set on the admin door only, after authenticateOwner() succeeded. */
  owner: Owner | null;
  slug: string;
  /** The path after /r/<slug>, e.g. "" or "/api/posts". */
  rest: string;
};

const POST_ID = "([0-9a-z]{26})";
const POST_ROUTE = new RegExp(`^/api/posts/${POST_ID}$`);
const PIN_ROUTE = new RegExp(`^/api/posts/${POST_ID}/pin$`);
const FILE_ROUTE = new RegExp(`^/files/${POST_ID}$`);

function credFor(request: Request, ctx: BoardContext): Cred | null {
  if (ctx.door === "admin") return ctx.owner ? ownerCred(ctx.owner) : null;
  const sessionId = readCookie(request, SESSION_COOKIE);
  return isSessionId(sessionId) ? { kind: "session", sessionId } : null;
}

const noContent = () => new Response(null, { status: 204 });

export async function handleBoard(request: Request, env: Env, ctx: BoardContext): Promise<Response> {
  const { door, slug, rest } = ctx;
  const method = request.method;
  const room = env.ROOMS.getByName(slug);

  if (rest === "" && method === "GET") return servePage(request, env.ASSETS, "board.html");

  if (rest === "/api/join" && method === "POST" && door === "public") {
    const body = await readJson(request);
    const name = parseName(body?.name);
    if (!name) return json({ error: "Enter a name of 1 to 40 characters" }, 400);
    const pin = typeof body?.pin === "string" ? body.pin : "";
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const joined = await room.join({ pin, name, ip });
    if (!joined.ok) return errorResponse(joined);
    return json({ name: joined.value.name }, 200, {
      "Set-Cookie": sessionCookie(slug, joined.value.sessionId, joined.value.maxAgeSeconds),
    });
  }

  const cred = credFor(request, ctx);
  if (!cred) return json({ error: "Join the room first" }, 401);

  if (rest === "/api/me" && method === "GET") {
    const me = await room.me(cred);
    return me.ok ? json(me.value) : errorResponse(me);
  }

  if (rest === "/api/leave" && method === "POST" && door === "public") {
    await room.leave(cred);
    return new Response(null, { status: 204, headers: { "Set-Cookie": clearedSessionCookie(slug) } });
  }

  if (rest === "/api/live" && method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade" }, 426);
    }
    // A fresh request: only the upgrade and the credential the Worker vouches for reach the room.
    return room.fetch(
      new Request("https://room.internal/live", {
        headers: { Upgrade: "websocket", "X-Clip-Cred": JSON.stringify(cred) },
      }),
    );
  }

  if (rest === "/api/posts" && method === "POST") {
    const body = await readJson(request);
    const text = parsePostText(body?.text);
    if (text === null) return json({ error: "Posts must be 1 to 20,000 characters and not only spaces" }, 400);
    const added = await room.addText(cred, text);
    return added.ok ? json(added.value, 201) : errorResponse(added);
  }

  if (rest === "/api/files" && method === "POST") {
    return uploadFile(
      request,
      env.FILES,
      {
        authorizeUpload: async (c, size, name) => (await room.authorizeUpload(c, size, name)) as Result<UploadGrant>,
        commitFile: async (c, meta) => (await room.commitFile(c, meta)) as Result<{ id: string }>,
      },
      cred,
    );
  }

  const postMatch = POST_ROUTE.exec(rest);
  if (postMatch && method === "DELETE") {
    const deleted = await room.deletePost(cred, postMatch[1]!);
    return deleted.ok ? noContent() : errorResponse(deleted);
  }

  const pinMatch = PIN_ROUTE.exec(rest);
  if (pinMatch && method === "POST" && door === "admin") {
    const body = await readJson(request);
    if (typeof body?.pinned !== "boolean") return json({ error: "Send pinned as true or false" }, 400);
    const pinned = await room.setPinned(cred, pinMatch[1]!, body.pinned);
    return pinned.ok ? noContent() : errorResponse(pinned);
  }

  const fileMatch = FILE_ROUTE.exec(rest);
  if (fileMatch && method === "GET") {
    const ref = await room.getFile(cred, fileMatch[1]!);
    if (!ref.ok) return errorResponse(ref);
    const object = await env.FILES.get(ref.value.r2Key);
    if (!object) return json({ error: "File not found" }, 404);
    return new Response(object.body, { headers: downloadHeaders(ref.value.type, ref.value.name) });
  }

  return notFound();
}
```

- [ ] **Step 10: Replace `src/index.ts`**

```ts
import { handleBoard, type Door } from "./board-api";
import { isSameOrigin, json, notFound, serveAsset, servePage } from "./http";
import { authenticateOwner, type Owner } from "./owners";
import { isSlug } from "./validate";

export { Room } from "./room/room";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const door: Door | null =
      url.host === env.PUBLIC_HOST ? "public" : url.host === env.ADMIN_HOST ? "admin" : null;
    if (!door) return new Response("Not found", { status: 404 });
    if (!isSameOrigin(request)) return json({ error: "Cross-site request refused" }, 403);

    let owner: Owner | null = null;
    if (door === "admin") {
      owner = await authenticateOwner(request, env);
      if (!owner) return json({ error: "Owner sign-in required" }, 401);
    }

    const path = url.pathname;
    if (request.method === "GET" && path.startsWith("/assets/")) return serveAsset(request, env.ASSETS);
    if (request.method === "GET" && path === "/") {
      return servePage(request, env.ASSETS, door === "admin" ? "admin.html" : "home.html");
    }
    if (path.startsWith("/api/")) return notFound(); // Task 9 routes the admin API here.

    const match = /^\/r\/([^/]+)(\/.*)?$/.exec(path);
    if (match && isSlug(match[1])) {
      return handleBoard(request, env, { door, owner, slug: match[1], rest: match[2] ?? "" });
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 11: Run all tests and the type check**

Run: `npm test`
Expected: all test files pass, including `board-api.test.ts` and `upload.test.ts`.

Run: `npm run typecheck`
Expected: exits 0.
- If `tsc` rejects the `as Result<…>` casts in `board-api.ts` ("conversion may be a mistake"), change each to `as unknown as Result<…>`.
- If it rejects passing `env` to `authenticateOwner` because a var's literal type is not `string`, pass `env as unknown as OwnerEnv`. Import `type OwnerEnv` for that.

- [ ] **Step 12: Commit**

```bash
git add src/http.ts src/upload.ts src/board-api.ts src/index.ts test/helpers.ts test/upload.test.ts test/board-api.test.ts
git commit -m "Route both doors to rooms: join, posts, live sockets and files"
```

---

### Task 9: Admin API

**Files:**
- Create: `src/r2.ts`, `src/admin-api.ts`
- Modify: `src/index.ts` (import and one routing line)
- Test: `test/admin-api.test.ts`

**Interfaces:**
- Consumes:
  - Room RPC `init`, `info`, `update`, `changePin`, `destroy`
  - `isSlug`, `parseTitle`, `parsePin`
  - `json`, `notFound`, `errorResponse`, `readJson`
  - `ownerCred`
  - Test helpers `adminFetch`, `publicFetch`, `joinRoom`
- Produces:
  - `deletePrefix(bucket: R2Bucket, prefix: string): Promise<void>`
  - `type RoomListItem = (RoomInfo & { deletionIncomplete: false }) | { slug: string; createdAt: number; deletionIncomplete: true }`
  - `handleAdminApi(request, env, owner, path): Promise<Response>`, serving these routes:
    - `GET /api/config` → `{ publicOrigin }`, e.g. `https://clip.dimitrismitsis.com`; the admin page builds public room links from it
    - `GET /api/rooms` → `RoomListItem[]` (newest first)
    - `POST /api/rooms {slug, title, pin}` → `201 {slug}`
    - `PATCH /api/rooms/:slug {title?, archived?}` → 204
    - `PUT /api/rooms/:slug/pin {pin}` → 204
    - `DELETE /api/rooms/:slug {confirm}` → 204
- New error messages (exact):
  - `Slugs use lowercase letters, digits and hyphens, up to 40 characters` (400)
  - `Titles must be 1 to 80 characters` (400)
  - `PINs must be 6 to 12 letters or digits` (400)
  - `Send archived as true or false` (400)
  - `Type the room slug to confirm` (400)
  - `Files could not be deleted. Retry deletion.` (500)

- [ ] **Step 1: Write the failing tests**

`test/admin-api.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RoomListItem } from "../src/admin-api";
import { adminFetch, joinRoom, publicFetch } from "./helpers";

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function create(slug: string, pin = "482913", title = "Claude Code at AGNA") {
  return adminFetch("/api/rooms", send("POST", { slug, title, pin }));
}

async function listRooms(): Promise<RoomListItem[]> {
  return (await adminFetch("/api/rooms")).json<RoomListItem[]>();
}

describe("admin rooms API", () => {
  it("creates a room that participants can join", async () => {
    const res = await create("admin-create");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ slug: "admin-create" });

    const rooms = await listRooms();
    expect(rooms.find((r) => r.slug === "admin-create")).toMatchObject({
      title: "Claude Code at AGNA",
      pin: "482913",
      archived: false,
      postCount: 0,
      participantCount: 0,
      deletionIncomplete: false,
    });
    expect(await joinRoom("admin-create")).toMatch(/^clip_session=[0-9a-f]{32}$/);
  });

  it("validates input and refuses duplicates", async () => {
    const badSlug = await create("Bad Slug");
    expect(badSlug.status).toBe(400);
    expect(await badSlug.json()).toEqual({
      error: "Slugs use lowercase letters, digits and hyphens, up to 40 characters",
    });

    const badTitle = await create("admin-title", "482913", " ");
    expect(await badTitle.json()).toEqual({ error: "Titles must be 1 to 80 characters" });

    const badPin = await create("admin-pin", "12");
    expect(await badPin.json()).toEqual({ error: "PINs must be 6 to 12 letters or digits" });

    expect((await create("admin-dup")).status).toBe(201);
    const dup = await create("admin-dup");
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "A room with that slug already exists" });
  });

  it("is not reachable through the public door", async () => {
    const res = await publicFetch("/api/rooms");
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("tells the admin page where the public door is", async () => {
    expect(await (await adminFetch("/api/config")).json()).toEqual({ publicOrigin: "http://localhost:8787" });
  });

  it("renames and archives", async () => {
    await create("admin-patch");
    expect((await adminFetch("/api/rooms/admin-patch", send("PATCH", { title: "Day 2", archived: true }))).status).toBe(204);
    expect((await listRooms()).find((r) => r.slug === "admin-patch")).toMatchObject({ title: "Day 2", archived: true });

    const bad = await adminFetch("/api/rooms/admin-patch", send("PATCH", { archived: "yes" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Send archived as true or false" });
  });

  it("changing the PIN signs participants out", async () => {
    await create("admin-newpin");
    const cookie = await joinRoom("admin-newpin");
    expect((await adminFetch("/api/rooms/admin-newpin/pin", send("PUT", { pin: "777777" }))).status).toBe(204);
    const me = await publicFetch("/r/admin-newpin/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
    await me.body?.cancel();
    expect(await joinRoom("admin-newpin", "Kristi", "198.51.100.31", "777777")).toMatch(/^clip_session=/);
  });

  it("deletes a room, its files and its index entry after confirmation", async () => {
    await create("admin-delete");
    await env.FILES.put("rooms/admin-delete/p1/a.txt", "a");
    await env.FILES.put("rooms/admin-delete/p2/b.txt", "b");

    const unconfirmed = await adminFetch("/api/rooms/admin-delete", send("DELETE", { confirm: "wrong" }));
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toEqual({ error: "Type the room slug to confirm" });

    expect((await adminFetch("/api/rooms/admin-delete", send("DELETE", { confirm: "admin-delete" }))).status).toBe(204);
    expect((await env.FILES.list({ prefix: "rooms/admin-delete/" })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT slug FROM rooms WHERE slug = ?").bind("admin-delete").first()).toBeNull();
    expect(await env.ROOMS.getByName("admin-delete").info()).toBeNull();
    expect((await create("admin-delete")).status).toBe(201);
  });

  it("lists a half-deleted room and finishes deleting it on retry", async () => {
    await env.DB.prepare("INSERT INTO rooms (slug, created_at) VALUES (?, ?)").bind("admin-halfway", Date.now()).run();
    expect((await listRooms()).find((r) => r.slug === "admin-halfway")).toMatchObject({ deletionIncomplete: true });
    expect((await adminFetch("/api/rooms/admin-halfway", send("DELETE", { confirm: "admin-halfway" }))).status).toBe(204);
    expect((await listRooms()).some((r) => r.slug === "admin-halfway")).toBe(false);
  });

  it("returns 404 when deleting a room that is not indexed", async () => {
    const res = await adminFetch("/api/rooms/admin-nothing", send("DELETE", { confirm: "admin-nothing" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Room not found" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/admin-api.test.ts`
Expected: FAIL. `../src/admin-api` cannot be resolved, and `/api/rooms` returns 404.

- [ ] **Step 3: Create `src/r2.ts`**

```ts
/** Deletes every object under a prefix, 1,000 keys per call. Throws if R2 fails. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) return;
    await bucket.delete(page.objects.map((object) => object.key));
    if (!page.truncated) return;
  }
}
```

- [ ] **Step 4: Create `src/admin-api.ts`**

```ts
import { errorResponse, json, notFound, readJson } from "./http";
import type { Owner } from "./owners";
import { deletePrefix } from "./r2";
import { ownerCred, type RoomInfo } from "./room/types";
import { isSlug, parsePin, parseTitle } from "./validate";

export type RoomListItem =
  | (RoomInfo & { deletionIncomplete: false })
  | { slug: string; createdAt: number; deletionIncomplete: true };

const noContent = () => new Response(null, { status: 204 });

async function isIndexed(env: Env, slug: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS found FROM rooms WHERE slug = ?").bind(slug).first()) !== null;
}

export async function handleAdminApi(request: Request, env: Env, owner: Owner, path: string): Promise<Response> {
  const cred = ownerCred(owner);
  const method = request.method;

  if (path === "/api/config" && method === "GET") {
    return json({ publicOrigin: `${new URL(request.url).protocol}//${env.PUBLIC_HOST}` });
  }

  if (path === "/api/rooms" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT slug, created_at FROM rooms ORDER BY created_at DESC").all<{
      slug: string;
      created_at: number;
    }>();
    const items = await Promise.all(
      results.map(async (row): Promise<RoomListItem> => {
        const info = await env.ROOMS.getByName(row.slug).info();
        return info
          ? { ...info, deletionIncomplete: false }
          : { slug: row.slug, createdAt: row.created_at, deletionIncomplete: true };
      }),
    );
    return json(items);
  }

  if (path === "/api/rooms" && method === "POST") {
    const body = await readJson(request);
    const slug = body?.slug;
    const title = parseTitle(body?.title);
    const pin = parsePin(body?.pin);
    if (!isSlug(slug)) return json({ error: "Slugs use lowercase letters, digits and hyphens, up to 40 characters" }, 400);
    if (!title) return json({ error: "Titles must be 1 to 80 characters" }, 400);
    if (!pin) return json({ error: "PINs must be 6 to 12 letters or digits" }, 400);
    if (await isIndexed(env, slug)) return json({ error: "A room with that slug already exists" }, 409);

    await env.DB.prepare("INSERT INTO rooms (slug, created_at) VALUES (?, ?)").bind(slug, Date.now()).run();
    const created = await env.ROOMS.getByName(slug).init({ slug, title, pin });
    if (!created.ok) {
      await env.DB.prepare("DELETE FROM rooms WHERE slug = ?").bind(slug).run();
      return errorResponse(created);
    }
    return json({ slug }, 201);
  }

  const match = /^\/api\/rooms\/([^/]+)(\/pin)?$/.exec(path);
  if (!match || !isSlug(match[1])) return notFound();
  const slug = match[1];
  const isPinRoute = match[2] !== undefined;
  const room = env.ROOMS.getByName(slug);

  if (!isPinRoute && method === "PATCH") {
    const body = await readJson(request);
    const patch: { title?: string; archived?: boolean } = {};
    if (body?.title !== undefined) {
      const title = parseTitle(body.title);
      if (!title) return json({ error: "Titles must be 1 to 80 characters" }, 400);
      patch.title = title;
    }
    if (body?.archived !== undefined) {
      if (typeof body.archived !== "boolean") return json({ error: "Send archived as true or false" }, 400);
      patch.archived = body.archived;
    }
    const updated = await room.update(cred, patch);
    return updated.ok ? noContent() : errorResponse(updated);
  }

  if (isPinRoute && method === "PUT") {
    const body = await readJson(request);
    const pin = parsePin(body?.pin);
    if (!pin) return json({ error: "PINs must be 6 to 12 letters or digits" }, 400);
    const changed = await room.changePin(cred, pin);
    return changed.ok ? noContent() : errorResponse(changed);
  }

  if (!isPinRoute && method === "DELETE") {
    const body = await readJson(request);
    if (body?.confirm !== slug) return json({ error: "Type the room slug to confirm" }, 400);
    if (!(await isIndexed(env, slug))) return json({ error: "Room not found" }, 404);

    const destroyed = await room.destroy(cred);
    if (!destroyed.ok) return errorResponse(destroyed);
    try {
      await deletePrefix(env.FILES, `rooms/${slug}/`);
    } catch {
      // The D1 row stays, so the admin page lists the room as "deletion incomplete" with Retry.
      return json({ error: "Files could not be deleted. Retry deletion." }, 500);
    }
    await env.DB.prepare("DELETE FROM rooms WHERE slug = ?").bind(slug).run();
    return noContent();
  }

  return notFound();
}
```

- [ ] **Step 5: Route the admin API in `src/index.ts`**

Add the import:

```ts
import { handleAdminApi } from "./admin-api";
```

Replace the line

```ts
    if (path.startsWith("/api/")) return notFound(); // Task 9 routes the admin API here.
```

with

```ts
    if (path.startsWith("/api/")) {
      return door === "admin" && owner ? handleAdminApi(request, env, owner, path) : notFound();
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/admin-api.test.ts`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: all green; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/r2.ts src/admin-api.ts src/index.ts test/admin-api.test.ts
git commit -m "Add admin API: create, list, rename, archive, change PIN, delete with retry"
```

---

### Task 10: Front-end foundation

**Files:**
- Replace: `public/assets/app.css`, `public/home.html`
- Create: `public/assets/common.js`
- Test: `test/common.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, in `public/assets/common.js` (ES module):
  - `api(path, {method?, body?, headers?}) → Promise<{ok, status, data, expired}>`
    - Sends JSON when `body` is given and never follows redirects.
    - `expired` is `true` when the response is an opaque redirect (the Access session ended).
    - `status` is `0` on network errors.
  - `el(tag, props?, children?) → Element`
    - Props: `text`, `class`, `dataset`, `on<event>` handlers; anything else becomes an attribute.
    - Children: nodes or strings (added as text).
  - `toast(message)`: shows `#toast` for 5 seconds.
  - `splitLinks(text) → Array<{type: "text" | "link", value}>`
  - `relativeTime(ms, now?) → string`
  - `formatBytes(bytes) → string`
- CSS class names that Tasks 11–12 use:
  - Layout: `page`, `wide`, `narrow`, `bar`, `status` (with `data-state`), `muted`, `error`, `banner`, `stack`
  - Board: `composer`, `composer-actions`, `section`, `posts`, `post`, `fresh`, `post-head`, `post-author`, `badge`, `post-actions`, `post-text`, `post-file`, `thumb`, `uploads`, `upload`
  - Controls: `toast`, `dropping`, `button-link`, `primary`, `link`, `danger`, `mono`
  - Admin: `table-wrap`, `manage`, `row-links`, `pin-field`

- [ ] **Step 1: Write the failing tests**

`test/common.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatBytes, relativeTime, splitLinks } from "../public/assets/common.js";

describe("splitLinks", () => {
  it("finds http and https links and leaves trailing punctuation outside", () => {
    expect(splitLinks("see https://github.com/dimitris-am/agna-starter.")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://github.com/dimitris-am/agna-starter" },
      { type: "text", value: "." },
    ]);
    expect(splitLinks("(http://a.b/c)")).toEqual([
      { type: "text", value: "(" },
      { type: "link", value: "http://a.b/c" },
      { type: "text", value: ")" },
    ]);
  });

  it("finds several links", () => {
    expect(splitLinks("https://a.io and https://b.io")).toEqual([
      { type: "link", value: "https://a.io" },
      { type: "text", value: " and " },
      { type: "link", value: "https://b.io" },
    ]);
  });

  it("never links other schemes or bare prefixes", () => {
    expect(splitLinks("javascript:alert(1) ftp://x.y http://")).toEqual([
      { type: "text", value: "javascript:alert(1) ftp://x.y http://" },
    ]);
    expect(splitLinks("")).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  it("describes recent times", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
  it("falls back to a date after a day", () => {
    expect(relativeTime(Date.UTC(2026, 8, 12, 12, 0, 0), now)).toBe("Sep 12");
  });
});

describe("formatBytes", () => {
  it("uses B, KB, MB and GB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(240 * 1024)).toBe("240 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/common.test.ts`
Expected: FAIL. `../public/assets/common.js` cannot be resolved.

- [ ] **Step 3: Create `public/assets/common.js`**

```js
// Shared browser helpers. No framework: every node is built with textContent.

/** Fetches JSON without following redirects, so an ended Access session is detectable. */
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin", redirect: "manual" };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, data: { error: "Network error. Check your connection." }, expired: false };
  }
  if (res.type === "opaqueredirect") return { ok: false, status: 0, data: null, expired: true };
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, expired: false };
}

/** Builds an element. Props: text, class, dataset, on<event>; anything else is an attribute. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "class") node.className = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

let toastTimer = 0;

export function toast(message) {
  const box = document.getElementById("toast");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 5000);
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Splits text into plain parts and http(s) links. Trailing punctuation stays outside links. */
export function splitLinks(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    while (/[.,;:!?)\]}]$/.test(url)) url = url.slice(0, -1);
    if (!/^https?:\/\/[^/]/.test(url)) continue;
    const start = match.index;
    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "link", value: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

export function relativeTime(then, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/common.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace `public/assets/app.css`**

```css
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --text: #16181d;
  --muted: #5d6470;
  --border: #d9dde3;
  --accent: #1f5fd6;
  --accent-text: #ffffff;
  --danger: #b42318;
  --highlight: #fff4c2;
  --live: #0b6b3a;
  --radius: 8px;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --surface: #171a21;
    --text: #e8eaee;
    --muted: #9aa3b2;
    --border: #2a2f3a;
    --accent: #6ea0ff;
    --accent-text: #0f1115;
    --danger: #ff8a80;
    --highlight: #3a3212;
    --live: #6fd39b;
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 var(--sans); }
h1, h2 { line-height: 1.25; }
button, input, textarea { font: inherit; color: inherit; }
input, textarea { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.6rem; }
textarea { font-family: var(--mono); resize: vertical; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

button, .button-link {
  display: inline-block; cursor: pointer; border: 1px solid var(--border); background: var(--surface);
  border-radius: var(--radius); padding: 0.35rem 0.8rem; color: inherit; text-decoration: none; white-space: nowrap;
}
button:disabled { opacity: 0.6; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.link { border: none; background: none; padding: 0; color: var(--accent); text-decoration: underline; }
button.danger { color: var(--danger); }
a { color: var(--accent); }

.page { max-width: 760px; margin: 0 auto; padding: 1rem; }
.page.wide { max-width: 1100px; }
.page.narrow { max-width: 420px; padding-top: 15vh; }
.bar {
  position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem;
  padding: 0.6rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border);
}
.bar h1 { margin: 0; font-size: 1.1rem; flex: 1 1 12rem; overflow-wrap: anywhere; }
.status::before { content: "●"; margin-right: 0.3rem; color: var(--muted); }
.status[data-state="live"]::before { color: var(--live); }
.muted { color: var(--muted); }
.error { color: var(--danger); margin: 0; }
.banner { padding: 0.6rem 0.8rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--highlight); }
.mono { font-family: var(--mono); }

form.stack { display: grid; gap: 0.75rem; }
label { display: grid; gap: 0.25rem; font-weight: 600; }

.composer { display: grid; gap: 0.5rem; margin: 1rem 0; }
.composer-actions { display: flex; justify-content: flex-end; align-items: center; gap: 0.75rem; }
.section { margin: 1.5rem 0 0.5rem; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.posts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.post { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem 0.8rem; transition: background-color 1.5s ease; }
.post.fresh { background: var(--highlight); transition: none; }
.post-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; font-size: 0.9rem; }
.post-author { font-weight: 600; }
.badge { font-size: 0.75rem; border: 1px solid currentColor; color: var(--live); border-radius: 999px; padding: 0 0.45rem; }
.post-actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: 0.4rem; }
.post-text { margin: 0.4rem 0 0; font-family: var(--mono); font-size: 0.92rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.post-file { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: 0.4rem; overflow-wrap: anywhere; }
.thumb { display: block; max-width: 100%; max-height: 240px; border-radius: 4px; border: 1px solid var(--border); }
.uploads { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.upload { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
.upload progress { flex: 1 1 8rem; }
.dropping { outline: 3px dashed var(--accent); outline-offset: -8px; }

.toast {
  position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); max-width: calc(100% - 2rem);
  background: var(--text); color: var(--bg); padding: 0.6rem 1rem; border-radius: var(--radius);
}

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.row-links { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; font-size: 0.9rem; }
.pin-field { display: flex; gap: 0.5rem; }
details.manage { margin-top: 0.4rem; }
details.manage form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.5rem 0; }
details.manage input { width: auto; flex: 1 1 10rem; }
```

- [ ] **Step 6: Replace `public/home.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="clip-page" content="home">
<title>Live Clipboard</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<main class="page narrow">
  <h1>Live Clipboard</h1>
  <p>Open the room link shown on screen.</p>
</main>
</body>
</html>
```

- [ ] **Step 7: Run all tests and the type check**

Run: `npm test && npm run typecheck`
Expected: all green; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add public/assets/app.css public/assets/common.js public/home.html test/common.test.ts
git commit -m "Add shared styles, browser helpers and home page"
```

---

### Task 11: Admin page

**Files:**
- Replace: `public/admin.html`
- Create: `public/assets/admin.js`

**Interfaces:**
- Consumes:
  - Admin API from Task 9: `GET /api/config`, `GET/POST /api/rooms`, `PATCH /api/rooms/:slug`, `PUT /api/rooms/:slug/pin`, `DELETE /api/rooms/:slug`
  - `api`, `el`, `toast`, `formatBytes`, `relativeTime` (Task 10)
- Produces: a working admin page at `http://127.0.0.1:8787/` locally.

**How it is verified:** this task has no unit tests; the page is a thin client over the tested API. Verification is a scripted browser pass (Step 5) using the gstack `/browse` skill, which Dimitris's global instructions require for all browsing. No `alert`, `confirm` or `prompt` anywhere: every confirmation is an inline form field.

- [ ] **Step 1: Replace `public/admin.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="clip-page" content="admin">
<title>Rooms · Live Clipboard</title>
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/admin.js"></script>
</head>
<body>
<header class="bar"><h1>Live Clipboard rooms</h1></header>
<main class="page wide">
  <section id="expired" class="banner" hidden>
    <p>Session expired — sign in again.</p>
    <button id="reload" type="button">Reload</button>
  </section>

  <section>
    <h2>New room</h2>
    <form id="create-form" class="stack">
      <label>Slug
        <input id="create-slug" required maxlength="40" placeholder="agna-2026" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <label>Title
        <input id="create-title" required maxlength="80" placeholder="Claude Code at AGNA">
      </label>
      <label>PIN
        <span class="pin-field">
          <input id="create-pin" required maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button id="create-generate" type="button">Generate</button>
        </span>
      </label>
      <p id="create-error" class="error" hidden></p>
      <div><button class="primary" type="submit">Create room</button></div>
    </form>
  </section>

  <section>
    <h2>Rooms</h2>
    <p id="rooms-empty" class="muted" hidden>No rooms yet.</p>
    <div class="table-wrap">
      <table id="rooms-table" hidden>
        <thead>
          <tr><th>Room</th><th>PIN</th><th>People</th><th>Posts</th><th>Files</th><th>Created</th></tr>
        </thead>
        <tbody id="rooms"></tbody>
      </table>
    </div>
  </section>
</main>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>
```

- [ ] **Step 2: Create `public/assets/admin.js`**

```js
import { api, el, formatBytes, relativeTime, toast } from "./common.js";

const $ = (id) => document.getElementById(id);

let publicOrigin = "";
let openSlug = null; // keeps one "Manage" panel open across re-renders

function generatePin() {
  const values = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(values, (n) => String(n % 10)).join("");
}

function showExpired() {
  $("expired").hidden = false;
}

async function load() {
  const [config, rooms] = await Promise.all([api("/api/config"), api("/api/rooms")]);
  if (config.expired || rooms.expired) return showExpired();
  if (!config.ok || !rooms.ok) {
    toast(rooms.data?.error ?? config.data?.error ?? "Could not load rooms.");
    return;
  }
  publicOrigin = config.data.publicOrigin;
  render(rooms.data);
}

function render(rooms) {
  $("rooms-empty").hidden = rooms.length > 0;
  $("rooms-table").hidden = rooms.length === 0;
  $("rooms").replaceChildren(...rooms.map(roomRow));
}

function roomRow(room) {
  if (room.deletionIncomplete) {
    return el("tr", {}, [
      el("td", { colspan: "6" }, [
        el("strong", { class: "mono", text: room.slug }),
        " ",
        el("span", { class: "error", text: "Deletion incomplete." }),
        " ",
        el("button", {
          type: "button",
          text: "Retry deletion",
          onclick: (event) => deleteRoom(room.slug, room.slug, event.currentTarget),
        }),
      ]),
    ]);
  }

  const link = `${publicOrigin}/r/${room.slug}`;
  return el("tr", {}, [
    el("td", {}, [
      el("div", {}, [
        el("strong", { text: room.title }),
        room.archived ? " " : null,
        room.archived ? el("span", { class: "badge", text: "archived" }) : null,
      ]),
      el("div", { class: "mono muted", text: room.slug }),
      el("div", { class: "row-links" }, [
        el("a", { href: link, target: "_blank", rel: "noopener", text: "Public link" }),
        el("button", { type: "button", class: "link", text: "Copy link", onclick: () => copy(link) }),
        el("a", { href: `/r/${room.slug}`, text: "Owner board" }),
      ]),
      managePanel(room),
    ]),
    el("td", { class: "mono", text: room.pin }),
    el("td", { text: String(room.participantCount) }),
    el("td", { text: String(room.postCount) }),
    el("td", { text: formatBytes(room.bytesUsed) }),
    el("td", { text: relativeTime(room.createdAt) }),
  ]);
}

function managePanel(room) {
  const title = el("input", { value: room.title, maxlength: "80", "aria-label": "Title" });
  const rename = el("form", { onsubmit: (event) => { event.preventDefault(); void patchRoom(room.slug, { title: title.value }); } }, [
    title,
    el("button", { type: "submit", text: "Rename" }),
  ]);

  const pin = el("input", { maxlength: "12", placeholder: "New PIN", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "New PIN" });
  const changePin = el("form", { onsubmit: (event) => { event.preventDefault(); void changeRoomPin(room.slug, pin.value); } }, [
    pin,
    el("button", { type: "button", text: "Generate", onclick: () => { pin.value = generatePin(); } }),
    el("button", { type: "submit", text: "Change PIN" }),
    el("span", { class: "muted", text: "Everyone in the room will be signed out." }),
  ]);

  const archive = el("form", { onsubmit: (event) => { event.preventDefault(); void patchRoom(room.slug, { archived: !room.archived }); } }, [
    el("button", { type: "submit", text: room.archived ? "Unarchive" : "Archive" }),
    el("span", { class: "muted", text: room.archived ? "Participants can post again." : "The room becomes read-only." }),
  ]);

  const confirmSlug = el("input", { placeholder: room.slug, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": `Type ${room.slug} to delete` });
  const remove = el("form", { onsubmit: (event) => { event.preventDefault(); void deleteRoom(room.slug, confirmSlug.value, event.submitter); } }, [
    confirmSlug,
    el("button", { type: "submit", class: "danger", text: "Delete room" }),
    el("span", { class: "muted", text: "Type the slug to confirm. Deletes every post and file." }),
  ]);

  return el(
    "details",
    {
      class: "manage",
      open: openSlug === room.slug,
      ontoggle: (event) => {
        if (event.currentTarget.open) openSlug = room.slug;
        else if (openSlug === room.slug) openSlug = null;
      },
    },
    [el("summary", { text: "Manage" }), rename, changePin, archive, remove],
  );
}

async function afterAction(res, message) {
  if (res.expired) return showExpired();
  if (!res.ok) {
    toast(res.data?.error ?? "Something went wrong.");
    if (res.status === 500) await load(); // shows "Deletion incomplete" with Retry
    return;
  }
  toast(message);
  await load();
}

async function patchRoom(slug, body) {
  const res = await api(`/api/rooms/${slug}`, { method: "PATCH", body });
  const message = body.archived === undefined ? "Saved" : body.archived ? "Room archived" : "Room unarchived";
  await afterAction(res, message);
}

async function changeRoomPin(slug, pin) {
  const res = await api(`/api/rooms/${slug}/pin`, { method: "PUT", body: { pin } });
  await afterAction(res, "PIN changed. Everyone was signed out.");
}

async function deleteRoom(slug, confirm, button) {
  if (button) button.disabled = true;
  const res = await api(`/api/rooms/${slug}`, { method: "DELETE", body: { confirm } });
  if (button) button.disabled = false;
  if (res.ok && openSlug === slug) openSlug = null;
  await afterAction(res, "Room deleted");
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast(text);
  }
}

$("create-generate").addEventListener("click", () => {
  $("create-pin").value = generatePin();
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const res = await api("/api/rooms", {
    method: "POST",
    body: { slug: $("create-slug").value.trim(), title: $("create-title").value, pin: $("create-pin").value },
  });
  if (res.expired) return showExpired();
  $("create-error").hidden = res.ok;
  $("create-error").textContent = res.ok ? "" : res.data?.error ?? "Could not create the room.";
  if (res.ok) {
    form.reset();
    toast("Room created");
    await load();
  }
});

$("reload").addEventListener("click", () => location.reload());

void load();
```

- [ ] **Step 3: Run the tests and type check**

Run: `npm test && npm run typecheck`
Expected: all green. The page marker `content="admin"` is unchanged, so `board-api.test.ts` still passes.

- [ ] **Step 4: Start the local Worker**

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply live-clipboard --local
npm run dev
```

Run `npm run dev` in the background. Expected: Wrangler prints `Ready on http://127.0.0.1:8787`.

- [ ] **Step 5: Verify in a browser with the `/browse` skill**

Use the gstack `/browse` skill (never the Chrome MCP tools). At `http://127.0.0.1:8787/` confirm each of these, taking a screenshot after the last:
1. The page shows "Live Clipboard rooms", the New room form, and "No rooms yet."
2. **Generate** fills the PIN field with 6 digits.
3. Create slug `demo`, title `Demo room`, PIN `482913`. A "Room created" toast appears, and the table shows `Demo room`, `demo`, PIN `482913`, 0 people, 0 posts, `0 B`, "just now".
4. Creating `demo` again shows "A room with that slug already exists" under the form.
5. Creating slug `Bad Slug` shows "Slugs use lowercase letters, digits and hyphens, up to 40 characters".
6. **Public link** points to `http://localhost:8787/r/demo`, and **Owner board** points to `/r/demo`.
7. **Manage** → **Rename** to `Demo room 2`: the table updates and the panel stays open.
8. **Manage** → **Archive**: an `archived` badge appears, and the button now reads **Unarchive**. Click **Unarchive** to restore.
9. **Manage** → **Change PIN** with **Generate**: the PIN column shows the new PIN.
10. Create a second room `scratch`, then delete it. First type `wrong` into its delete field and submit: the toast says "Type the room slug to confirm". Then type `scratch`: the row disappears.
11. At 400px viewport width, the table scrolls horizontally inside its wrapper and the page itself does not.

Leave room `demo` in place for Task 12. Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add public/admin.html public/assets/admin.js
git commit -m "Add admin page: create, rename, archive, change PIN, delete"
```

---

### Task 12: Board page

**Files:**
- Replace: `public/board.html`
- Create: `public/assets/board.js`

**Interfaces:**
- Consumes:
  - Board routes from Task 8: `/r/:slug/api/me|join|leave|live|posts|files`, `/r/:slug/api/posts/:id` (DELETE), `/r/:slug/api/posts/:id/pin`, `/r/:slug/files/:id`
  - The live protocol (`ServerMessage`, `WirePost` in `src/room/types.ts`); close codes 4401 and 4404
  - `api`, `el`, `toast`, `splitLinks`, `relativeTime`, `formatBytes` (Task 10)
- Produces: the board at `http://localhost:8787/r/<slug>` (participants) and `http://127.0.0.1:8787/r/<slug>` (owners).

**How it is verified:** as in Task 11. There are no unit tests beyond Task 10's helpers; Step 5 is a scripted two-window pass with the `/browse` skill.

- [ ] **Step 1: Replace `public/board.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="clip-page" content="board">
<title>Live Clipboard</title>
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/board.js"></script>
</head>
<body>
<header class="bar">
  <h1 id="room-title">Live Clipboard</h1>
  <span id="status" class="status" data-state="connecting" hidden>Connecting…</span>
  <span id="online" class="muted" hidden></span>
  <span id="you" hidden></span>
  <button id="leave" class="link" type="button" hidden>Leave</button>
</header>

<main class="page">
  <section id="join" class="narrow" hidden>
    <h2 id="join-heading">Join</h2>
    <form id="join-form" class="stack">
      <label>Room PIN
        <input id="join-pin" required maxlength="12" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <label>Your name
        <input id="join-name" required maxlength="40" autocomplete="nickname">
      </label>
      <p id="join-error" class="error" hidden></p>
      <div><button id="join-submit" class="primary" type="submit">Join</button></div>
    </form>
  </section>

  <section id="expired" class="banner" hidden>
    <p>Session expired — sign in again.</p>
    <button id="reload" type="button">Reload</button>
  </section>

  <section id="gone" hidden>
    <p>This room no longer exists.</p>
  </section>

  <section id="board" hidden>
    <p id="archived-banner" class="banner" hidden>This room is archived. It is read-only.</p>
    <form id="composer" class="composer">
      <textarea id="composer-text" rows="3" placeholder="Paste, type, or drop a file…" aria-label="New post"></textarea>
      <div class="composer-actions">
        <label class="button-link">Attach file<input id="file-input" type="file" multiple hidden></label>
        <span class="muted">⌘/Ctrl + Enter</span>
        <button id="composer-submit" class="primary" type="submit">Post</button>
      </div>
    </form>
    <ul id="uploads" class="uploads"></ul>
    <h2 id="pinned-heading" class="section" hidden>Pinned</h2>
    <ol id="pinned" class="posts"></ol>
    <h2 class="section">Feed</h2>
    <p id="empty" class="muted" hidden>Nothing here yet.</p>
    <ol id="feed" class="posts"></ol>
  </section>
</main>

<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>
```

- [ ] **Step 2: Create `public/assets/board.js`**

```js
import { api, el, formatBytes, relativeTime, splitLinks, toast } from "./common.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const slug = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const base = `/r/${slug}`;
const $ = (id) => document.getElementById(id);
const composerText = $("composer-text");

const state = {
  you: null, // { name, role }
  room: null, // { slug, title, archived }
  posts: new Map(), // id → WirePost
  nodes: new Map(), // id → { key, node }, so unchanged posts (and their images) are not rebuilt
  socket: null,
  failures: 0,
  retryTimer: 0,
  stopped: true,
};

const isOwner = () => state.you?.role === "owner";

// ── Views ──────────────────────────────────────────────────────────────────

function show(view) {
  for (const id of ["join", "board", "expired", "gone"]) $(id).hidden = id !== view;
  const inRoom = view === "board";
  $("status").hidden = !inRoom;
  $("online").hidden = !inRoom;
  $("you").hidden = !inRoom;
  $("leave").hidden = !inRoom || isOwner();
}

function stopLive() {
  state.stopped = true;
  clearTimeout(state.retryTimer);
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close(1000);
  }
}

function showJoin(message) {
  stopLive();
  state.you = null;
  $("room-title").textContent = "Live Clipboard";
  $("join-heading").textContent = `Join ${slug}`;
  $("join-error").textContent = message ?? "";
  $("join-error").hidden = !message;
  show("join");
  $("join-pin").focus();
}

function showExpired() {
  stopLive();
  show("expired");
}

function showGone() {
  stopLive();
  $("room-title").textContent = "Live Clipboard";
  show("gone");
}

function enterBoard(you) {
  state.you = you;
  state.stopped = false;
  state.failures = 0;
  $("you").textContent = you.role === "owner" ? `${you.name} (owner)` : you.name;
  show("board");
  connect();
}

function setStatus(name, label) {
  $("status").dataset.state = name;
  $("status").textContent = label;
}

// ── Live connection ────────────────────────────────────────────────────────

function connect() {
  clearTimeout(state.retryTimer);
  if (state.stopped) return;
  setStatus(state.failures ? "reconnecting" : "connecting", state.failures ? "Reconnecting…" : "Connecting…");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}${base}/api/live`);
  state.socket = socket;

  socket.onopen = () => {
    state.failures = 0;
    setStatus("live", "Live");
  };
  socket.onmessage = (event) => {
    try {
      handle(JSON.parse(event.data));
    } catch (err) {
      console.error(err);
    }
  };
  socket.onclose = (event) => {
    if (state.socket !== socket) return; // closed on purpose by stopLive()
    state.socket = null;
    if (event.code === 4401) return showJoin("Your session ended. Join again.");
    if (event.code === 4404) return showGone();
    state.failures += 1;
    setStatus("reconnecting", "Reconnecting…");
    if (state.failures >= 2) {
      void probe().then((handled) => {
        if (!handled) scheduleReconnect();
      });
    } else {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  if (state.stopped) return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, state.failures - 1)) * (0.8 + Math.random() * 0.4);
  state.retryTimer = setTimeout(connect, delay);
}

/** A failed WebSocket upgrade hides its status code, so ask over HTTP. Returns true if the view changed. */
async function probe() {
  const me = await api(`${base}/api/me`);
  if (me.expired || (me.status === 401 && me.data?.error === "Owner sign-in required")) {
    showExpired();
    return true;
  }
  if (me.status === 401) {
    showJoin("Your session ended. Join again.");
    return true;
  }
  if (me.status === 404) {
    showGone();
    return true;
  }
  return false;
}

function handle(msg) {
  switch (msg.type) {
    case "snapshot":
      state.room = msg.room;
      state.you = msg.you;
      state.posts = new Map(msg.posts.map((post) => [post.id, post]));
      state.nodes.clear();
      $("online").textContent = `${msg.online} online`;
      renderRoom();
      renderPosts();
      break;
    case "post.added":
      state.posts.set(msg.post.id, msg.post);
      renderPosts(msg.post.id);
      break;
    case "post.deleted":
      state.posts.delete(msg.id);
      renderPosts();
      break;
    case "post.pinned": {
      const post = state.posts.get(msg.id);
      if (post) {
        post.pinned = msg.pinned;
        post.pinnedAt = msg.pinnedAt;
        renderPosts();
      }
      break;
    }
    case "room.updated":
      state.room = { ...state.room, ...msg.room };
      renderRoom();
      renderPosts();
      break;
    case "online":
      $("online").textContent = `${msg.count} online`;
      break;
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderRoom() {
  $("room-title").textContent = state.room.title;
  document.title = `${state.room.title} · Live Clipboard`;
  $("archived-banner").hidden = !state.room.archived;
  $("composer").hidden = state.room.archived;
}

function renderPosts(freshId) {
  const all = [...state.posts.values()];
  const pinned = all.filter((p) => p.pinned).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
  const feed = all
    .filter((p) => !p.pinned)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

  for (const id of state.nodes.keys()) if (!state.posts.has(id)) state.nodes.delete(id);
  $("pinned-heading").hidden = pinned.length === 0;
  $("pinned").replaceChildren(...pinned.map(nodeFor));
  $("feed").replaceChildren(...feed.map(nodeFor));
  $("empty").hidden = feed.length > 0;

  const fresh = freshId ? state.nodes.get(freshId)?.node : null;
  if (fresh) {
    fresh.classList.add("fresh");
    setTimeout(() => fresh.classList.remove("fresh"), 50);
  }
}

function nodeFor(post) {
  const key = JSON.stringify([post.pinned, post.pinnedAt, state.you?.role, state.room?.archived]);
  const cached = state.nodes.get(post.id);
  if (cached && cached.key === key) return cached.node;
  const node = postNode(post);
  state.nodes.set(post.id, { key, node });
  return node;
}

function postNode(post) {
  const actions = [];
  if (post.kind === "text") {
    actions.push(el("button", { type: "button", text: "Copy", onclick: () => copyText(post.text) }));
  } else {
    actions.push(el("a", { class: "button-link", href: post.file.url, download: post.file.name, text: "Download" }));
  }
  if (isOwner()) {
    actions.push(el("button", { type: "button", text: post.pinned ? "Unpin" : "Pin", onclick: () => setPinned(post.id, !post.pinned) }));
  }
  if (isOwner() || (post.mine && !state.room?.archived)) {
    actions.push(el("button", { type: "button", class: "danger", text: "Delete", onclick: (event) => deletePost(post.id, event.currentTarget) }));
  }

  const head = el("div", { class: "post-head" }, [
    el("span", { class: "post-author", text: post.authorName }),
    post.authorRole === "owner" ? el("span", { class: "badge", text: "owner" }) : null,
    el("time", {
      class: "muted",
      datetime: new Date(post.createdAt).toISOString(),
      dataset: { time: String(post.createdAt) },
      text: relativeTime(post.createdAt),
    }),
    el("span", { class: "post-actions" }, actions),
  ]);

  let body;
  if (post.kind === "text") {
    body = el(
      "pre",
      { class: "post-text" },
      splitLinks(post.text).map((part) =>
        part.type === "link"
          ? el("a", { href: part.value, target: "_blank", rel: "noopener noreferrer", text: part.value })
          : part.value,
      ),
    );
  } else {
    const image = INLINE_IMAGES.has(post.file.type)
      ? el("a", { href: post.file.url, target: "_blank", rel: "noopener" }, [
          el("img", { class: "thumb", src: post.file.url, alt: post.file.name, loading: "lazy" }),
        ])
      : null;
    body = el("div", { class: "post-file" }, [
      el("span", { text: `📎 ${post.file.name} · ${formatBytes(post.file.size)}` }),
      image,
    ]);
  }
  return el("li", { class: "post", dataset: { id: post.id } }, [head, body]);
}

// ── Actions ────────────────────────────────────────────────────────────────

function reportFailure(res) {
  if (res.expired) return showExpired();
  if (res.status === 401) return void probe();
  const wait = res.data?.retryAfter ? ` Try again in ${res.data.retryAfter} s.` : "";
  toast(`${res.data?.error ?? "Something went wrong."}${wait}`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed. Select the text and copy it by hand.");
  }
}

async function setPinned(id, pinned) {
  const res = await api(`${base}/api/posts/${id}/pin`, { method: "POST", body: { pinned } });
  if (!res.ok) reportFailure(res);
}

async function deletePost(id, button) {
  button.disabled = true;
  const res = await api(`${base}/api/posts/${id}`, { method: "DELETE" });
  if (!res.ok) {
    button.disabled = false;
    reportFailure(res);
  }
}

async function submitText() {
  const text = composerText.value;
  if (text.trim() === "") return;
  const button = $("composer-submit");
  button.disabled = true;
  const res = await api(`${base}/api/posts`, { method: "POST", body: { text } });
  button.disabled = false;
  if (!res.ok) return reportFailure(res);
  if (composerText.value === text) composerText.value = "";
  composerText.focus();
}

function canUpload() {
  return !$("board").hidden && state.room && !state.room.archived;
}

function startUpload(file) {
  const progress = el("progress", { max: "100", value: "0" });
  const row = el("li", { class: "upload" }, [el("span", { text: `${file.name} · ${formatBytes(file.size)}` }), progress]);
  $("uploads").append(row);

  const failRow = (message) => {
    progress.remove();
    row.append(
      el("span", { class: "error", text: message }),
      el("button", { type: "button", text: "Retry", onclick: () => { row.remove(); startUpload(file); } }),
      el("button", { type: "button", class: "link", text: "Dismiss", onclick: () => row.remove() }),
    );
  };

  if (file.size === 0) return failRow("This file is empty.");
  if (file.size > MAX_FILE_BYTES) return failRow("Files can be at most 25 MB.");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${base}/api/files`);
  xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name || "pasted-file"));
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) progress.value = Math.round((event.loaded / event.total) * 100);
  };
  xhr.onload = () => {
    if (xhr.status === 201) return row.remove();
    let message = "Upload failed.";
    try {
      message = JSON.parse(xhr.responseText).error ?? message;
    } catch {
      // keep the generic message
    }
    failRow(message);
  };
  xhr.onerror = () => failRow("Upload failed. Check your connection.");
  xhr.send(file);
}

function uploadFiles(files) {
  if (!canUpload()) return;
  for (const file of files) startUpload(file);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("join-name").value;
  $("join-submit").disabled = true;
  const res = await api(`${base}/api/join`, { method: "POST", body: { pin: $("join-pin").value, name } });
  $("join-submit").disabled = false;
  if (res.ok) {
    $("join-pin").value = "";
    try {
      localStorage.setItem("clip-name", name.trim());
    } catch {
      // storage unavailable (private mode); the name just isn't remembered
    }
    return enterBoard({ name: res.data.name, role: "participant" });
  }
  if (res.status === 429 && res.data?.retryAfter) {
    const minutes = Math.ceil(res.data.retryAfter / 60);
    return showJoin(`Too many attempts, try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
  showJoin(res.data?.error ?? "Could not join. Try again.");
});

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitText();
});

composerText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submitText();
  }
});

document.addEventListener("paste", (event) => {
  if ($("board").hidden) return;
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0) {
    event.preventDefault();
    uploadFiles(files);
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target === composerText || ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
  if ($("composer").hidden) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  composerText.value += text;
  composerText.focus();
});

// Phones cannot paste or drop files, so the composer also offers a file picker.
$("file-input").addEventListener("change", (event) => {
  const input = event.currentTarget;
  uploadFiles([...input.files]);
  input.value = "";
});

document.addEventListener("dragover", (event) => {
  if (canUpload() && event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
    document.body.classList.add("dropping");
  }
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dropping");
});
document.addEventListener("drop", (event) => {
  document.body.classList.remove("dropping");
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  event.preventDefault();
  uploadFiles(files);
});

$("leave").addEventListener("click", async () => {
  await api(`${base}/api/leave`, { method: "POST" });
  showJoin();
});

$("reload").addEventListener("click", () => location.reload());

setInterval(() => {
  for (const node of document.querySelectorAll("time[data-time]")) {
    node.textContent = relativeTime(Number(node.dataset.time));
  }
}, 30_000);

try {
  $("join-name").value = localStorage.getItem("clip-name") ?? "";
} catch {
  // storage unavailable
}

async function start() {
  const me = await api(`${base}/api/me`);
  if (me.expired || (me.status === 401 && me.data?.error === "Owner sign-in required")) return showExpired();
  if (me.ok) return enterBoard(me.data);
  if (me.status === 401) return showJoin();
  if (me.status === 404) return showJoin();
  toast(me.data?.error ?? "Could not load the room.");
}

void start();
```

Note on `.post.fresh`: the CSS turns the transition off while `fresh` is set, and removing the class 50 ms later lets the highlight fade over 1.5 s.

A `404` from `/api/me` (a participant cookie for a room that no longer exists) shows the join form, not "gone". That keeps unknown rooms indistinguishable from wrong PINs on the public door.

- [ ] **Step 3: Run the tests and type check**

Run: `npm test && npm run typecheck`
Expected: all green. The page marker `content="board"` is unchanged.

- [ ] **Step 4: Start the local Worker**

Run in the background: `npm run dev`
Expected: `Ready on http://127.0.0.1:8787`. Room `demo` from Task 11 still exists in `.wrangler/state`. If it doesn't, create it at `http://127.0.0.1:8787/` with PIN `482913`.

- [ ] **Step 5: Verify in two browser tabs with the `/browse` skill**

Use the gstack `/browse` skill. Tab P is the participant (`http://localhost:8787/r/demo`). Tab O is the owner (`http://127.0.0.1:8787/r/demo`). Take a screenshot at each ★.

1. **Tab P:** the join form reads "Join demo". Submit PIN `000000` with name `Kristi`: "Room or PIN not recognized". ★
2. **Tab P:** submit PIN `482913` with name `Kristi`. The board shows "Demo room 2" (or the current title), "● Live", "1 online", "Kristi", Leave, and "Nothing here yet."
3. **Tab O:** the board shows "Dimitris (owner)", no Leave button, and the online count in both tabs becomes "2 online".
4. **Tab P:** type `claude --model sonnet` on one line and `https://github.com/dimitris-am/agna-starter` on the next, then press Ctrl+Enter. The post appears in both tabs within a second, with the link clickable and a Copy and a Delete button in P. Tab O shows Copy, Pin and Delete. ★
5. **Tab O:** type a post and click **Post**. It shows the **owner** badge in both tabs. Click **Pin** on it: a "Pinned" section appears at the top in both tabs, and O's button reads **Unpin**. ★
6. **Tab P:** set a small PNG named `shot.png` on the **Attach file** input (`#file-input`). The post shows `📎 shot.png · … KB` with a thumbnail in both tabs, and **Download** works. ★ If `/browse` cannot set files on an input, skip this item and add "file upload in the browser" to the manual checklist Dimitris runs in Task 13. The HTTP upload path is already covered by `board-api.test.ts`.
7. **Tab P:** delete its own text post: it disappears in both tabs.
8. **Admin tab** (`http://127.0.0.1:8787/`): archive `demo`. Tab P shows "This room is archived. It is read-only." with the composer hidden, and Delete no longer shows on P's own posts. Tab O keeps Pin and Delete. Unarchive again. ★
9. **Admin tab:** change the `demo` PIN. Tab P returns to the join form with "Your session ended. Join again." Tab O stays live.
10. **Tab P:** join with the new PIN, then click **Leave**: back to the join form.
11. **Stop and restart `npm run dev`** while both tabs are open. Both tabs show "Reconnecting…", then "Live" again once the server is back, with posts intact.
12. At 400px viewport width, the board is a single column with no horizontal page scroll. ★

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add public/board.html public/assets/board.js
git commit -m "Add live board page: join, posts, pins, uploads, reconnects"
```

---

### Task 13: Deploy and hand-off

**Files:**
- Modify: `wrangler.jsonc` (real `database_id` in both D1 blocks)
- Create: `README.md`
- Modify: `docs/deploy-notes.md`
- Delete: `probe/`

**Interfaces:**
- Consumes: everything above, plus the Access application and values from Task 1.
- Produces: the live service at `https://clip.dimitrismitsis.com` and `https://clip-admin.dimitrismitsis.com`, with room `agna-2026` created.

- [ ] **Step 1: Pre-flight**

Run: `npm test && npm run typecheck`
Expected: all green.

Check `wrangler.jsonc`: `env.production.vars.ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` must equal the values in `docs/deploy-notes.md`, not `TEAM` or `AUD_TAG_FROM_DEPLOY_NOTES`. If they don't, fix them now.

- [ ] **Step 2: Create the R2 bucket**

Run: `npx wrangler r2 bucket create live-clipboard-files`
Expected: `Created bucket 'live-clipboard-files'`. If Wrangler says R2 is not enabled for the account, **HAND OVER**: Dimitris enables R2 in the dashboard (it may ask for a payment method even on the free tier), then re-run.

- [ ] **Step 3: Create the D1 database and apply the migration**

Run: `npx wrangler d1 create live-clipboard`
Expected: output containing `"database_id": "<uuid>"`.

Put that UUID into **both** `database_id` fields in `wrangler.jsonc` (top level and `env.production`). The local database ignores it, so tests are unaffected.

Run: `npx wrangler d1 migrations apply live-clipboard --remote --env production`
Expected: `0001_rooms.sql` is applied.

- [ ] **Step 4: Remove the probe**

Run: `npx wrangler delete --name clip-probe`
Expected: the probe Worker is deleted, which frees the `clip-admin.dimitrismitsis.com` custom domain. If Wrangler waits for a confirmation it cannot get, **HAND OVER**: ask Dimitris to run `! npx wrangler delete --name clip-probe`.

Run: `git rm -r probe`

The Access application stays. It belongs to the hostname, not to the Worker.

- [ ] **Step 5: Deploy**

Run: `npm run deploy`
Expected: the output lists `clip.dimitrismitsis.com (custom domain)` and `clip-admin.dimitrismitsis.com (custom domain)`, and the bindings `ROOMS`, `FILES`, `DB`, `ASSETS`.

If the deploy fails because Durable Objects need a paid plan (spec §14 lists SQLite-backed Durable Objects on the free plan as believed but unverified), **HAND OVER**. Dimitris decides whether to enable Workers Paid ($5/month). Nothing else in the plan changes.

- [ ] **Step 6: Write `README.md`**

````markdown
# Live Clipboard

A live shared clipboard for courses and talks. Participants join a room on `clip.dimitrismitsis.com` with a PIN and their name. Owners run rooms on `clip-admin.dimitrismitsis.com`, behind Cloudflare Access (email one-time PIN). Text, links and files appear for everyone in real time.

Design: `docs/superpowers/specs/2026-09-13-live-clipboard-design.md` · Plan: `docs/superpowers/plans/2026-09-13-live-clipboard.md` · Cloudflare values: `docs/deploy-notes.md`

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply live-clipboard --local
npm run dev
```

- Admin door: http://127.0.0.1:8787/ (you are the owner named by `DEV_OWNER_EMAIL`)
- Public door: http://localhost:8787/r/<slug>

The Worker decides who you are **by hostname**, so use the two hostnames exactly as shown.

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

- **Leaked PIN:** if the PIN leaks (someone photographs the slide), use **Change PIN**. Everyone is signed out and rejoins with the new PIN.
- **Projecting:** use browser zoom.

## After

- **Archive** the room: it becomes read-only, and participants who still know the PIN can keep copying from it.
- **Delete** it when it is no longer needed. That removes every post and file. If file cleanup fails, the admin page shows "Deletion incomplete" with **Retry deletion**.

## Manual check after each deploy

1. **Owner sign-in:** open the admin door in a private window. Access asks for an email, and the emailed PIN signs you in.
2. **Join:** create a test room. Join it on a phone and on a laptop with different names.
3. **Posting:** post text containing a link, copy it, paste a screenshot on the laptop, attach a photo on the phone, and download a file.
4. **Owner controls:** pin a post from the owner board, then archive and unarchive the room.
5. **Change PIN:** the phone returns to the join form.
6. **Reconnect:** toggle Wi-Fi on the laptop. The board shows "Reconnecting…", then "Live".
7. **Clean up:** delete the test room.
````

- [ ] **Step 7: HAND OVER to Dimitris for the production check**

Ask Dimitris to run the "Manual check after each deploy" list from `README.md` on a phone and a laptop. Add "file upload in the browser" if Task 12 Step 5 skipped it. Also add: "Leave the owner board open past the Access session length (or revoke the session in Zero Trust), and confirm it shows 'Session expired — sign in again' rather than looping." He reports each item as pass or fail. **Any fail stops the task.** Debug with `superpowers:systematic-debugging` before continuing.

- [ ] **Step 8: Create the AGNA room**

On `https://clip-admin.dimitrismitsis.com/`, Dimitris (or the executor, driving his signed-in browser only if he asks) creates:
- slug `agna-2026`
- title `Claude Code at AGNA`
- a PIN of his choice

On the owner board `https://clip-admin.dimitrismitsis.com/r/agna-2026`, post `https://github.com/dimitris-am/agna-starter` and pin it.

Remind Dimitris of the two things outside this repository:
- A HackMD fallback note.
- The slide carrying `https://clip.dimitrismitsis.com/r/agna-2026` and the PIN. That is a change to the course deck in `agna-prospectus`, and a separate task.

- [ ] **Step 9: Record the deploy**

Append to `docs/deploy-notes.md`:

```markdown
## Production (deployed in Task 13, YYYY-MM-DD)

- Worker: live-clipboard (env.production), custom domains clip.dimitrismitsis.com and clip-admin.dimitrismitsis.com
- R2 bucket: live-clipboard-files
- D1 database: live-clipboard, database_id <uuid>
- Probe Worker clip-probe: deleted
- Manual production check: passed (YYYY-MM-DD)
- Room agna-2026 created; agna-starter link pinned
```

Replace `YYYY-MM-DD` and `<uuid>` with the real values. Leave no placeholders.

- [ ] **Step 9b: Rate-limit joins at the edge**

Ask Dimitris to add a Cloudflare WAF rate-limiting rule in the `dimitrismitsis.com` zone:
- **Matches:** `http.host eq "clip.dimitrismitsis.com" and ends_with(http.request.uri.path, "/api/join")`
- **Limit:** 30 requests per 10 seconds per IP
- **Action:** block for 60 seconds

- [ ] **Step 10: Commit**

```bash
git add wrangler.jsonc README.md docs/deploy-notes.md
git commit -m "Deploy to production, add README and remove the Access probe"
```

(The `git rm -r probe` from Step 4 is already staged.)

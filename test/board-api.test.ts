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
    expect(await (await publicFetch("/any-room")).text()).toContain('content="board"');
    expect(await (await adminFetch("/any-room")).text()).toContain('content="board"');
  });

  it("serves the board at /<slug> and no longer at the old /r/<slug> path", async () => {
    const atRoot = await publicFetch("/some-room");
    expect(atRoot.status).toBe(200);
    expect(await atRoot.text()).toContain('content="board"');
    const atRootAdmin = await adminFetch("/some-room");
    expect(atRootAdmin.status).toBe(200);
    expect(await atRootAdmin.text()).toContain('content="board"');

    // "/r/some-room" is now parsed as room "r" (a syntactically valid one-character slug, not
    // reserved) with rest "/some-room", which no route recognizes. An anonymous public-door
    // request never gets past the credential check, so it fails closed with 401 rather than
    // reaching board-serving code at all; the admin door is already authenticated as the owner,
    // so it falls through every route to the router's own 404. Neither path serves a room.
    const oldPathPublic = await publicFetch("/r/some-room");
    expect(oldPathPublic.status).toBe(401);
    expect(await oldPathPublic.json()).toEqual({ error: "Join the room first" });

    const oldPathAdmin = await adminFetch("/r/some-room");
    expect(oldPathAdmin.status).toBe(404);
    await oldPathAdmin.body?.cancel();
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
    const res = await publicFetch("/api-join/api/join", json({ pin: "482913", name: "  Kristi " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Kristi" });
    expect(res.headers.getSetCookie()[0]).toMatch(
      /^clip_session=[0-9a-f]{32}; Path=\/api-join; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("answers a wrong PIN and an unknown room identically", async () => {
    await makeRoom("api-wrong");
    const wrong = await publicFetch("/api-wrong/api/join", json({ pin: "000000", name: "Kristi" }));
    const unknown = await publicFetch("/api-nowhere/api/join", json({ pin: "482913", name: "Kristi" }));
    expect(wrong.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "Room or PIN not recognized" });
    expect(await unknown.json()).toEqual({ error: "Room or PIN not recognized" });
  });

  it("requires a name", async () => {
    await makeRoom("api-name");
    const res = await publicFetch("/api-name/api/join", json({ pin: "482913", name: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter a name of 1 to 40 characters" });
  });

  it("returns 429 with Retry-After on the 21st failure from one IP", async () => {
    await makeRoom("api-limit");
    const attempt = () =>
      publicFetch("/api-limit/api/join", {
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

  it("keys IPv6 join failures by /64, so rotating the suffix does not evade the limit", async () => {
    await makeRoom("api-limit-v6");
    const attempt = (ip: string) =>
      publicFetch("/api-limit-v6/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ pin: "000000", name: "x" }),
      });
    for (let i = 0; i < 20; i++) {
      const res = await attempt("2001:db8:1:2::1");
      expect(res.status).toBe(403);
      await res.body?.cancel();
    }
    const limited = await attempt("2001:db8:1:2::ffff");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "Too many attempts" });
  });

  it("does not offer joining on the admin door", async () => {
    await makeRoom("api-adminjoin");
    const res = await adminFetch("/api-adminjoin/api/join", json({ pin: "482913", name: "Kristi" }));
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });
});

describe("participant API", () => {
  it("resolves the session cookie and rejects missing or forged credentials", async () => {
    await makeRoom("api-me");
    const cookie = await joinRoom("api-me");
    expect(await (await publicFetch("/api-me/api/me", { headers: { Cookie: cookie } })).json()).toEqual({
      name: "Kristi",
      role: "participant",
    });

    const anonymous = await publicFetch("/api-me/api/me");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Join the room first" });
    expect(anonymous.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const forged = await publicFetch("/api-me/api/posts", {
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

    const created = await publicFetch("/api-posts/api/posts", withCookie({ text: "claude --effort high" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: expect.stringMatching(/^[0-9a-z]{26}$/) });

    const blank = await publicFetch("/api-posts/api/posts", withCookie({ text: "   " }));
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "Posts must be 1 to 20,000 characters and not only spaces" });
  });

  it("refuses POSTs and WebSocket upgrades from another origin", async () => {
    await makeRoom("api-origin");
    const cookie = await joinRoom("api-origin");
    const post = await publicFetch("/api-origin/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://evil.example" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: "Cross-site request refused" });

    const upgrade = await publicFetch("/api-origin/api/live", {
      headers: { Upgrade: "websocket", Cookie: cookie, Origin: "https://evil.example" },
    });
    expect(upgrade.status).toBe(403);
    await upgrade.body?.cancel();
  });

  it("opens the live socket with the session cookie", async () => {
    await makeRoom("api-live");
    const cookie = await joinRoom("api-live");
    const res = await publicFetch("/api-live/api/live", { headers: { Upgrade: "websocket", Cookie: cookie } });
    expect(res.status).toBe(101);
    const socket = acceptSocket(res);
    expect((await socket.nextOfType("snapshot")).you).toEqual({ name: "Kristi", role: "participant" });
  });

  it("leave clears the cookie and ends the session", async () => {
    await makeRoom("api-leave");
    const cookie = await joinRoom("api-leave");
    const res = await publicFetch("/api-leave/api/leave", { method: "POST", headers: { Cookie: cookie } });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toBe(
      "clip_session=; Path=/api-leave; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    const me = await publicFetch("/api-leave/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
    await me.body?.cancel();
  });

  it("does not accept one room's session in another room", async () => {
    await makeRoom("api-room-a");
    await makeRoom("api-room-b");
    const cookie = await joinRoom("api-room-a");
    const res = await publicFetch("/api-room-b/api/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("lets participants delete their own posts but not pin", async () => {
    await makeRoom("api-delete");
    const cookie = await joinRoom("api-delete");
    const created = await publicFetch("/api-delete/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "mine" }),
    });
    const { id } = await created.json<{ id: string }>();

    const pin = await publicFetch(`/api-delete/api/posts/${id}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(404);
    await pin.body?.cancel();

    const deleted = await publicFetch(`/api-delete/api/posts/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(deleted.status).toBe(204);
  });

  it("does not reveal whether a room exists to a made-up session", async () => {
    await makeRoom("api-exists");
    const cookie = `clip_session=${"0".repeat(32)}`;

    const exists = await publicFetch("/api-exists/api/me", { headers: { Cookie: cookie } });
    const missing = await publicFetch("/api-nowhere-else/api/me", { headers: { Cookie: cookie } });
    expect(exists.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await exists.json()).toEqual({ error: "Your session has ended. Join again." });
    expect(await missing.json()).toEqual({ error: "Your session has ended. Join again." });

    const upgrade = await publicFetch("/api-nowhere-else/api/live", {
      headers: { Upgrade: "websocket", Cookie: cookie },
    });
    expect(upgrade.status).toBe(401);
    await upgrade.body?.cancel();
  });
});

describe("owner API on the admin door", () => {
  it("acts as the owner, pins and deletes any post", async () => {
    await makeRoom("api-owner");
    const cookie = await joinRoom("api-owner");
    const created = await publicFetch("/api-owner/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "participant post" }),
    });
    const { id } = await created.json<{ id: string }>();

    expect(await (await adminFetch("/api-owner/api/me")).json()).toEqual({ name: "Dimitris", role: "owner" });

    const pin = await adminFetch(`/api-owner/api/posts/${id}/pin`, json({ pinned: true }));
    expect(pin.status).toBe(204);

    const live = await adminFetch("/api-owner/api/live", { headers: { Upgrade: "websocket" } });
    const snapshot = await acceptSocket(live).nextOfType("snapshot");
    expect((snapshot.posts as WirePost[])[0]).toMatchObject({ id, pinned: true, mine: false });

    const badPin = await adminFetch(`/api-owner/api/posts/${id}/pin`, json({ pinned: "yes" }));
    expect(badPin.status).toBe(400);
    expect(await badPin.json()).toEqual({ error: "Send pinned as true or false" });

    const deleted = await adminFetch(`/api-owner/api/posts/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  it("lists the people in a room on the admin door only", async () => {
    await makeRoom("api-people");
    const cookie = await joinRoom("api-people", "Kristi");

    const people = await adminFetch("/api-people/api/people");
    expect(people.status).toBe(200);
    expect(people.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await people.json()).toEqual([{ name: "Kristi", role: "participant", online: false }]);

    const asParticipant = await publicFetch("/api-people/api/people", { headers: { Cookie: cookie } });
    expect(asParticipant.status).toBe(404);
    await asParticipant.body?.cancel();
  });
});

describe("files over HTTP", () => {
  async function upload(slug: string, cookie: string, bytes: Uint8Array, name: string, type: string) {
    return publicFetch(`/${slug}/api/files`, {
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

    const file = await publicFetch(`/api-files/files/${id}`, { headers: { Cookie: cookie } });
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

    const file = await publicFetch(`/api-svg/files/${id}`, { headers: { Cookie: cookie } });
    expect(file.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(file.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''logo.svg");
    await file.body?.cancel();

    const otherRoom = await publicFetch(`/api-svg-other/files/${id}`, { headers: { Cookie: otherCookie } });
    expect(otherRoom.status).toBe(404);
    await otherRoom.body?.cancel();

    const stranger = await publicFetch(`/api-svg/files/${id}`);
    expect(stranger.status).toBe(401);
    await stranger.body?.cancel();
  });
});

describe("exporting a room", () => {
  const withCookie = (cookie: string, body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

  it("hands a participant the room as a Markdown download, oldest post first", async () => {
    await makeRoom("api-export");
    const cookie = await joinRoom("api-export", "Kristi");
    await publicFetch("/api-export/api/posts", withCookie(cookie, { text: "first thing" }));
    await publicFetch("/api-export/api/posts", withCookie(cookie, { text: "second thing" }));

    const res = await publicFetch("/api-export/export", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="api-export-\d{4}-\d{2}-\d{2}\.md"$/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const body = await res.text();
    expect(body).toContain("# API room");
    expect(body).toContain("### Kristi · ");
    expect(body.indexOf("first thing")).toBeLessThan(body.indexOf("second thing"));
  });

  it("stamps times in the timezone the board sends, and falls back to UTC", async () => {
    await makeRoom("api-export-tz");
    const cookie = await joinRoom("api-export-tz");

    const athens = await publicFetch("/api-export-tz/export?tz=Europe/Athens", { headers: { Cookie: cookie } });
    expect(await athens.text()).toContain(" Europe/Athens · ");

    const junk = await publicFetch("/api-export-tz/export?tz=Nowhere/Fake", { headers: { Cookie: cookie } });
    expect(await junk.text()).toContain(" UTC · ");
  });

  it("exports for the owner through the admin door", async () => {
    await makeRoom("api-export-owner");
    const res = await adminFetch("/api-export-owner/export");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("_No posts yet._");
  });

  it("refuses anyone without a live session", async () => {
    await makeRoom("api-export-401");
    const stranger = await publicFetch("/api-export-401/export");
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: "Join the room first" });

    const ended = await publicFetch("/api-export-401/export", {
      headers: { Cookie: `clip_session=${"a1b2".repeat(8)}` },
    });
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "Your session has ended. Join again." });
  });
});

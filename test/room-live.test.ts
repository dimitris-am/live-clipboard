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

  it("answers a heartbeat ping with pong, so the client can detect dead connections", async () => {
    await createRoom("live-heartbeat");
    const kristi = await joinAs("live-heartbeat", "Kristi");
    const a = await connect("live-heartbeat", kristi);
    a.ws.send("ping");
    expect(await a.nextOfType("pong", 500)).toEqual({ type: "pong" });
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

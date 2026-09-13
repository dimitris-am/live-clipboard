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

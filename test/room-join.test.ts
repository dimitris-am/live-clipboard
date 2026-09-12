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

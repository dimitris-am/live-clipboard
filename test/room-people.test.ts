import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Room } from "../src/room/room";
import { ownerCred, type Cred } from "../src/room/types";
import { acceptSocket, OWNER } from "./helpers";

const owner = ownerCred(OWNER);
const stub = (slug: string) => env.ROOMS.getByName(slug);

async function createRoom(slug: string) {
  expect((await stub(slug).init({ slug, title: "People room", pin: "482913" })).ok).toBe(true);
  return stub(slug);
}

async function joinAs(slug: string, name: string): Promise<Cred> {
  const joined = await stub(slug).join({ pin: "482913", name, ip: "198.51.100.40" });
  if (!joined.ok) throw new Error(joined.error);
  return { kind: "session", sessionId: joined.value.sessionId };
}

async function connect(slug: string, cred: Cred) {
  const res = await stub(slug).fetch("https://room.internal/live", {
    headers: { Upgrade: "websocket", "X-Clip-Cred": JSON.stringify(cred) },
  });
  expect(res.status).toBe(101);
  const socket = acceptSocket(res);
  await socket.nextOfType("snapshot");
  return socket;
}

describe("people list", () => {
  it("lists everyone who joined, connected people first, with connected owners", async () => {
    const room = await createRoom("people-list");
    const kristi = await joinAs("people-list", "Kristi");
    await joinAs("people-list", "Jani"); // joined but never opened the board
    const ana = await joinAs("people-list", "Ana");
    await connect("people-list", kristi);
    await connect("people-list", owner);
    await connect("people-list", ana);

    expect(await room.people(owner)).toEqual({
      ok: true,
      value: [
        { name: "Dimitris", role: "owner", online: true },
        { name: "Kristi", role: "participant", online: true },
        { name: "Ana", role: "participant", online: true },
        { name: "Jani", role: "participant", online: false },
      ],
    });
  });

  it("drops sessions that have expired", async () => {
    const room = await createRoom("people-expiry");
    await joinAs("people-expiry", "Kristi");
    await runInDurableObject(room, (_instance: Room, state) => {
      state.storage.sql.exec("UPDATE sessions SET expires_at = ? WHERE name = 'Kristi'", Date.now() - 1);
    });
    await joinAs("people-expiry", "Jani");

    expect(await room.people(owner)).toEqual({
      ok: true,
      value: [{ name: "Jani", role: "participant", online: false }],
    });
  });

  it("is owner-only", async () => {
    const room = await createRoom("people-owner-only");
    const kristi = await joinAs("people-owner-only", "Kristi");
    expect(await room.people(kristi)).toEqual({ ok: false, status: 403, error: "Only owners can do that" });
  });
});

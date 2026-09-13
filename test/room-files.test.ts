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
        url: `/files-commit/files/${grant.value.postId}`,
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

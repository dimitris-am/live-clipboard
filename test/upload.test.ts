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

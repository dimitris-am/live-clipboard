import { DurableObject } from "cloudflare:workers";
import { constantTimeEqual, newPostId, newSessionId } from "../ids";
import {
  JOIN_FAILURES_PER_WINDOW,
  JOIN_WINDOW_MS,
  MAX_FILE_BYTES,
  POST_WINDOW_MS,
  POSTS_PER_MINUTE,
  ROOM_QUOTA_BYTES,
  SESSION_MS,
} from "../limits";
import { fail, ok, type Fail, type Result } from "../results";
import { countSince, oldestSince, pruneBefore, record } from "./rate";
import { migrate } from "./schema";
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
import { toWirePost } from "./wire";

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
    if (!room) {
      // A made-up session cookie must not distinguish a missing room from an ended session.
      return cred.kind === "session" ? fail(401, "Your session has ended. Join again.") : fail(404, "Room not found");
    }
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
    if (!room) {
      // A made-up session cookie must not distinguish a missing room from an ended session.
      return cred.kind === "session"
        ? new Response("Your session has ended. Join again.", { status: 401 })
        : new Response("Room not found", { status: 404 });
    }
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
}

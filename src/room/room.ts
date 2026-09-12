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

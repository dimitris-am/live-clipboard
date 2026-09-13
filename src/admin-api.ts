import { errorResponse, json, notFound, readJson } from "./http";
import type { Owner } from "./owners";
import { deletePrefix } from "./r2";
import { ownerCred, type RoomInfo } from "./room/types";
import { isReservedSlug, isSlug, parsePin, parseTitle } from "./validate";

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
    if (isReservedSlug(slug)) return json({ error: "That room name is reserved" }, 400);
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

import { downloadHeaders } from "./files";
import {
  clearedSessionCookie,
  errorResponse,
  json,
  notFound,
  readCookie,
  readJson,
  servePage,
  SESSION_COOKIE,
  sessionCookie,
} from "./http";
import { isSessionId } from "./ids";
import { rateLimitAddress } from "./net";
import type { Owner } from "./owners";
import type { Result } from "./results";
import { ownerCred, type Cred, type UploadGrant } from "./room/types";
import { uploadFile } from "./upload";
import { parseName, parsePostText } from "./validate";

export type Door = "public" | "admin";

export type BoardContext = {
  door: Door;
  /** Set on the admin door only, after authenticateOwner() succeeded. */
  owner: Owner | null;
  slug: string;
  /** The path after /r/<slug>, e.g. "" or "/api/posts". */
  rest: string;
};

const POST_ID = "([0-9a-z]{26})";
const POST_ROUTE = new RegExp(`^/api/posts/${POST_ID}$`);
const PIN_ROUTE = new RegExp(`^/api/posts/${POST_ID}/pin$`);
const FILE_ROUTE = new RegExp(`^/files/${POST_ID}$`);

function credFor(request: Request, ctx: BoardContext): Cred | null {
  if (ctx.door === "admin") return ctx.owner ? ownerCred(ctx.owner) : null;
  const sessionId = readCookie(request, SESSION_COOKIE);
  return isSessionId(sessionId) ? { kind: "session", sessionId } : null;
}

const noContent = () => new Response(null, { status: 204 });

export async function handleBoard(request: Request, env: Env, ctx: BoardContext): Promise<Response> {
  const { door, slug, rest } = ctx;
  const method = request.method;
  const room = env.ROOMS.getByName(slug);

  if (rest === "" && method === "GET") return servePage(request, env.ASSETS, "board.html");

  if (rest === "/api/join" && method === "POST" && door === "public") {
    const body = await readJson(request);
    const name = parseName(body?.name);
    if (!name) return json({ error: "Enter a name of 1 to 40 characters" }, 400);
    const pin = typeof body?.pin === "string" ? body.pin : "";
    const ip = rateLimitAddress(request.headers.get("CF-Connecting-IP"));
    const joined = await room.join({ pin, name, ip });
    if (!joined.ok) return errorResponse(joined);
    return json({ name: joined.value.name }, 200, {
      "Set-Cookie": sessionCookie(slug, joined.value.sessionId, joined.value.maxAgeSeconds),
    });
  }

  const cred = credFor(request, ctx);
  if (!cred) return json({ error: "Join the room first" }, 401);

  if (rest === "/api/me" && method === "GET") {
    const me = await room.me(cred);
    return me.ok ? json(me.value) : errorResponse(me);
  }

  if (rest === "/api/leave" && method === "POST" && door === "public") {
    await room.leave(cred);
    return new Response(null, { status: 204, headers: { "Set-Cookie": clearedSessionCookie(slug) } });
  }

  if (rest === "/api/live" && method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade" }, 426);
    }
    // A fresh request: only the upgrade and the credential the Worker vouches for reach the room.
    return room.fetch(
      new Request("https://room.internal/live", {
        headers: { Upgrade: "websocket", "X-Clip-Cred": JSON.stringify(cred) },
      }),
    );
  }

  if (rest === "/api/posts" && method === "POST") {
    const body = await readJson(request);
    const text = parsePostText(body?.text);
    if (text === null) return json({ error: "Posts must be 1 to 20,000 characters and not only spaces" }, 400);
    const added = await room.addText(cred, text);
    return added.ok ? json(added.value, 201) : errorResponse(added);
  }

  if (rest === "/api/files" && method === "POST") {
    return uploadFile(
      request,
      env.FILES,
      {
        authorizeUpload: async (c, size, name) => (await room.authorizeUpload(c, size, name)) as Result<UploadGrant>,
        commitFile: async (c, meta) => (await room.commitFile(c, meta)) as Result<{ id: string }>,
      },
      cred,
    );
  }

  const postMatch = POST_ROUTE.exec(rest);
  if (postMatch && method === "DELETE") {
    const deleted = await room.deletePost(cred, postMatch[1]!);
    return deleted.ok ? noContent() : errorResponse(deleted);
  }

  const pinMatch = PIN_ROUTE.exec(rest);
  if (pinMatch && method === "POST" && door === "admin") {
    const body = await readJson(request);
    if (typeof body?.pinned !== "boolean") return json({ error: "Send pinned as true or false" }, 400);
    const pinned = await room.setPinned(cred, pinMatch[1]!, body.pinned);
    return pinned.ok ? noContent() : errorResponse(pinned);
  }

  const fileMatch = FILE_ROUTE.exec(rest);
  if (fileMatch && method === "GET") {
    const ref = await room.getFile(cred, fileMatch[1]!);
    if (!ref.ok) return errorResponse(ref);
    const object = await env.FILES.get(ref.value.r2Key);
    if (!object) return json({ error: "File not found" }, 404);
    return new Response(object.body, { headers: downloadHeaders(ref.value.type, ref.value.name) });
  }

  return notFound();
}

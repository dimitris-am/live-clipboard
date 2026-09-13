import { handleAdminApi } from "./admin-api";
import { handleBoard, type Door } from "./board-api";
import { isSameOrigin, json, notFound, serveAsset, servePage } from "./http";
import { authenticateOwner, type Owner } from "./owners";
import { isSlug } from "./validate";

export { Room } from "./room/room";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const door: Door | null =
      url.host === env.PUBLIC_HOST ? "public" : url.host === env.ADMIN_HOST ? "admin" : null;
    if (!door) return new Response("Not found", { status: 404 });
    if (!isSameOrigin(request)) return json({ error: "Cross-site request refused" }, 403);

    let owner: Owner | null = null;
    if (door === "admin") {
      owner = await authenticateOwner(request, env);
      if (!owner) return json({ error: "Owner sign-in required" }, 401);
    }

    const path = url.pathname;
    if (request.method === "GET" && path.startsWith("/assets/")) return serveAsset(request, env.ASSETS);
    if (request.method === "GET" && path === "/") {
      return servePage(request, env.ASSETS, door === "admin" ? "admin.html" : "home.html");
    }
    if (path.startsWith("/api/")) {
      return door === "admin" && owner ? handleAdminApi(request, env, owner, path) : notFound();
    }

    const match = /^\/r\/([^/]+)(\/.*)?$/.exec(path);
    if (match && isSlug(match[1])) {
      return handleBoard(request, env, { door, owner, slug: match[1], rest: match[2] ?? "" });
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;

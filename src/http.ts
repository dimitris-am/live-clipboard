import type { Fail } from "./results";

export const SESSION_COOKIE = "clip_session";

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

export function errorResponse(failure: Fail): Response {
  if (failure.retryAfter === undefined) return json({ error: failure.error }, failure.status);
  return json({ error: failure.error, retryAfter: failure.retryAfter }, failure.status, {
    "Retry-After": String(failure.retryAfter),
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** GET and HEAD pass; every other method and every WebSocket upgrade must come from this origin. */
export function isSameOrigin(request: Request): boolean {
  const upgrade = request.headers.get("Upgrade") === "websocket";
  if (!upgrade && (request.method === "GET" || request.method === "HEAD")) return true;
  return request.headers.get("Origin") === new URL(request.url).origin;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(slug: string, sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/r/${slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(slug: string): string {
  return `${SESSION_COOKIE}=; Path=/r/${slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function contentSecurityPolicy(url: URL): string {
  const wsOrigin = url.origin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src 'self' ${wsOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export type Page = "home.html" | "board.html" | "admin.html";

export async function servePage(request: Request, assets: Fetcher, page: Page): Promise<Response> {
  const url = new URL(request.url);
  const asset = await assets.fetch(new URL(`/${page}`, url));
  if (!asset.ok) return notFound();
  return new Response(asset.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": contentSecurityPolicy(url),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-cache",
    },
  });
}

/** Serves /assets/<name>.js and /assets/<name>.css only; HTML files are never served directly. */
export async function serveAsset(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  if (!/^\/assets\/[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return notFound();
  const asset = await assets.fetch(new URL(url.pathname, url));
  if (!asset.ok) return notFound();
  const headers = new Headers(asset.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-cache");
  return new Response(asset.body, { status: 200, headers });
}

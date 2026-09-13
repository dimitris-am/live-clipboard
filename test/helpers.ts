import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";

export const PUBLIC = "http://localhost:8787";
export const ADMIN = "http://127.0.0.1:8787";
/** Matches OWNERS in wrangler.jsonc and DEV_OWNER_EMAIL in vitest.config.ts. */
export const OWNER = { email: "mitsosmitsis@gmail.com", name: "Dimitris" } as const;

export type Msg = { type: string; [key: string]: unknown };

export interface TestSocket {
  ws: WebSocket;
  /** Resolves with the next unread JSON message (queued, so nothing is lost). */
  next(timeoutMs?: number): Promise<Msg>;
  /** Skips messages until one of the given type arrives. */
  nextOfType(type: string, timeoutMs?: number): Promise<Msg>;
  /** Resolves when the socket's close event fires. */
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms),
    ),
  ]);
}

/**
 * Wraps the client end of a 101 response. Listeners are attached BEFORE accept(),
 * so a snapshot the server sent before the upgrade completed is captured.
 */
export function acceptSocket(res: Response): TestSocket {
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected webSocket on response, got status ${res.status}`);

  const queue: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  let resolveClosed!: (v: { code: number; reason: string }) => void;
  const closedPromise = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));

  ws.addEventListener("message", (event) => {
    // The runtime's WebSocket auto-response answers "ping" with a raw "pong" frame, not JSON.
    const msg: Msg = event.data === "pong" ? { type: "pong" } : (JSON.parse(event.data as string) as Msg);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  ws.addEventListener("close", (event) => {
    resolveClosed({ code: event.code, reason: event.reason });
  });
  ws.accept();

  const socket: TestSocket = {
    ws,
    next(timeoutMs = 2000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return withTimeout(new Promise<Msg>((r) => waiters.push(r)), timeoutMs, "ws message");
    },
    async nextOfType(type, timeoutMs = 2000) {
      for (;;) {
        const msg = await socket.next(timeoutMs);
        if (msg.type === type) return msg;
      }
    },
    closed(timeoutMs = 2000) {
      return withTimeout(closedPromise, timeoutMs, "ws close");
    },
  };
  return socket;
}

function withOrigin(origin: string, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", origin);
  return { ...init, headers };
}

/** Request to the participants' door, with a same-origin Origin header unless one is given. */
export function publicFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${PUBLIC}${path}`, withOrigin(PUBLIC, init));
}

/** Request to the owners' door; tests act as OWNER through the development identity. */
export function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ADMIN}${path}`, withOrigin(ADMIN, init));
}

export async function makeRoom(slug: string, pin = "482913"): Promise<void> {
  const created = await env.ROOMS.getByName(slug).init({ slug, title: "API room", pin });
  if (!created.ok) throw new Error(created.error);
}

/** Joins through the public door and returns the "clip_session=<id>" cookie pair. */
export async function joinRoom(slug: string, name = "Kristi", ip = "198.51.100.30", pin = "482913"): Promise<string> {
  const res = await publicFetch(`/r/${slug}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ pin, name }),
  });
  if (res.status !== 200) throw new Error(`join failed with ${res.status}: ${await res.text()}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const ADMIN = "http://127.0.0.1:8787";

/**
 * Every integration test in this suite runs through `vitest.config.ts`'s
 * `ENVIRONMENT: "development"` binding, which lets admin-door requests in as
 * the DEV_OWNER_EMAIL identity without an Access token. That never exercises
 * the real 401 path (spec §11). Build an env without it and call the
 * Worker's own fetch() directly, bypassing SELF (which always uses the
 * suite's bindings).
 */
function noDevIdentityEnv(): typeof env {
  const spread = { ...env, ENVIRONMENT: undefined };
  if (spread.ENVIRONMENT !== undefined) {
    // A plain spread didn't carry through; fall back to Object.assign.
    return Object.assign({}, env, { ENVIRONMENT: undefined });
  }
  return spread;
}

async function fetchAsNobody(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  return worker.fetch(request, noDevIdentityEnv(), ctx);
}

describe("admin door without the dev identity", () => {
  it("requires Owner sign-in for the admin home page", async () => {
    const res = await fetchAsNobody(new Request(`${ADMIN}/`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Owner sign-in required" });
  });

  it("requires Owner sign-in for the rooms API", async () => {
    const res = await fetchAsNobody(new Request(`${ADMIN}/api/rooms`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Owner sign-in required" });
  });

  it("requires Owner sign-in for a live WebSocket upgrade", async () => {
    const res = await fetchAsNobody(
      new Request(`${ADMIN}/r/any-room/api/live`, {
        headers: { Upgrade: "websocket", Origin: ADMIN },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Owner sign-in required" });
  });

  it("rejects a forged Access assertion for the admin home page", async () => {
    const res = await fetchAsNobody(
      new Request(`${ADMIN}/`, { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Owner sign-in required" });
  });

  it("rejects a forged Access assertion for the rooms API", async () => {
    const res = await fetchAsNobody(
      new Request(`${ADMIN}/api/rooms`, { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Owner sign-in required" });
  });

  it("rejects a forged Access assertion for a live WebSocket upgrade", async () => {
    const res = await fetchAsNobody(
      new Request(`${ADMIN}/r/any-room/api/live`, {
        headers: { Upgrade: "websocket", Origin: ADMIN, "Cf-Access-Jwt-Assertion": "a.b.c" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Owner sign-in required" });
  });
});

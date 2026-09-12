import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PUBLIC } from "./helpers";

describe("harness", () => {
  it("uses the local doors and the test-only owner identity", () => {
    expect(env.PUBLIC_HOST).toBe("localhost:8787");
    expect(env.ADMIN_HOST).toBe("127.0.0.1:8787");
    const testOnly = env as unknown as { ENVIRONMENT?: string; DEV_OWNER_EMAIL?: string };
    expect(testOnly.ENVIRONMENT).toBe("development");
    expect(testOnly.DEV_OWNER_EMAIL).toBe("mitsosmitsis@gmail.com");
  });

  it("applies the D1 migration", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'",
    ).all();
    expect(tables.results).toHaveLength(1);
  });

  it("serves assets through the ASSETS binding with html_handling none", async () => {
    const res = await env.ASSETS.fetch(new URL("/board.html", PUBLIC));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="board"');
  });

  it("reaches the Worker", async () => {
    const res = await SELF.fetch(`${PUBLIC}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="home"');
  });
});

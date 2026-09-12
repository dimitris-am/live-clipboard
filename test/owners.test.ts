import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticateOwner, parseOwners, type OwnerEnv } from "../src/owners";

type CryptoKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const env: OwnerEnv = {
  ADMIN_HOST: "clip-admin.example.com",
  OWNERS: JSON.stringify({ "dimitris@example.com": "Dimitris" }),
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ACCESS_AUD: "aud-123",
};

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] });
});

async function token(opts: { email?: string; aud?: string; iss?: string; exp?: number; key?: CryptoKey } = {}) {
  return new SignJWT({ email: opts.email ?? "dimitris@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(opts.aud ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(opts.key ?? privateKey);
}

function request(host: string, jwt?: string): Request {
  return new Request(`https://${host}/`, {
    headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
}

describe("parseOwners", () => {
  it("lowercases emails", () => {
    expect(parseOwners('{"Dimitris@Example.com":"Dimitris"}').get("dimitris@example.com")).toBe("Dimitris");
  });
  it("returns an empty map for invalid input", () => {
    expect(parseOwners("not json").size).toBe(0);
    expect(parseOwners('["a"]').size).toBe(0);
    expect(parseOwners('{"a@b.c": 5}').size).toBe(0);
  });
});

describe("authenticateOwner with Access tokens", () => {
  it("accepts a valid token for a listed owner", async () => {
    const owner = await authenticateOwner(request(env.ADMIN_HOST, await token()), env, keys);
    expect(owner).toEqual({ email: "dimitris@example.com", name: "Dimitris" });
  });

  it("matches the email case-insensitively", async () => {
    const jwt = await token({ email: "Dimitris@Example.COM" });
    expect(await authenticateOwner(request(env.ADMIN_HOST, jwt), env, keys)).toEqual({
      email: "dimitris@example.com",
      name: "Dimitris",
    });
  });

  it.each([
    ["wrong audience", { aud: "other-aud" }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["email not in OWNERS", { email: "stranger@example.com" }],
  ])("rejects a token with %s", async (_label, opts) => {
    const jwt = await token(opts);
    expect(await authenticateOwner(request(env.ADMIN_HOST, jwt), env, keys)).toBeNull();
  });

  it("rejects a token signed by another key", async () => {
    const jwt = await token({ key: otherKey });
    expect(await authenticateOwner(request(env.ADMIN_HOST, jwt), env, keys)).toBeNull();
  });

  it("rejects a missing token and garbage", async () => {
    expect(await authenticateOwner(request(env.ADMIN_HOST), env, keys)).toBeNull();
    expect(await authenticateOwner(request(env.ADMIN_HOST, "a.b.c"), env, keys)).toBeNull();
  });

  it("rejects valid tokens on any other host", async () => {
    expect(await authenticateOwner(request("clip.example.com", await token()), env, keys)).toBeNull();
  });
});

describe("authenticateOwner development identity", () => {
  const dev: OwnerEnv = {
    ...env,
    ADMIN_HOST: "127.0.0.1:8787",
    ENVIRONMENT: "development",
    DEV_OWNER_EMAIL: "dimitris@example.com",
  };

  it("uses DEV_OWNER_EMAIL only on 127.0.0.1:8787 in development", async () => {
    expect(await authenticateOwner(request("127.0.0.1:8787"), dev, keys)).toEqual({
      email: "dimitris@example.com",
      name: "Dimitris",
    });
  });

  it("ignores DEV_OWNER_EMAIL when ENVIRONMENT is not development", async () => {
    const prod = { ...dev, ENVIRONMENT: "production" };
    expect(await authenticateOwner(request("127.0.0.1:8787"), prod, keys)).toBeNull();
  });

  it("ignores DEV_OWNER_EMAIL on a production admin host", async () => {
    const devOnProdHost = { ...dev, ADMIN_HOST: "clip-admin.example.com" };
    expect(await authenticateOwner(request("clip-admin.example.com"), devOnProdHost, keys)).toBeNull();
  });

  it("still requires DEV_OWNER_EMAIL to be listed in OWNERS", async () => {
    const unlisted = { ...dev, DEV_OWNER_EMAIL: "stranger@example.com" };
    expect(await authenticateOwner(request("127.0.0.1:8787"), unlisted, keys)).toBeNull();
  });
});

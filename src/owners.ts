import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type Owner = { email: string; name: string };

export type OwnerEnv = {
  ADMIN_HOST: string;
  OWNERS: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ENVIRONMENT?: string;
  DEV_OWNER_EMAIL?: string;
};

const DEV_ADMIN_HOST = "127.0.0.1:8787";

export function parseOwners(raw: string): Map<string, string> {
  const owners = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return owners;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return owners;
  for (const [email, name] of Object.entries(parsed)) {
    if (typeof name !== "string") return new Map();
    owners.set(email.toLowerCase(), name);
  }
  return owners;
}

// One remote key set per team domain, reused across requests in the same isolate.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
}

/**
 * Returns the owner for an admin-host request, or null.
 * Verifies the Access token itself even though Access sits in front of the host.
 */
export async function authenticateOwner(
  request: Request,
  env: OwnerEnv,
  keys?: JWTVerifyGetKey,
): Promise<Owner | null> {
  const host = new URL(request.url).host;
  if (host !== env.ADMIN_HOST) return null;
  const owners = parseOwners(env.OWNERS);

  const devIdentity =
    env.ENVIRONMENT === "development" && env.DEV_OWNER_EMAIL && host === DEV_ADMIN_HOST;
  if (devIdentity) {
    const email = env.DEV_OWNER_EMAIL!.toLowerCase();
    const name = owners.get(email);
    return name ? { email, name } : null;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys ?? remoteKeys(env.ACCESS_TEAM_DOMAIN), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    if (typeof payload.email !== "string") return null;
    const email = payload.email.toLowerCase();
    const name = owners.get(email);
    return name ? { email, name } : null;
  } catch {
    return null;
  }
}

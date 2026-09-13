const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** Expands "::" and validates group syntax; returns 8 lowercase groups, or null if unparseable. */
function expandIPv6Groups(ip: string): string[] | null {
  const doubleColons = ip.match(/::/g) ?? [];
  if (doubleColons.length > 1) return null;

  let head: string[];
  let tail: string[];
  if (ip.includes("::")) {
    const [headPart, tailPart] = ip.split("::") as [string, string];
    head = headPart ? headPart.split(":") : [];
    tail = tailPart ? tailPart.split(":") : [];
  } else {
    head = ip.split(":");
    tail = [];
    if (head.length !== 8) return null;
  }

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (!ip.includes("::") && missing !== 0) return null;

  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  if (!groups.every((g) => HEX_GROUP.test(g))) return null;
  return groups.map((g) => g.toLowerCase());
}

/**
 * Buckets a client address for rate limiting. IPv4 addresses (including
 * IPv4-mapped IPv6) key by the exact address; other IPv6 addresses key by
 * their /64, since a client can rotate the rest of the address at will.
 */
export function rateLimitAddress(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;

  const mapped = IPV4_MAPPED.exec(ip);
  if (mapped) return mapped[1]!;

  const groups = expandIPv6Groups(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

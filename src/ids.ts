function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 10 base-36 time characters + 16 hex random characters; sorts by creation time. */
export function newPostId(now: number = Date.now()): string {
  return now.toString(36).padStart(10, "0") + randomHex(8);
}

/** 128-bit random session ID, hex-encoded. */
export function newSessionId(): string {
  return randomHex(16);
}

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/** Compares without returning early on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

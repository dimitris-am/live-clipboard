// Plain objects so they cross Durable Object RPC unchanged.
export type Fail = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  error: string;
  retryAfter?: number;
};
export type Ok<T> = { ok: true; value: T };
export type Result<T> = Ok<T> | Fail;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export function fail(status: Fail["status"], error: string, retryAfter?: number): Fail {
  return retryAfter === undefined ? { ok: false, status, error } : { ok: false, status, error, retryAfter };
}

import { MAX_TEXT_CHARS } from "./limits";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PIN_RE = /^[A-Za-z0-9]{6,12}$/;
const CONTROL_RE = /\p{Cc}/u;

export function isSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}

export function parseTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const title = v.trim();
  return title.length >= 1 && title.length <= 80 && !CONTROL_RE.test(title) ? title : null;
}

export function parsePin(v: unknown): string | null {
  return typeof v === "string" && PIN_RE.test(v) ? v : null;
}

export function parseName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  return name.length >= 1 && name.length <= 40 && !CONTROL_RE.test(name) ? name : null;
}

export function parsePostText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length < 1 || v.length > MAX_TEXT_CHARS) return null;
  return v.trim().length === 0 ? null : v;
}

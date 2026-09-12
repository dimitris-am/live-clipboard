import { MAX_FILE_NAME_CHARS } from "./limits";

export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(/\p{Cc}/gu, "")
    .replace(/[/\\]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const capped = Array.from(cleaned).slice(0, MAX_FILE_NAME_CHARS).join("");
  return capped.length > 0 ? capped : "file";
}

export function normalizeContentType(raw: string | null): string {
  const type = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) && type.length <= 100
    ? type
    : "application/octet-stream";
}

export function isInlineImage(type: string): boolean {
  return INLINE_IMAGE_TYPES.has(type);
}

function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function downloadHeaders(type: string, name: string): Headers {
  const inline = isInlineImage(type);
  return new Headers({
    "Content-Type": inline ? type : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeRfc5987(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
  });
}

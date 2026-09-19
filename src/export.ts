/** Renders a room as one Markdown document. Pure: everything it needs is passed in. */

import type { ExportData, WirePost } from "./room/types";

const ZONE_RE = /^[A-Za-z0-9_+/-]{1,64}$/;

/** The reader's IANA timezone, or UTC when the client sent nothing usable. */
export function resolveTimeZone(raw: string | null): string {
  if (!raw || !ZONE_RE.test(raw)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

type Parts = { year: string; month: string; day: string; hour: string; minute: string };

function parts(at: number, timeZone: string): Parts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const pick = (type: string) => formatted.find((part) => part.type === type)?.value ?? "";
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    // Intl renders midnight as "24" with hour12 off; normalize it to "00".
    hour: pick("hour") === "24" ? "00" : pick("hour"),
    minute: pick("minute"),
  };
}

function isoDate(at: number, timeZone: string): string {
  const { year, month, day } = parts(at, timeZone);
  return `${year}-${month}-${day}`;
}

function stamp(at: number, timeZone: string): string {
  const { hour, minute } = parts(at, timeZone);
  return `${isoDate(at, timeZone)} ${hour}:${minute}`;
}

export function exportFilename(slug: string, at: number, timeZone: string): string {
  return `${slug}-${isoDate(at, timeZone)}.md`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Keeps a file name from breaking the link it labels. */
function escapeLinkText(name: string): string {
  return name.replace(/[[\]\\]/g, (char) => `\\${char}`);
}

export type RenderOptions = { at: number; timeZone: string; origin: string };

function renderPost(post: WirePost, opts: RenderOptions): string {
  const who = post.authorRole === "owner" ? `${post.authorName} (owner)` : post.authorName;
  const when = stamp(post.createdAt, opts.timeZone);
  if (post.kind === "file" && post.file) {
    const { name, size, type, url } = post.file;
    return `### ${who} · ${when} · file\n\n[${escapeLinkText(name)}](${opts.origin}${url}) · ${formatBytes(size)} · ${type}`;
  }
  // Post text goes in as written, so snippets and links paste straight back out.
  const text = (post.text ?? "").replace(/\r\n?/g, "\n").trim();
  return `### ${who} · ${when}\n\n${text}`;
}

export function renderMarkdown(data: ExportData, opts: RenderOptions): string {
  const { posts } = data;
  const roomUrl = `${opts.origin}/${data.room.slug}`;
  const count = `${posts.length} ${posts.length === 1 ? "post" : "posts"}`;
  const lines = [
    `# ${data.room.title}`,
    "",
    `Exported ${stamp(opts.at, opts.timeZone)} ${opts.timeZone} · ${count} · [${roomUrl.replace(/^https?:\/\//, "")}](${roomUrl})`,
  ];
  if (posts.some((post) => post.kind === "file")) {
    lines.push("", "_File links open only while you are still joined to this room._");
  }
  if (posts.length === 0) {
    lines.push("", "_No posts yet._", "");
    return lines.join("\n");
  }

  const section = (chosen: WirePost[]) => chosen.map((post) => renderPost(post, opts)).join("\n\n---\n\n");
  const pinned = posts.filter((post) => post.pinned);
  if (pinned.length > 0) lines.push("", "## Pinned", "", section(pinned));
  lines.push("", "## Feed", "", section(posts), "");
  return lines.join("\n");
}

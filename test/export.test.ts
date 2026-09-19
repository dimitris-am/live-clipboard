import { describe, expect, it } from "vitest";
import { exportFilename, renderMarkdown, resolveTimeZone } from "../src/export";
import type { ExportData, WirePost } from "../src/room/types";

/** 2026-09-19 14:40 UTC, which is 17:40 in Athens (EEST, UTC+3). */
const AT = Date.UTC(2026, 8, 19, 14, 40);
const OPTS = { at: AT, timeZone: "Europe/Athens", origin: "https://clip.example.com" };

function post(over: Partial<WirePost> = {}): WirePost {
  return {
    id: "01jx00000000000000000000a1",
    kind: "text",
    text: "hello",
    authorName: "Kristi",
    authorRole: "participant",
    createdAt: Date.UTC(2026, 8, 17, 6, 12),
    pinned: false,
    pinnedAt: null,
    mine: false,
    ...over,
  };
}

function room(posts: WirePost[]): ExportData {
  return { room: { slug: "agna-sep26", title: "Claude Code at AGNA" }, posts };
}

describe("resolveTimeZone", () => {
  it("accepts an IANA zone name", () => {
    expect(resolveTimeZone("Europe/Athens")).toBe("Europe/Athens");
  });

  it("falls back to UTC for a missing, malformed, or unknown zone", () => {
    expect(resolveTimeZone(null)).toBe("UTC");
    expect(resolveTimeZone("")).toBe("UTC");
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(resolveTimeZone("Europe/Athens'; DROP")).toBe("UTC");
    expect(resolveTimeZone("A".repeat(200))).toBe("UTC");
  });
});

describe("exportFilename", () => {
  it("names the file after the room and the export date", () => {
    expect(exportFilename("agna-sep26", AT, "UTC")).toBe("agna-sep26-2026-09-19.md");
  });

  it("dates the file in the reader's own timezone", () => {
    // 22:30 UTC is already the next calendar day in Athens.
    const lateEvening = Date.UTC(2026, 8, 19, 22, 30);
    expect(exportFilename("agna-sep26", lateEvening, "Europe/Athens")).toBe("agna-sep26-2026-09-20.md");
  });
});

describe("renderMarkdown", () => {
  it("writes the whole document: title, export line, feed heading, and the post", () => {
    expect(renderMarkdown(room([post()]), OPTS)).toBe(
      [
        "# Claude Code at AGNA",
        "",
        "Exported 2026-09-19 17:40 Europe/Athens · 1 post · [clip.example.com/agna-sep26](https://clip.example.com/agna-sep26)",
        "",
        "## Feed",
        "",
        "### Kristi · 2026-09-17 09:12",
        "",
        "hello",
        "",
      ].join("\n"),
    );
  });

  it("stamps times in the reader's timezone and counts posts in plural", () => {
    const md = renderMarkdown(room([post(), post({ id: "b", text: "second" })]), {
      ...OPTS,
      timeZone: "UTC",
    });
    expect(md).toContain("Exported 2026-09-19 14:40 UTC · 2 posts ·");
    expect(md).toContain("### Kristi · 2026-09-17 06:12");
  });

  it("separates consecutive posts with a rule on its own line", () => {
    const md = renderMarkdown(room([post({ text: "first" }), post({ id: "b", text: "second" })]), OPTS);
    expect(md).toContain("first\n\n---\n\n### Kristi");
    expect(md.endsWith("second\n")).toBe(true);
  });

  it("marks owner posts and leaves participant posts plain", () => {
    const md = renderMarkdown(
      room([post({ authorName: "Dimitris", authorRole: "owner" }), post({ id: "b" })]),
      OPTS,
    );
    expect(md).toContain("### Dimitris (owner) · ");
    expect(md).toContain("### Kristi · ");
  });

  it("lists pinned posts in their own section and keeps them in the feed", () => {
    const md = renderMarkdown(
      room([post({ text: "ordinary" }), post({ id: "b", text: "important", pinned: true })]),
      OPTS,
    );
    expect(md.indexOf("## Pinned")).toBeLessThan(md.indexOf("## Feed"));
    expect(md.split("important").length - 1).toBe(2);
    expect(md.split("ordinary").length - 1).toBe(1);
  });

  it("renders a file post as a link with its size and type, and warns that links need a session", () => {
    const md = renderMarkdown(
      room([
        post({
          kind: "file",
          text: undefined,
          authorName: "Kostas",
          file: {
            name: "shelf.jpg",
            size: 2_516_582,
            type: "image/jpeg",
            url: "/agna-sep26/files/01jx00000000000000000000a1",
          },
        }),
      ]),
      OPTS,
    );
    expect(md).toContain("### Kostas · 2026-09-17 09:12 · file");
    expect(md).toContain(
      "[shelf.jpg](https://clip.example.com/agna-sep26/files/01jx00000000000000000000a1) · 2.4 MB · image/jpeg",
    );
    expect(md).toContain("_File links open only while you are still joined to this room._");
  });

  it("leaves out the file note when the room holds no files", () => {
    expect(renderMarkdown(room([post()]), OPTS)).not.toContain("File links open only");
  });

  it("escapes square brackets in file names so the link survives", () => {
    const md = renderMarkdown(
      room([
        post({
          kind: "file",
          text: undefined,
          file: { name: "report [final].pdf", size: 512, type: "application/pdf", url: "/agna-sep26/files/x" },
        }),
      ]),
      OPTS,
    );
    expect(md).toContain("[report \\[final\\].pdf](https://clip.example.com/agna-sep26/files/x) · 512 B · application/pdf");
  });

  it("normalizes Windows line endings and trims the post text", () => {
    const md = renderMarkdown(room([post({ text: "  one\r\ntwo\n\n" })]), OPTS);
    expect(md).toContain("\n\none\ntwo\n");
    expect(md).not.toContain("\r");
  });

  it("says so when the room is empty, with no Pinned or Feed headings", () => {
    const md = renderMarkdown(room([]), OPTS);
    expect(md).toContain("· 0 posts ·");
    expect(md).toContain("_No posts yet._");
    expect(md).not.toContain("## Feed");
    expect(md).not.toContain("## Pinned");
  });
});

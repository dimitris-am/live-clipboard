import { describe, expect, it } from "vitest";
import { formatBytes, relativeTime, splitLinks } from "../public/assets/common.js";

describe("splitLinks", () => {
  it("finds http and https links and leaves trailing punctuation outside", () => {
    expect(splitLinks("see https://github.com/dimitris-am/agna-starter.")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://github.com/dimitris-am/agna-starter" },
      { type: "text", value: "." },
    ]);
    expect(splitLinks("(http://a.b/c)")).toEqual([
      { type: "text", value: "(" },
      { type: "link", value: "http://a.b/c" },
      { type: "text", value: ")" },
    ]);
  });

  it("finds several links", () => {
    expect(splitLinks("https://a.io and https://b.io")).toEqual([
      { type: "link", value: "https://a.io" },
      { type: "text", value: " and " },
      { type: "link", value: "https://b.io" },
    ]);
  });

  it("never links other schemes or bare prefixes", () => {
    expect(splitLinks("javascript:alert(1) ftp://x.y http://")).toEqual([
      { type: "text", value: "javascript:alert(1) ftp://x.y http://" },
    ]);
    expect(splitLinks("")).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  it("describes recent times", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
  it("falls back to a date after a day", () => {
    expect(relativeTime(Date.UTC(2026, 8, 12, 12, 0, 0), now)).toBe("Sep 12");
  });
});

describe("formatBytes", () => {
  it("uses B, KB, MB and GB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(240 * 1024)).toBe("240 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

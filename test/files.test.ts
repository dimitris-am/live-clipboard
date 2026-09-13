import { describe, expect, it } from "vitest";
import { downloadHeaders, isInlineImage, normalizeContentType, sanitizeFileName } from "../src/files";

describe("sanitizeFileName", () => {
  it("keeps ordinary names", () => {
    expect(sanitizeFileName("error screenshot.png")).toBe("error screenshot.png");
    expect(sanitizeFileName("τιμές.csv")).toBe("τιμές.csv");
  });
  it("strips path separators, control characters and leading dots", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFileName("a\\b/c.txt")).toBe("abc.txt");
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("bad" + String.fromCharCode(0, 31, 127) + "name.txt")).toBe("badname.txt");
  });
  it("strips invisible formatting characters, such as a direction override spoofing an extension", () => {
    expect(sanitizeFileName("photo" + String.fromCharCode(0x202e) + "gnp.exe")).toBe("photognp.exe");
  });
  it("caps at 120 characters and falls back to 'file'", () => {
    expect(Array.from(sanitizeFileName("é".repeat(200)))).toHaveLength(120);
    expect(sanitizeFileName("../")).toBe("file");
    expect(sanitizeFileName("   ")).toBe("file");
  });
});

describe("normalizeContentType", () => {
  it("lowercases and drops parameters", () => {
    expect(normalizeContentType("Image/PNG; charset=binary")).toBe("image/png");
  });
  it("falls back to application/octet-stream", () => {
    expect(normalizeContentType(null)).toBe("application/octet-stream");
    expect(normalizeContentType("")).toBe("application/octet-stream");
    expect(normalizeContentType("not a type")).toBe("application/octet-stream");
  });
});

describe("downloadHeaders", () => {
  it("serves the four image types inline with their own type", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isInlineImage(type)).toBe(true);
      const h = downloadHeaders(type, "shot.png");
      expect(h.get("Content-Type")).toBe(type);
      expect(h.get("Content-Disposition")).toBe("inline; filename*=UTF-8''shot.png");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
  it("forces SVG, HTML and everything else to download as octet-stream", () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf"]) {
      expect(isInlineImage(type)).toBe(false);
      const h = downloadHeaders(type, "page (1).html");
      expect(h.get("Content-Type")).toBe("application/octet-stream");
      expect(h.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''page%20%281%29.html");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
});

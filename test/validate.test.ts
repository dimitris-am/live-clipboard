import { describe, expect, it } from "vitest";
import { constantTimeEqual, isSessionId, newPostId, newSessionId } from "../src/ids";
import { isSlug, parseName, parsePin, parsePostText, parseTitle } from "../src/validate";

describe("isSlug", () => {
  it.each(["agna-2026", "a", "a1", "x".repeat(40)])("accepts %s", (slug) => {
    expect(isSlug(slug)).toBe(true);
  });
  it.each(["", "-a", "a-", "A", "a_b", "x".repeat(41), "a/b", 12])("rejects %s", (slug) => {
    expect(isSlug(slug)).toBe(false);
  });
});

describe("parseTitle", () => {
  it("trims and accepts 1–80 characters", () => {
    expect(parseTitle("  Claude Code at AGNA ")).toBe("Claude Code at AGNA");
    expect(parseTitle("x".repeat(80))).toBe("x".repeat(80));
  });
  it("rejects empty, too long and non-strings", () => {
    expect(parseTitle("   ")).toBeNull();
    expect(parseTitle("x".repeat(81))).toBeNull();
    expect(parseTitle(5)).toBeNull();
  });
});

describe("parsePin", () => {
  it("accepts 6–12 letters or digits, unchanged", () => {
    expect(parsePin("482913")).toBe("482913");
    expect(parsePin("AgnaAgna2026")).toBe("AgnaAgna2026");
  });
  it("rejects short, long, symbols, spaces and non-strings", () => {
    for (const bad of ["12345", "1234567890123", "12345!", "123 456", 123456]) {
      expect(parsePin(bad)).toBeNull();
    }
  });
});

describe("parseName", () => {
  it("trims and accepts 1–40 characters", () => {
    expect(parseName("  Kristi ")).toBe("Kristi");
    expect(parseName("x".repeat(40))).toBe("x".repeat(40));
  });
  it("rejects empty, too long, control characters and non-strings", () => {
    expect(parseName("  ")).toBeNull();
    expect(parseName("x".repeat(41))).toBeNull();
    expect(parseName("Kri" + String.fromCharCode(0) + "sti")).toBeNull();
    expect(parseName(null)).toBeNull();
  });
  it("rejects invisible formatting characters, such as a direction override", () => {
    expect(parseName("Kri" + String.fromCharCode(0x202e) + "sti")).toBeNull();
  });
});

describe("parsePostText", () => {
  it("keeps text exactly, including surrounding whitespace", () => {
    expect(parsePostText("  claude --model sonnet\n")).toBe("  claude --model sonnet\n");
    expect(parsePostText("x".repeat(20_000))).toHaveLength(20_000);
  });
  it("rejects empty, whitespace-only, too long and non-strings", () => {
    expect(parsePostText("")).toBeNull();
    expect(parsePostText(" \n\t ")).toBeNull();
    expect(parsePostText("x".repeat(20_001))).toBeNull();
    expect(parsePostText({ text: "hi" })).toBeNull();
  });
});

describe("ids", () => {
  it("post IDs sort by creation time", () => {
    const earlier = newPostId(1_700_000_000_000);
    const later = newPostId(1_700_000_000_001);
    expect(earlier < later).toBe(true);
    expect(earlier).toMatch(/^[0-9a-z]{10}[0-9a-f]{16}$/);
  });
  it("session IDs are 32 hex characters and unique", () => {
    const a = newSessionId();
    expect(isSessionId(a)).toBe(true);
    expect(a).not.toBe(newSessionId());
    expect(isSessionId("not-a-session")).toBe(false);
  });
  it("constantTimeEqual compares exactly", () => {
    expect(constantTimeEqual("482913", "482913")).toBe(true);
    expect(constantTimeEqual("482913", "482914")).toBe(false);
    expect(constantTimeEqual("482913", "4829130")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

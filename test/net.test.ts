import { describe, expect, it } from "vitest";
import { rateLimitAddress } from "../src/net";

describe("rateLimitAddress", () => {
  it("treats null or empty as unknown", () => {
    expect(rateLimitAddress(null)).toBe("unknown");
    expect(rateLimitAddress("")).toBe("unknown");
  });

  it("returns IPv4 unchanged", () => {
    expect(rateLimitAddress("203.0.113.50")).toBe("203.0.113.50");
  });

  it("unwraps an IPv4-mapped IPv6 address in any case", () => {
    expect(rateLimitAddress("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitAddress("::FFFF:1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitAddress("::Ffff:198.51.100.9")).toBe("198.51.100.9");
  });

  it("keys any other IPv6 address by its /64, expanding :: and lowercasing", () => {
    expect(rateLimitAddress("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(rateLimitAddress("2001:DB8:ABCD:12::99")).toBe("2001:db8:abcd:12::/64");
  });

  it("expands a compressed address in the middle", () => {
    expect(rateLimitAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("expands a leading ::", () => {
    expect(rateLimitAddress("::1")).toBe("0:0:0:0::/64");
  });

  it("returns unparseable input unchanged", () => {
    expect(rateLimitAddress("not:a:valid:address:at:all:whatsoever:really")).toBe(
      "not:a:valid:address:at:all:whatsoever:really",
    );
    expect(rateLimitAddress("hello:world")).toBe("hello:world");
  });
});

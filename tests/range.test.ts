import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "../src/server/proxy/range";

describe("parseRangeHeader", () => {
  it("parses explicit byte ranges", () => {
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19, size: 10 });
  });

  it("parses open-ended byte ranges", () => {
    expect(parseRangeHeader("bytes=90-", 100)).toEqual({ start: 90, end: 99, size: 10 });
  });

  it("rejects invalid ranges", () => {
    expect(parseRangeHeader("bytes=150-160", 100)).toBeNull();
  });

  it("clamps satisfiable explicit ranges beyond the file size", () => {
    expect(parseRangeHeader("bytes=90-150", 100)).toEqual({ start: 90, end: 99, size: 10 });
  });

  it("rejects empty byte ranges", () => {
    expect(parseRangeHeader("bytes=-", 100)).toBeNull();
  });

  it("parses suffix byte ranges", () => {
    expect(parseRangeHeader("bytes=-5", 100)).toEqual({ start: 95, end: 99, size: 5 });
  });
});

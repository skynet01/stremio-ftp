import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("static SEO metadata", () => {
  it("exposes search and social metadata for the public landing page", () => {
    const html = readFileSync("index.html", "utf8");

    expect(html).toContain('<title>Stremio FTP Addon</title>');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="robots" content="index,follow"');
    expect(html).toContain('rel="canonical" href="https://ftpstrem.skynetsource.com/"');
    expect(html).toContain('property="og:title" content="Stremio FTP Addon"');
    expect(html).toContain('name="twitter:card" content="summary"');
  });
});

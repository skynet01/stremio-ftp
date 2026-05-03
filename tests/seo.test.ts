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
    expect(html).toContain('property="og:image" content="https://raw.githubusercontent.com/skynet01/stremio-ftp/7c391e985c34338b441c8f61ff2b252a75ae9b12/Screenshot.jpg"');
    expect(html).toContain('property="og:image:alt" content="Stremio FTP Addon configuration portal screenshot"');
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).toContain('name="twitter:image" content="https://raw.githubusercontent.com/skynet01/stremio-ftp/7c391e985c34338b441c8f61ff2b252a75ae9b12/Screenshot.jpg"');
    expect(html).toContain("<noscript>");
    expect(html).toContain("self-hosted Stremio source addon");
  });
});

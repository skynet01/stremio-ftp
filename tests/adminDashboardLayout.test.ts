import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin dashboard table layout", () => {
  it("keeps the profile table constrained to the panel width", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/\.admin-profile-table\s*{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/\.admin-profile-table th,\s*\.admin-profile-table td\s*{[^}]*padding:\s*10px\s+8px;/s);
    expect(css).toMatch(/\.admin-actions\s*{[^}]*gap:\s*4px;/s);
  });

  it("switches admin profile rows to labeled blocks on mobile", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-profile-table thead\s*{[^}]*position:\s*absolute;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-profile-table tr\s*{[^}]*display:\s*grid;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-profile-table td::before\s*{[^}]*content:\s*attr\(data-label\);/);
  });

  it("keeps admin status pills content-sized on mobile", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-profile-table \.badge\s*{[^}]*justify-self:\s*start;[^}]*width:\s*max-content;/);
  });
});

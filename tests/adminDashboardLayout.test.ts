import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin dashboard table layout", () => {
  it("keeps the profile table constrained to the panel width", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/\.admin-profile-table\s*{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/\.admin-profile-table th,\s*\.admin-profile-table td\s*{[^}]*padding:\s*10px\s+8px;/s);
    expect(css).toMatch(/\.admin-profile-table th:nth-child\(1\),\s*\.admin-profile-table td:nth-child\(1\)\s*{[^}]*width:\s*38px;/s);
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

  it("keeps shared index admin controls inside the panel on desktop and mobile", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toMatch(/\.admin-shared-grid\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s);
    expect(css).toMatch(/\.admin-shared-content-grid\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
    expect(css).toMatch(/\.admin-shared-detail\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\);/s);
    expect(css).toMatch(/\*\s*{[^}]*scrollbar-color:\s*rgba\(168,\s*224,\s*99,\s*0\.55\)\s+rgba\(255,\s*255,\s*255,\s*0\.045\);[^}]*scrollbar-width:\s*thin;/s);
    expect(css).toMatch(/\.admin-linked-servers-dialog\s*{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s);
    expect(css).toMatch(/\.admin-bulk-link-row\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(180px,\s*0\.65fr\);/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-bulk-link-row\s*{[^}]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*1160px\)\s*{[\s\S]*\.admin-shared-grid\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-shared-grid\s*{[^}]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*860px\)\s*{[\s\S]*\.admin-shared-card-header,\s*[\s\S]*\.admin-shared-stats\s*{[^}]*grid-template-columns:\s*1fr;/);
  });
});

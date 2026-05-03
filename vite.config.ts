import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as { version: string };
const changelog = latestCommits();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_CHANGELOG__: JSON.stringify(changelog),
  },
  server: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    globals: true,
  },
});

function latestCommits() {
  try {
    return execSync("git log --pretty=format:%h%x09%s -6", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, ...subjectParts] = line.split("\t");
        return { hash, subject: subjectParts.join("\t") };
      });
  } catch {
    return [];
  }
}

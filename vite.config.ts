import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
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

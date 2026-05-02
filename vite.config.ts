import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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

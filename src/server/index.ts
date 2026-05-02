import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`stremio-ftp listening on ${config.port}`);
});

server.on("error", (error) => {
  console.error("stremio-ftp failed to start", error);
  process.exit(1);
});

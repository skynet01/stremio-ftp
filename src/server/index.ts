import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

// Upper bound for logging out pooled FTP connections before the process exits anyway.
const SHUTDOWN_TIMEOUT_MS = 5_000;

const config = loadConfig();
const app = createApp(config, undefined, { refreshStoredCatalogAtStartup: true });

const server = app.listen(config.port, () => {
  console.log(`stremio-ftp listening on ${config.port}`);
});

server.on("error", (error) => {
  console.error("stremio-ftp failed to start", error);
  process.exit(1);
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`stremio-ftp received ${signal}, logging out of pooled FTP connections`);
  server.close();
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  void app.shutdown().finally(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

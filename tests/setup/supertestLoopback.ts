// Make supertest's throwaway servers listen on 127.0.0.1 instead of the wildcard.
//
// `request(app)` calls `app.listen(0)`, which binds the dual-stack wildcard `::`,
// and then sends the request to `http://127.0.0.1:<port>`. macOS will give that
// wildcard listener an ephemeral port that another process already holds on
// 127.0.0.1 (Plex, Node-RED, dev servers...). An IPv4 connection prefers the more
// specific 127.0.0.1 listener, so the request goes to the other process and the
// test sees a random 404/401. Other test runs on the machine use up ports faster,
// so this happens more often under load.
//
// A server bound to 127.0.0.1 itself can't share its port with another
// 127.0.0.1 listener, and it wins over any wildcard one.
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { Server as TlsServer } from "node:tls";

const LOOPBACK = "127.0.0.1";

type SupertestTest = {
  url: string;
  _server?: Server;
  _loopbackListening?: Promise<void>;
  _loopbackPath?: string;
  _loopbackProtocol?: string;
  serverAddress(app: Server, path: string): string;
  end(fn?: (error: unknown, res?: unknown) => void): SupertestTest;
};

const require = createRequire(import.meta.url);
const { Test } = require("supertest") as { Test: { prototype: SupertestTest } };
const originalEnd = Test.prototype.end;

Test.prototype.serverAddress = function (this: SupertestTest, app: Server, path: string) {
  const protocol = app instanceof TlsServer ? "https" : "http";
  const address = app.address() as AddressInfo | null;
  if (address) return `${protocol}://${LOOPBACK}:${address.port}${path}`;

  // Listening on a specific host resolves it asynchronously, so the real URL is
  // filled in by end() once the server is up.
  const server = app.listen(0, LOOPBACK);
  this._server = server;
  this._loopbackPath = path;
  this._loopbackProtocol = protocol;
  this._loopbackListening = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return `${protocol}://${LOOPBACK}${path}`;
};

Test.prototype.end = function (this: SupertestTest, fn) {
  const listening = this._loopbackListening;
  if (!listening) return originalEnd.call(this, fn);
  this._loopbackListening = undefined;
  listening.then(
    () => {
      const { port } = this._server!.address() as AddressInfo;
      this.url = `${this._loopbackProtocol}://${LOOPBACK}:${port}${this._loopbackPath}`;
      originalEnd.call(this, fn);
    },
    (error: unknown) => fn?.(error),
  );
  return this;
};

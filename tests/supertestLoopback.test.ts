import type { IncomingMessage, ServerResponse } from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("supertest loopback setup", () => {
  it("serves requests from a server bound to 127.0.0.1, not the dual-stack wildcard", async () => {
    // A `::` listener sees IPv4 clients as ::ffff:127.0.0.1.
    const app = (req: IncomingMessage, res: ServerResponse) => res.end(req.socket.localAddress);

    const response = await request(app).get("/").query({ probe: "1" }).expect(200);

    expect(response.text).toBe("127.0.0.1");
  });
});

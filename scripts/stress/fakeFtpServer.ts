import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { patternBytes } from "./pattern";

// A small in-process FTP server over plain TCP (no TLS) that is good enough for basic-ftp downloads:
// USER/PASS, FEAT, TYPE, EPSV, REST, RETR, QUIT. File bodies are generated on the fly from a seed,
// so large files cost no memory. It can enforce a per-user session cap and inject faults.

export type FakeFile = { size: number; seed: number };

export type FtpFaults = {
  // 530 on PASS regardless of the session cap.
  loginRejectRate: number;
  // Chance that a reply is held back by up to replyDelayMaxMs.
  replyDelayRate: number;
  replyDelayMaxMs: number;
  // Chance that a RETR is cut off after a random number of bytes (data socket closed or reset, then 426).
  dataDropRate: number;
  // Chance per command that the control connection is dropped instead of answered.
  controlDropRate: number;
  // Chance per command that the session goes silent forever (the client has to time out).
  stallRate: number;
};

export const NO_FAULTS: FtpFaults = {
  loginRejectRate: 0,
  replyDelayRate: 0,
  replyDelayMaxMs: 0,
  dataDropRate: 0,
  controlDropRate: 0,
  stallRate: 0,
};

export type FakeFtpServerOptions = {
  files: Record<string, FakeFile>;
  // Maximum logged-in sessions per username; extra logins get "530 Login incorrect". 0 disables the cap.
  perUserMaxConnections?: number;
  // A closed session keeps counting against the user's cap for this long (server-side cleanup lag).
  releaseLagMs?: number;
  // Added to every control reply, like network latency.
  latencyMs?: number;
  random?: () => number;
};

export type FakeFtpStats = {
  controlConnections: number;
  loginsAccepted: number;
  loginsRejectedOverCap: number;
  loginsRejectedInjected: number;
  transfersStarted: number;
  transfersCompleted: number;
  transfersClosedByClient: number;
  dataDrops: number;
  controlDrops: number;
  stalls: number;
  delayedReplies: number;
  maxOpenControl: number;
  maxSessionsPerUser: number;
  bytesSent: number;
};

type Session = {
  control: Socket;
  user: string | null;
  loggedInAs: string | null;
  restOffset: number;
  passive: { server: Server; socket: Promise<Socket | null>; timer: NodeJS.Timeout } | null;
  dataSocket: Socket | null;
  replyChain: Promise<void>;
  stalled: boolean;
  closed: boolean;
};

const CHUNK_BYTES = 64 * 1024;

export class FakeFtpServer {
  port = 0;
  faults: FtpFaults = { ...NO_FAULTS };
  readonly stats: FakeFtpStats = {
    controlConnections: 0,
    loginsAccepted: 0,
    loginsRejectedOverCap: 0,
    loginsRejectedInjected: 0,
    transfersStarted: 0,
    transfersCompleted: 0,
    transfersClosedByClient: 0,
    dataDrops: 0,
    controlDrops: 0,
    stalls: 0,
    delayedReplies: 0,
    maxOpenControl: 0,
    maxSessionsPerUser: 0,
    bytesSent: 0,
  };

  private readonly server: Server;
  private readonly sessions = new Set<Session>();
  private readonly dataSockets = new Set<Socket>();
  private readonly passiveServers = new Set<Server>();
  private readonly userSessions = new Map<string, number>();
  private readonly lagTimers = new Set<NodeJS.Timeout>();
  private readonly random: () => number;

  constructor(private readonly options: FakeFtpServerOptions) {
    this.random = options.random ?? Math.random;
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  openControlCount() {
    return this.sessions.size;
  }

  openDataCount() {
    return this.dataSockets.size;
  }

  pendingPassiveCount() {
    return this.passiveServers.size;
  }

  // Sessions still counted against per-user caps (includes sessions inside the release lag).
  countedSessions() {
    let total = 0;
    for (const count of this.userSessions.values()) total += count;
    return total;
  }

  resetStats() {
    for (const key of Object.keys(this.stats) as Array<keyof FakeFtpStats>) this.stats[key] = 0;
  }

  async close() {
    for (const timer of this.lagTimers) clearTimeout(timer);
    for (const session of this.sessions) session.control.destroy();
    for (const socket of this.dataSockets) socket.destroy();
    for (const passive of this.passiveServers) passive.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(control: Socket) {
    this.stats.controlConnections += 1;
    const session: Session = {
      control,
      user: null,
      loggedInAs: null,
      restOffset: 0,
      passive: null,
      dataSocket: null,
      replyChain: Promise.resolve(),
      stalled: false,
      closed: false,
    };
    this.sessions.add(session);
    this.stats.maxOpenControl = Math.max(this.stats.maxOpenControl, this.sessions.size);
    control.on("error", () => undefined);
    control.once("close", () => this.endSession(session));
    control.setEncoding("utf8");

    let pending = "";
    control.on("data", (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf("\r\n");
      while (index >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        this.handle(session, line);
        index = pending.indexOf("\r\n");
      }
    });

    this.reply(session, "220 Fake FTP ready", false);
  }

  private endSession(session: Session) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session);
    session.dataSocket?.destroy();
    this.closePassive(session);
    const user = session.loggedInAs;
    if (!user) return;
    const release = () => {
      const count = (this.userSessions.get(user) ?? 1) - 1;
      if (count <= 0) this.userSessions.delete(user);
      else this.userSessions.set(user, count);
    };
    const lag = this.options.releaseLagMs ?? 0;
    if (lag <= 0) {
      release();
      return;
    }
    const timer = setTimeout(() => {
      this.lagTimers.delete(timer);
      release();
    }, lag);
    this.lagTimers.add(timer);
  }

  private closePassive(session: Session) {
    if (!session.passive) return;
    clearTimeout(session.passive.timer);
    session.passive.server.close();
    this.passiveServers.delete(session.passive.server);
    session.passive = null;
  }

  // Replies are chained so that latency and injected delays never reorder them.
  private reply(session: Session, line: string, allowFaultDelay = true) {
    let delay = this.options.latencyMs ?? 0;
    if (allowFaultDelay && this.faults.replyDelayRate > 0 && this.random() < this.faults.replyDelayRate) {
      delay += Math.floor(this.random() * this.faults.replyDelayMaxMs);
      this.stats.delayedReplies += 1;
    }
    session.replyChain = session.replyChain.then(async () => {
      if (delay > 0) await sleep(delay);
      if (!session.closed && !session.stalled && !session.control.destroyed) session.control.write(`${line}\r\n`);
    });
  }

  private handle(session: Session, line: string) {
    if (session.stalled || session.closed) return;
    const [rawCommand = "", ...rest] = line.split(" ");
    const command = rawCommand.toUpperCase();
    const arg = rest.join(" ");

    if (command !== "QUIT") {
      if (this.faults.stallRate > 0 && this.random() < this.faults.stallRate) {
        session.stalled = true;
        this.stats.stalls += 1;
        return;
      }
      if (this.faults.controlDropRate > 0 && this.random() < this.faults.controlDropRate) {
        this.stats.controlDrops += 1;
        session.control.destroy();
        return;
      }
    }

    switch (command) {
      case "USER":
        session.user = arg;
        this.reply(session, "331 Password required");
        return;
      case "PASS":
        this.login(session);
        return;
      case "FEAT":
        this.reply(session, "211 No features");
        return;
      case "TYPE":
        this.reply(session, "200 Type set");
        return;
      case "STRU":
        this.reply(session, "200 Structure set");
        return;
      case "OPTS":
        this.reply(session, "200 OK");
        return;
      case "EPSV":
        this.openPassive(session);
        return;
      case "REST":
        session.restOffset = Number(arg) || 0;
        this.reply(session, `350 Restarting at ${session.restOffset}`);
        return;
      case "RETR":
        this.retrieve(session, arg);
        return;
      case "QUIT":
        this.reply(session, "221 Bye", false);
        void session.replyChain.then(() => session.control.end());
        return;
      default:
        this.reply(session, "502 Command not implemented");
    }
  }

  private login(session: Session) {
    const user = session.user;
    if (!user) {
      this.reply(session, "503 Login with USER first");
      return;
    }
    const cap = this.options.perUserMaxConnections ?? 0;
    const current = this.userSessions.get(user) ?? 0;
    if (cap > 0 && current >= cap) {
      this.stats.loginsRejectedOverCap += 1;
      this.reply(session, "530 Login incorrect");
      return;
    }
    if (this.faults.loginRejectRate > 0 && this.random() < this.faults.loginRejectRate) {
      this.stats.loginsRejectedInjected += 1;
      this.reply(session, "530 Login incorrect");
      return;
    }
    session.loggedInAs = user;
    this.userSessions.set(user, current + 1);
    this.stats.maxSessionsPerUser = Math.max(this.stats.maxSessionsPerUser, current + 1);
    this.stats.loginsAccepted += 1;
    this.reply(session, "230 Logged in");
  }

  private openPassive(session: Session) {
    if (!session.loggedInAs) {
      this.reply(session, "530 Not logged in");
      return;
    }
    this.closePassive(session);
    const passive = createServer();
    this.passiveServers.add(passive);
    let settle: (socket: Socket | null) => void = () => undefined;
    const socket = new Promise<Socket | null>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      settle(null);
      if (session.passive?.server === passive) this.closePassive(session);
    }, 30_000);
    session.passive = { server: passive, socket, timer };
    passive.once("connection", (dataSocket) => {
      this.dataSockets.add(dataSocket);
      dataSocket.on("error", () => undefined);
      dataSocket.once("close", () => this.dataSockets.delete(dataSocket));
      if (session.closed) {
        dataSocket.destroy();
        settle(null);
        return;
      }
      clearTimeout(timer);
      passive.close();
      this.passiveServers.delete(passive);
      settle(dataSocket);
    });
    passive.on("close", () => settle(null));
    passive.listen(0, "127.0.0.1", () => {
      this.reply(session, `229 Entering Extended Passive Mode (|||${(passive.address() as AddressInfo).port}|)`);
    });
  }

  private retrieve(session: Session, path: string) {
    const file = this.options.files[path];
    const passive = session.passive;
    if (!file) {
      this.reply(session, "550 File not found");
      return;
    }
    if (!passive) {
      this.reply(session, "425 Use EPSV first");
      return;
    }
    session.passive = null;
    const start = Math.min(session.restOffset, file.size);
    session.restOffset = 0;
    this.reply(session, "150 Opening BINARY mode data connection");
    this.stats.transfersStarted += 1;

    void passive.socket.then((dataSocket) => {
      clearTimeout(passive.timer);
      if (!dataSocket) {
        this.reply(session, "425 Can't open data connection");
        return;
      }
      session.dataSocket = dataSocket;
      const drop = this.faults.dataDropRate > 0 && this.random() < this.faults.dataDropRate;
      const dropAfter = drop ? Math.floor(this.random() * 4 * 1024 * 1024) : Number.POSITIVE_INFINITY;
      const resetOnDrop = this.random() < 0.5;
      let position = start;
      let sent = 0;
      let finished = false;

      const body = new Readable({
        highWaterMark: CHUNK_BYTES,
        read: () => {
          if (position >= file.size) {
            body.push(null);
            return;
          }
          if (sent >= dropAfter) {
            finished = true;
            this.stats.dataDrops += 1;
            body.unpipe(dataSocket);
            body.destroy();
            if (resetOnDrop) dataSocket.resetAndDestroy();
            else dataSocket.destroy();
            this.reply(session, "426 Connection closed; transfer aborted");
            return;
          }
          const length = Math.min(CHUNK_BYTES, file.size - position, dropAfter - sent);
          const chunk = patternBytes(file.seed, position, length);
          position += length;
          sent += length;
          this.stats.bytesSent += length;
          body.push(chunk);
        },
      });

      dataSocket.once("close", () => {
        body.destroy();
        if (session.dataSocket === dataSocket) session.dataSocket = null;
        if (finished) return;
        finished = true;
        this.stats.transfersClosedByClient += 1;
        this.reply(session, "426 Connection closed; transfer aborted");
      });
      body.once("end", () => {
        dataSocket.end(() => {
          if (finished) return;
          finished = true;
          this.stats.transfersCompleted += 1;
          this.reply(session, "226 Transfer complete");
        });
      });
      body.pipe(dataSocket);
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Small deterministic PRNG (mulberry32) so runs can be replayed with --seed.
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

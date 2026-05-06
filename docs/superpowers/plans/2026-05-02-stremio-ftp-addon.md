# Stremio FTP Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dockerized Stremio source addon that lets users configure FTP credentials in a no-signup web portal and stream matched movies or series episodes through an HTTP range proxy.

**Architecture:** One TypeScript service serves Express API routes, Stremio manifest/stream endpoints, a background FTP indexer, and a React config UI. SQLite under `/config` stores encrypted profiles, install tokens, media index rows, crawl state, Cinemeta cache, and negative match cache. Streaming always returns HTTP proxy URLs so FTP credentials stay server-side.

**Tech Stack:** Node.js 22, TypeScript, Express, stremio-addon-sdk, better-sqlite3, basic-ftp, React, Vite, Vitest, Supertest, Docker.

---

## File Structure

- `package.json`: scripts and runtime/dev dependencies.
- `tsconfig.json`: TypeScript config for server and shared modules.
- `vite.config.ts`: React build and Vitest config.
- `Dockerfile`: multi-stage production image.
- `docker-compose.yml`: local self-hosting example with `/config` volume.
- `.dockerignore`: excludes source-control, dependencies, and build output.
- `.gitignore`: excludes dependencies, build output, local config, and coverage.
- `.env.example`: documents required and optional environment variables.
- `README.md`: setup, Docker, reverse proxy, and Stremio install instructions.
- `src/server/index.ts`: process entrypoint.
- `src/server/app.ts`: Express app composition.
- `src/server/config.ts`: environment parsing.
- `src/server/db/schema.ts`: SQLite schema and migration bootstrap.
- `src/server/db/database.ts`: database connection helper.
- `src/server/security/crypto.ts`: encryption, token hashing, passphrase verification.
- `src/server/profiles/profileService.ts`: profile lifecycle and encrypted FTP config.
- `src/server/profiles/profileRoutes.ts`: portal API routes.
- `src/server/ftp/ftpTypes.ts`: FTP config and client abstraction types.
- `src/server/ftp/basicFtpClient.ts`: `basic-ftp` implementation.
- `src/server/ftp/crawler.ts`: background crawl and index writes.
- `src/server/media/parser.ts`: filename/path parser.
- `src/server/media/normalizer.ts`: title normalization helpers.
- `src/server/media/mediaRepository.ts`: media index queries and writes.
- `src/server/metadata/cinemetaClient.ts`: Cinemeta metadata fetch/cache.
- `src/server/stremio/manifest.ts`: public and per-token manifests.
- `src/server/stremio/streamResolver.ts`: movie/episode stream matching.
- `src/server/stremio/routes.ts`: Stremio HTTP routes.
- `src/server/proxy/range.ts`: HTTP range parsing.
- `src/server/proxy/proxyRoutes.ts`: authenticated HTTP stream proxy.
- `src/server/logging/redact.ts`: redaction helper for logs/errors.
- `src/shared/apiTypes.ts`: request/response types shared with React.
- `src/web/main.tsx`: React entrypoint.
- `src/web/App.tsx`: config portal shell.
- `src/web/api.ts`: typed portal API client.
- `src/web/styles.css`: responsive modern admin UI styling.
- `tests/**/*.test.ts`: Vitest unit/integration tests.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `.gitignore`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `src/server/index.ts`
- Create: `src/server/app.ts`
- Create: `src/server/config.ts`
- Create: `src/shared/apiTypes.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config test**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

describe("loadConfig", () => {
  it("normalizes required and optional environment values", () => {
    const config = loadConfig({
      BASE_URL: "https://example.test/",
      CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      PORT: "8123",
      LOG_LEVEL: "debug",
      CONFIG_DIR: "/tmp/stremio-ftp-test",
    });

    expect(config.baseUrl).toBe("https://example.test");
    expect(config.port).toBe(8123);
    expect(config.logLevel).toBe("debug");
    expect(config.sqlitePath).toBe("/tmp/stremio-ftp-test/stremio-ftp.sqlite");
    expect(config.maxOnDemandSearchMs).toBe(4500);
  });

  it("rejects missing required values", () => {
    expect(() => loadConfig({})).toThrow("BASE_URL is required");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: command fails because `package.json` and source files do not exist yet.

- [ ] **Step 3: Add the Node/TypeScript scaffold**

Create `package.json`:

```json
{
  "name": "stremio-ftp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server/index.ts",
    "build:web": "vite build",
    "build:server": "tsc -p tsconfig.json",
    "build": "npm run build:web && npm run build:server",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "basic-ftp": "^5.0.5",
    "better-sqlite3": "^12.2.0",
    "express": "^5.1.0",
    "helmet": "^8.1.0",
    "lucide-react": "^0.468.0",
    "mime-types": "^2.1.35",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "stremio-addon-sdk": "^1.6.10",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^5.0.0",
    "@types/mime-types": "^2.1.4",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/supertest": "^6.0.2",
    "jsdom": "^25.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist"]
}
```

Create `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    globals: true,
  },
});
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.env
.config/
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

Create `.dockerignore`:

```dockerignore
.git
node_modules
dist
coverage
.env
docs/superpowers
```

Create `.env.example`:

```dotenv
BASE_URL=https://stremio-ftp.example.com
CONFIG_ENCRYPTION_KEY=replace-with-at-least-32-random-characters
PORT=7000
CONFIG_DIR=/config
LOG_LEVEL=info
CRAWLER_CONCURRENCY=2
FTP_TIMEOUT_MS=15000
INDEX_REFRESH_INTERVAL_MS=21600000
MAX_ON_DEMAND_SEARCH_MS=4500
NEGATIVE_CACHE_TTL_MS=300000
PROXY_IDLE_TIMEOUT_MS=30000
```

Create `src/server/config.ts`:

```ts
export type AppConfig = {
  baseUrl: string;
  configDir: string;
  sqlitePath: string;
  encryptionKey: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  crawlerConcurrency: number;
  ftpTimeoutMs: number;
  indexRefreshIntervalMs: number;
  maxOnDemandSearchMs: number;
  negativeCacheTtlMs: number;
  proxyIdleTimeoutMs: number;
};

function requireValue(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function numberValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be a positive number`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AppConfig {
  const baseUrl = requireValue(env, "BASE_URL").replace(/\/+$/, "");
  const encryptionKey = requireValue(env, "CONFIG_ENCRYPTION_KEY");
  if (encryptionKey.length < 32) throw new Error("CONFIG_ENCRYPTION_KEY must be at least 32 characters");

  const configDir = env.CONFIG_DIR?.trim() || "/config";
  const logLevel = (env.LOG_LEVEL || "info") as AppConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL is invalid");

  return {
    baseUrl,
    configDir,
    sqlitePath: `${configDir.replace(/\/+$/, "")}/stremio-ftp.sqlite`,
    encryptionKey,
    port: numberValue(env, "PORT", 7000),
    logLevel,
    crawlerConcurrency: numberValue(env, "CRAWLER_CONCURRENCY", 2),
    ftpTimeoutMs: numberValue(env, "FTP_TIMEOUT_MS", 15000),
    indexRefreshIntervalMs: numberValue(env, "INDEX_REFRESH_INTERVAL_MS", 21600000),
    maxOnDemandSearchMs: numberValue(env, "MAX_ON_DEMAND_SEARCH_MS", 4500),
    negativeCacheTtlMs: numberValue(env, "NEGATIVE_CACHE_TTL_MS", 300000),
    proxyIdleTimeoutMs: numberValue(env, "PROXY_IDLE_TIMEOUT_MS", 30000),
  };
}
```

Create `src/server/app.ts`:

```ts
import express from "express";
import helmet from "helmet";
import type { AppConfig } from "./config.js";

export function createApp(config: AppConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "stremio-ftp", baseUrl: config.baseUrl });
  });

  return app;
}
```

Create `src/server/index.ts`:

```ts
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(`stremio-ftp listening on ${config.port}`);
});
```

Create `src/shared/apiTypes.ts`:

```ts
export type ApiError = { error: string };
export type HealthResponse = { ok: true; service: "stremio-ftp"; baseUrl: string };
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
npm install
```

Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test -- tests/config.test.ts
npm run typecheck
```

Expected: config test and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts .gitignore .dockerignore .env.example src/server src/shared tests/config.test.ts
git commit -m "chore: scaffold typescript service"
```

---

### Task 2: SQLite Schema And Security Primitives

**Files:**
- Create: `src/server/db/database.ts`
- Create: `src/server/db/schema.ts`
- Create: `src/server/security/crypto.ts`
- Create: `src/server/logging/redact.ts`
- Test: `tests/security.test.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/security.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decryptJson,
  encryptJson,
  hashToken,
  randomToken,
  verifyPassphrase,
  createPassphraseVerifier,
} from "../src/server/security/crypto";
import { redactSecrets } from "../src/server/logging/redact";

describe("security helpers", () => {
  it("encrypts and decrypts JSON without exposing plaintext", () => {
    const key = "0123456789abcdef0123456789abcdef";
    const encrypted = encryptJson({ password: "secret", host: "ftp.example.test" }, key);
    expect(encrypted).not.toContain("secret");
    expect(decryptJson(encrypted, key)).toEqual({ password: "secret", host: "ftp.example.test" });
  });

  it("verifies passphrases with scrypt", () => {
    const verifier = createPassphraseVerifier("correct horse battery staple");
    expect(verifyPassphrase("correct horse battery staple", verifier)).toBe(true);
    expect(verifyPassphrase("wrong", verifier)).toBe(false);
  });

  it("hashes tokens and redacts sensitive strings", () => {
    const token = randomToken();
    expect(hashToken(token)).toHaveLength(64);
    expect(redactSecrets(`ftp://user:pass@example.test/${token}`)).toBe("ftp://[redacted]@example.test/[redacted-token]");
  });
});
```

Create `tests/schema.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";

describe("schema", () => {
  it("creates required tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      "crawl_state",
      "media_files",
      "metadata_cache",
      "negative_cache",
      "profiles",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/security.test.ts tests/schema.test.ts
```

Expected: tests fail because modules do not exist.

- [ ] **Step 3: Implement database and security helpers**

Create `src/server/security/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyBytes(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function encryptJson(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyBytes(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptJson<T = unknown>(encoded: string, secret: string): T {
  const payload = Buffer.from(encoded, "base64url");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, keyBytes(secret), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function createPassphraseVerifier(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassphrase(passphrase: string, verifier: string): boolean {
  const [scheme, saltEncoded, expectedEncoded] = verifier.split("$");
  if (scheme !== "scrypt" || !saltEncoded || !expectedEncoded) return false;
  const salt = Buffer.from(saltEncoded, "base64url");
  const expected = Buffer.from(expectedEncoded, "base64url");
  const actual = scryptSync(passphrase, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

Create `src/server/logging/redact.ts`:

```ts
export function redactSecrets(message: string): string {
  return message
    .replace(/ftp(s)?:\/\/[^@\s]+@/gi, "ftp://[redacted]@")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted-token]")
    .replace(/(password|passphrase|token)=([^&\s]+)/gi, "$1=[redacted]");
}
```

Create `src/server/db/schema.ts` with the full schema from the design:

```ts
import type Database from "better-sqlite3";

export function migrate(db: Database.Database) {
  db.exec(`
    create table if not exists profiles (
      id integer primary key autoincrement,
      browser_uid text not null unique,
      passphrase_verifier text not null,
      encrypted_ftp_config text,
      install_token_hash text not null unique,
      created_at text not null,
      updated_at text not null,
      last_unlocked_at text
    );

    create table if not exists media_files (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      ftp_path text not null,
      filename text not null,
      normalized_filename text not null,
      extension text not null,
      size_bytes integer,
      modified_at text,
      media_kind text not null,
      parsed_title text,
      parsed_year integer,
      season integer,
      episode integer,
      imdb_id text,
      quality text,
      confidence integer not null,
      last_seen_at text not null,
      unique(profile_id, ftp_path)
    );

    create index if not exists idx_media_episode on media_files(profile_id, media_kind, parsed_title, season, episode);
    create index if not exists idx_media_movie on media_files(profile_id, media_kind, imdb_id, parsed_title, parsed_year);

    create table if not exists crawl_state (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      root_path text not null,
      status text not null,
      last_scan_started_at text,
      last_scan_finished_at text,
      last_error text,
      files_seen integer not null default 0,
      unique(profile_id, root_path)
    );

    create table if not exists metadata_cache (
      id integer primary key autoincrement,
      type text not null,
      imdb_id text not null,
      payload_json text not null,
      fetched_at text not null,
      unique(type, imdb_id)
    );

    create table if not exists negative_cache (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      type text not null,
      stremio_id text not null,
      expires_at text not null,
      unique(profile_id, type, stremio_id)
    );
  `);
}
```

Create `src/server/db/database.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./schema.js";

export function openDatabase(sqlitePath: string) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/security.test.ts tests/schema.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/db src/server/security src/server/logging tests/security.test.ts tests/schema.test.ts
git commit -m "feat: add sqlite schema and security helpers"
```

---

### Task 3: Media Filename Parser

**Files:**
- Create: `src/server/media/normalizer.ts`
- Create: `src/server/media/parser.ts`
- Test: `tests/mediaParser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/mediaParser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeTitle } from "../src/server/media/normalizer";
import { parseMediaPath } from "../src/server/media/parser";

describe("media parser", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("The.Last.of.Us")).toBe("last of us");
    expect(normalizeTitle("Marvel's Agents_of_S.H.I.E.L.D")).toBe("marvels agents of shield");
  });

  it("parses SxxEyy episode filenames", () => {
    expect(parseMediaPath("/TV/Show.Name/Season 02/Show.Name.S02E05.1080p.mkv")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
      quality: "1080p",
      extension: "mkv",
    });
  });

  it("parses 2x05 episode filenames", () => {
    expect(parseMediaPath("/TV/Show Name/Show Name - 2x05 - Episode Title.mp4")).toMatchObject({
      mediaKind: "series",
      parsedTitle: "show name",
      season: 2,
      episode: 5,
      extension: "mp4",
    });
  });

  it("parses movie title year and imdb id", () => {
    expect(parseMediaPath("/Movies/The.Matrix.1999.tt0133093.2160p.mkv")).toMatchObject({
      mediaKind: "movie",
      parsedTitle: "matrix",
      parsedYear: 1999,
      imdbId: "tt0133093",
      quality: "2160p",
    });
  });

  it("ignores unsupported files", () => {
    expect(parseMediaPath("/TV/Show/notes.txt")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/mediaParser.test.ts
```

Expected: test fails because media modules do not exist.

- [ ] **Step 3: Implement parser**

Create `src/server/media/normalizer.ts`:

```ts
const STOP_WORDS = new Set(["the"]);

export function normalizeTitle(input: string): string {
  return input
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/s\.h\.i\.e\.l\.d/gi, "shield")
    .replace(/[\._-]+/g, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part && !STOP_WORDS.has(part))
    .join(" ")
    .trim();
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
```

Create `src/server/media/parser.ts`:

```ts
import { basename, normalizeTitle } from "./normalizer.js";

const SUPPORTED_EXTENSIONS = new Set(["mkv", "mp4", "avi", "mov", "m4v", "ts", "webm"]);

export type ParsedMedia = {
  mediaKind: "movie" | "series";
  ftpPath: string;
  filename: string;
  normalizedFilename: string;
  extension: string;
  parsedTitle: string;
  parsedYear: number | null;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  quality: string | null;
  confidence: number;
};

function qualityOf(value: string): string | null {
  return value.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1]?.toLowerCase() || null;
}

function stripKnownTokens(value: string): string {
  return value
    .replace(/\b(2160p|1080p|720p|480p|4k|bluray|webrip|web-dl|hdtv|x264|x265|hevc|aac|dts)\b/gi, " ")
    .replace(/\btt\d{7,8}\b/gi, " ");
}

export function parseMediaPath(ftpPath: string): ParsedMedia | null {
  const filename = basename(ftpPath);
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;

  const withoutExtension = filename.replace(new RegExp(`\\.${extension}$`, "i"), "");
  const normalizedFilename = normalizeTitle(filename);
  const imdbId = ftpPath.match(/\btt\d{7,8}\b/i)?.[0] || null;
  const quality = qualityOf(ftpPath);

  const sxe = withoutExtension.match(/^(?<title>.+?)[\s._-]+s(?<season>\d{1,2})e(?<episode>\d{1,3})\b/i);
  if (sxe?.groups) {
    return {
      mediaKind: "series",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: normalizeTitle(sxe.groups.title),
      parsedYear: null,
      season: Number(sxe.groups.season),
      episode: Number(sxe.groups.episode),
      imdbId,
      quality,
      confidence: 95,
    };
  }

  const xPattern = withoutExtension.match(/^(?<title>.+?)[\s._-]+(?<season>\d{1,2})x(?<episode>\d{1,3})\b/i);
  if (xPattern?.groups) {
    return {
      mediaKind: "series",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: normalizeTitle(xPattern.groups.title),
      parsedYear: null,
      season: Number(xPattern.groups.season),
      episode: Number(xPattern.groups.episode),
      imdbId,
      quality,
      confidence: 90,
    };
  }

  const year = withoutExtension.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  const titleBeforeYear = year ? withoutExtension.slice(0, withoutExtension.indexOf(year)) : stripKnownTokens(withoutExtension);

  return {
    mediaKind: "movie",
    ftpPath,
    filename,
    normalizedFilename,
    extension,
    parsedTitle: normalizeTitle(stripKnownTokens(titleBeforeYear)),
    parsedYear: year ? Number(year) : null,
    season: null,
    episode: null,
    imdbId,
    quality,
    confidence: imdbId ? 90 : year ? 70 : 45,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/mediaParser.test.ts
npm run typecheck
```

Expected: parser tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/media tests/mediaParser.test.ts
git commit -m "feat: parse movie and episode filenames"
```

---

### Task 4: Profile Storage And Portal API

**Files:**
- Create: `src/server/profiles/profileService.ts`
- Create: `src/server/profiles/profileRoutes.ts`
- Modify: `src/server/app.ts`
- Test: `tests/profileService.test.ts`
- Test: `tests/profileRoutes.test.ts`

- [ ] **Step 1: Write failing service and route tests**

Create `tests/profileService.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";

const key = "0123456789abcdef0123456789abcdef";

describe("ProfileService", () => {
  it("creates, unlocks, and rotates install tokens", () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);

    const created = service.createProfile("browser-uid", "passphrase");
    expect(created.installUrlToken).toHaveLength(32);

    const unlocked = service.unlockProfile("browser-uid", "passphrase");
    expect(unlocked.profileId).toBe(created.profileId);
    expect(() => service.unlockProfile("browser-uid", "wrong")).toThrow("Invalid passphrase");

    const rotated = service.rotateInstallToken(created.profileId);
    expect(rotated.installUrlToken).not.toBe(created.installUrlToken);
  });

  it("stores encrypted ftp config", () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = service.createProfile("browser-uid", "passphrase");

    service.saveFtpConfig(created.profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: true,
      roots: ["/Media"],
    });

    const row = db.prepare("select encrypted_ftp_config from profiles where id = ?").get(created.profileId) as { encrypted_ftp_config: string };
    expect(row.encrypted_ftp_config).not.toContain("secret");
    expect(service.getFtpConfig(created.profileId)?.host).toBe("ftp.example.test");
  });
});
```

Create `tests/profileRoutes.test.ts`:

```ts
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";

function config(): AppConfig {
  return {
    baseUrl: "https://addon.example.test",
    configDir: "/tmp",
    sqlitePath: ":memory:",
    encryptionKey: "0123456789abcdef0123456789abcdef",
    port: 7000,
    logLevel: "error",
    crawlerConcurrency: 2,
    ftpTimeoutMs: 15000,
    indexRefreshIntervalMs: 21600000,
    maxOnDemandSearchMs: 4500,
    negativeCacheTtlMs: 300000,
    proxyIdleTimeoutMs: 30000,
  };
}

describe("profile routes", () => {
  it("creates a profile and returns install URLs", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const response = await request(app)
      .post("/api/profile")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    expect(response.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
    expect(response.body.stremioInstallUrl).toMatch(/^stremio:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/profileService.test.ts tests/profileRoutes.test.ts
```

Expected: tests fail because profile modules and app signature are missing.

- [ ] **Step 3: Implement profile service and routes**

Implement `src/server/profiles/profileService.ts` with:

```ts
import type Database from "better-sqlite3";
import { createPassphraseVerifier, decryptJson, encryptJson, hashToken, randomToken, verifyPassphrase } from "../security/crypto.js";

export type FtpConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: "none" | "explicit";
  allowInvalidCertificate: boolean;
  roots: string[];
};

export class ProfileService {
  constructor(private readonly db: Database.Database, private readonly encryptionKey: string) {}

  createProfile(browserUid: string, passphrase: string) {
    const token = randomToken();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at)
        values (?, ?, ?, ?, ?)
      `)
      .run(browserUid, createPassphraseVerifier(passphrase), hashToken(token), now, now);
    return { profileId: Number(result.lastInsertRowid), installUrlToken: token };
  }

  unlockProfile(browserUid: string, passphrase: string) {
    const row = this.db.prepare("select id, passphrase_verifier from profiles where browser_uid = ?").get(browserUid) as
      | { id: number; passphrase_verifier: string }
      | undefined;
    if (!row || !verifyPassphrase(passphrase, row.passphrase_verifier)) throw new Error("Invalid passphrase");
    this.db.prepare("update profiles set last_unlocked_at = ? where id = ?").run(new Date().toISOString(), row.id);
    return { profileId: row.id };
  }

  saveFtpConfig(profileId: number, config: FtpConfig) {
    const encrypted = encryptJson(config, this.encryptionKey);
    this.db.prepare("update profiles set encrypted_ftp_config = ?, updated_at = ? where id = ?").run(encrypted, new Date().toISOString(), profileId);
  }

  getFtpConfig(profileId: number): FtpConfig | null {
    const row = this.db.prepare("select encrypted_ftp_config from profiles where id = ?").get(profileId) as { encrypted_ftp_config: string | null } | undefined;
    if (!row?.encrypted_ftp_config) return null;
    return decryptJson<FtpConfig>(row.encrypted_ftp_config, this.encryptionKey);
  }

  rotateInstallToken(profileId: number) {
    const token = randomToken();
    this.db.prepare("update profiles set install_token_hash = ?, updated_at = ? where id = ?").run(hashToken(token), new Date().toISOString(), profileId);
    return { installUrlToken: token };
  }

  profileIdForInstallToken(token: string): number | null {
    const row = this.db.prepare("select id from profiles where install_token_hash = ?").get(hashToken(token)) as { id: number } | undefined;
    return row?.id ?? null;
  }
}
```

Implement `src/server/profiles/profileRoutes.ts` with request validation and URL generation:

```ts
import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ProfileService } from "./profileService.js";

const createSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});

function urls(baseUrl: string, token: string) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  return {
    manifestUrl,
    stremioInstallUrl: manifestUrl.replace(/^https?:\/\//, "stremio://"),
  };
}

export function profileRoutes(config: AppConfig, service: ProfileService) {
  const router = Router();

  router.post("/profile", (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid profile request" });
    const created = service.createProfile(parsed.data.browserUid, parsed.data.passphrase);
    res.status(201).json({ profileId: created.profileId, recoveryUid: parsed.data.browserUid, ...urls(config.baseUrl, created.installUrlToken) });
  });

  router.post("/profile/unlock", (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid unlock request" });
    try {
      const unlocked = service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json(unlocked);
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  return router;
}
```

Modify `src/server/app.ts` to accept a database and mount `/api`:

```ts
import type Database from "better-sqlite3";
import express from "express";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { ProfileService } from "./profiles/profileService.js";
import { profileRoutes } from "./profiles/profileRoutes.js";

export function createApp(config: AppConfig, db: Database.Database = openDatabase(config.sqlitePath)) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "128kb" }));

  const profileService = new ProfileService(db, config.encryptionKey);
  app.use("/api", profileRoutes(config, profileService));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "stremio-ftp", baseUrl: config.baseUrl });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/profileService.test.ts tests/profileRoutes.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/profiles tests/profileService.test.ts tests/profileRoutes.test.ts
git commit -m "feat: add profile storage api"
```

---

### Task 5: Media Repository And FTP Crawler

**Files:**
- Create: `src/server/ftp/ftpTypes.ts`
- Create: `src/server/ftp/basicFtpClient.ts`
- Create: `src/server/ftp/crawler.ts`
- Create: `src/server/media/mediaRepository.ts`
- Test: `tests/mediaRepository.test.ts`
- Test: `tests/crawler.test.ts`

- [ ] **Step 1: Write failing repository and crawler tests**

Create `tests/mediaRepository.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";

describe("MediaRepository", () => {
  it("upserts and queries episode rows", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = Number(db.prepare("insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at) values ('uid', 'v', 'h', 'n', 'n')").run().lastInsertRowid);
    const repo = new MediaRepository(db);

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
      filename: "Show.Name.S02E05.1080p.mkv",
      normalizedFilename: "show name s02e05 1080p",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "1080p",
      confidence: 95,
    });

    expect(repo.findEpisode(profileId, "show name", 2, 5)).toHaveLength(1);
  });
});
```

Create `tests/crawler.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { crawlProfileRoot } from "../src/server/ftp/crawler";
import type { FtpClientFactory } from "../src/server/ftp/ftpTypes";
import { MediaRepository } from "../src/server/media/mediaRepository";

describe("crawler", () => {
  it("walks directories and indexes media files", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = Number(db.prepare("insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at) values ('uid', 'v', 'h', 'n', 'n')").run().lastInsertRowid);
    const repo = new MediaRepository(db);
    const factory: FtpClientFactory = async () => ({
      list: async (path) =>
        path === "/"
          ? [{ name: "TV", path: "/TV", type: "directory" }]
          : [{ name: "Show.Name.S02E05.1080p.mkv", path: "/TV/Show.Name.S02E05.1080p.mkv", type: "file", size: 1000 }],
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig: { host: "x", port: 21, username: "u", password: "p", tlsMode: "none", allowInvalidCertificate: false, roots: ["/"] }, factory, repo });

    expect(result.filesSeen).toBe(1);
    expect(repo.findEpisode(profileId, "show name", 2, 5)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/mediaRepository.test.ts tests/crawler.test.ts
```

Expected: tests fail because repository and crawler modules do not exist.

- [ ] **Step 3: Implement repository and crawler abstractions**

Create `src/server/ftp/ftpTypes.ts`:

```ts
import type { FtpConfig } from "../profiles/profileService.js";

export type FtpEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
};

export type FtpClient = {
  list(path: string): Promise<FtpEntry[]>;
  close(): Promise<void>;
};

export type FtpClientFactory = (config: FtpConfig) => Promise<FtpClient>;
```

Create `src/server/media/mediaRepository.ts` with `upsertParsedFile`, `findEpisode`, `findMovie`, and negative cache helpers. Use SQL inserts against the schema and order matches by `confidence desc, size_bytes desc`.

Create `src/server/ftp/crawler.ts`:

```ts
import type { FtpConfig } from "../profiles/profileService.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import { parseMediaPath } from "../media/parser.js";
import type { FtpClientFactory } from "./ftpTypes.js";

export type CrawlProfileRootInput = {
  profileId: number;
  rootPath: string;
  ftpConfig: FtpConfig;
  factory: FtpClientFactory;
  repo: MediaRepository;
};

export async function crawlProfileRoot(input: CrawlProfileRootInput) {
  const client = await input.factory(input.ftpConfig);
  let filesSeen = 0;

  async function walk(path: string) {
    const entries = await client.list(path);
    for (const entry of entries) {
      if (entry.type === "directory") {
        await walk(entry.path);
      } else {
        const parsed = parseMediaPath(entry.path);
        if (parsed) {
          filesSeen += 1;
          input.repo.upsertParsedFile(input.profileId, {
            ...parsed,
            sizeBytes: entry.size ?? null,
            modifiedAt: entry.modifiedAt ?? null,
          });
        }
      }
    }
  }

  try {
    await walk(input.rootPath);
    return { filesSeen };
  } finally {
    await client.close();
  }
}
```

Create `src/server/ftp/basicFtpClient.ts` using `basic-ftp`:

```ts
import { Client, FileType } from "basic-ftp";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClient, FtpClientFactory } from "./ftpTypes.js";

export const createBasicFtpClient: FtpClientFactory = async (config: FtpConfig): Promise<FtpClient> => {
  const client = new Client();
  await client.access({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    secure: config.tlsMode === "explicit",
    secureOptions: config.allowInvalidCertificate ? { rejectUnauthorized: false } : undefined,
  });

  return {
    async list(path: string) {
      const entries = await client.list(path);
      return entries.map((entry) => ({
        name: entry.name,
        path: `${path.replace(/\/+$/, "")}/${entry.name}`,
        type: entry.type === FileType.Directory ? "directory" : "file",
        size: entry.size,
        modifiedAt: entry.modifiedAt?.toISOString(),
      }));
    },
    async close() {
      client.close();
    },
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/mediaRepository.test.ts tests/crawler.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/ftp src/server/media/mediaRepository.ts tests/mediaRepository.test.ts tests/crawler.test.ts
git commit -m "feat: index ftp media files"
```

---

### Task 6: Cinemeta Client And Stream Resolver

**Files:**
- Create: `src/server/metadata/cinemetaClient.ts`
- Create: `src/server/stremio/streamResolver.ts`
- Test: `tests/cinemetaClient.test.ts`
- Test: `tests/streamResolver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/streamResolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveStreams } from "../src/server/stremio/streamResolver";

describe("stream resolver", () => {
  it("resolves a series episode to a proxy stream", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "series",
      id: "tt1234567:2:5",
      metadata: { name: "Show Name" },
      mediaRepository: {
        findEpisode: () => [{ id: 99, filename: "Show.Name.S02E05.1080p.mkv", quality: "1080p", sizeBytes: 2254857830 }],
        findMovie: () => [],
      },
    });

    expect(streams[0]).toMatchObject({
      name: "FTP 1080p",
      url: "https://addon.example.test/proxy/token/99",
      behaviorHints: {
        notWebReady: true,
        filename: "Show.Name.S02E05.1080p.mkv",
        videoSize: 2254857830,
      },
    });
  });
});
```

Create `tests/cinemetaClient.test.ts` with a mocked `fetch`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchCinemetaMeta } from "../src/server/metadata/cinemetaClient";

describe("fetchCinemetaMeta", () => {
  it("returns Cinemeta metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ meta: { id: "tt1234567", name: "Show Name", releaseInfo: "2020" } }))));
    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toEqual({ id: "tt1234567", name: "Show Name", releaseInfo: "2020" });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/cinemetaClient.test.ts tests/streamResolver.test.ts
```

Expected: tests fail because modules do not exist.

- [ ] **Step 3: Implement metadata client and stream resolver**

Create `src/server/metadata/cinemetaClient.ts`:

```ts
export type CinemetaMeta = {
  id: string;
  name: string;
  releaseInfo?: string;
};

export async function fetchCinemetaMeta(type: "movie" | "series", imdbId: string): Promise<CinemetaMeta | null> {
  const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
  if (!response.ok) return null;
  const body = (await response.json()) as { meta?: CinemetaMeta };
  return body.meta ?? null;
}
```

Create `src/server/stremio/streamResolver.ts`:

```ts
import { normalizeTitle } from "../media/normalizer.js";

type MediaMatch = {
  id: number;
  filename: string;
  quality: string | null;
  sizeBytes: number | null;
};

type RepoLike = {
  findEpisode(profileId: number, normalizedTitle: string, season: number, episode: number): MediaMatch[];
  findMovie(profileId: number, imdbId: string, normalizedTitle: string, year: number | null): MediaMatch[];
};

export async function resolveStreams(input: {
  baseUrl: string;
  installToken: string;
  profileId: number;
  type: "movie" | "series";
  id: string;
  metadata: { name: string; releaseInfo?: string } | null;
  mediaRepository: RepoLike;
}) {
  if (!input.metadata) return [];

  const matches =
    input.type === "series"
      ? episodeMatches(input)
      : input.mediaRepository.findMovie(input.profileId, input.id, normalizeTitle(input.metadata.name), yearFrom(input.metadata.releaseInfo));

  return matches.map((match) => ({
    name: `FTP ${match.quality ?? "Source"}`,
    description: `${match.filename}${match.sizeBytes ? `\n${formatBytes(match.sizeBytes)}` : ""}`,
    url: `${input.baseUrl}/proxy/${input.installToken}/${match.id}`,
    behaviorHints: {
      notWebReady: true,
      filename: match.filename,
      ...(match.sizeBytes ? { videoSize: match.sizeBytes } : {}),
    },
  }));
}

function episodeMatches(input: Parameters<typeof resolveStreams>[0]): MediaMatch[] {
  const [, seasonRaw, episodeRaw] = input.id.split(":");
  const season = Number(seasonRaw);
  const episode = Number(episodeRaw);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return [];
  return input.mediaRepository.findEpisode(input.profileId, normalizeTitle(input.metadata?.name ?? ""), season, episode);
}

function yearFrom(releaseInfo?: string): number | null {
  const year = releaseInfo?.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  return year ? Number(year) : null;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/cinemetaClient.test.ts tests/streamResolver.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/metadata src/server/stremio/streamResolver.ts tests/cinemetaClient.test.ts tests/streamResolver.test.ts
git commit -m "feat: resolve stremio streams from index"
```

---

### Task 7: Stremio Manifest And Stream Routes

**Files:**
- Create: `src/server/stremio/manifest.ts`
- Create: `src/server/stremio/routes.ts`
- Modify: `src/server/app.ts`
- Test: `tests/stremioRoutes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `tests/stremioRoutes.test.ts`:

```ts
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";

const config: AppConfig = {
  baseUrl: "https://addon.example.test",
  configDir: "/tmp",
  sqlitePath: ":memory:",
  encryptionKey: "0123456789abcdef0123456789abcdef",
  port: 7000,
  logLevel: "error",
  crawlerConcurrency: 2,
  ftpTimeoutMs: 15000,
  indexRefreshIntervalMs: 21600000,
  maxOnDemandSearchMs: 4500,
  negativeCacheTtlMs: 300000,
  proxyIdleTimeoutMs: 30000,
};

describe("stremio routes", () => {
  it("returns per-token manifest", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = service.createProfile("uid-12345678", "passphrase");
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);
    expect(response.body).toMatchObject({
      id: "community.stremio-ftp",
      resources: ["stream"],
      types: ["movie", "series"],
      idPrefixes: ["tt"],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  });

  it("returns empty streams for invalid tokens", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config, db);
    const response = await request(app).get("/u/not-real/stream/movie/tt0133093.json").expect(200);
    expect(response.body).toEqual({ streams: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/stremioRoutes.test.ts
```

Expected: test fails because Stremio routes do not exist.

- [ ] **Step 3: Implement manifest and route mounting**

Create `src/server/stremio/manifest.ts`:

```ts
export function publicManifest() {
  return {
    id: "community.stremio-ftp",
    version: "0.1.0",
    name: "FTP Streams",
    description: "Stream movies and series episodes from your configured FTP server.",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}

export function tokenManifest() {
  return {
    ...publicManifest(),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
```

Create `src/server/stremio/routes.ts` with:

- `GET /manifest.json` returning `publicManifest()`.
- `GET /u/:installToken/manifest.json` returning `tokenManifest()` when the token maps to a profile and `publicManifest()` with `configurationRequired: true` when invalid.
- `GET /u/:installToken/stream/:type/:id.json` validating the token, fetching Cinemeta metadata, resolving streams, and returning `{ streams }`.
- Invalid token, missing metadata, and resolver errors return `{ streams: [] }`.

Modify `src/server/app.ts` to construct `MediaRepository`, `ProfileService`, and mount Stremio routes after `/api`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/stremioRoutes.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/stremio tests/stremioRoutes.test.ts
git commit -m "feat: expose stremio addon routes"
```

---

### Task 8: HTTP Range Proxy

**Files:**
- Create: `src/server/proxy/range.ts`
- Create: `src/server/proxy/proxyRoutes.ts`
- Modify: `src/server/app.ts`
- Test: `tests/range.test.ts`
- Test: `tests/proxyRoutes.test.ts`

- [ ] **Step 1: Write failing range and proxy tests**

Create `tests/range.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "../src/server/proxy/range";

describe("parseRangeHeader", () => {
  it("parses explicit byte ranges", () => {
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19, size: 10 });
  });

  it("parses open-ended byte ranges", () => {
    expect(parseRangeHeader("bytes=90-", 100)).toEqual({ start: 90, end: 99, size: 10 });
  });

  it("rejects invalid ranges", () => {
    expect(parseRangeHeader("bytes=150-160", 100)).toBeNull();
  });
});
```

Create `tests/proxyRoutes.test.ts` using a fake stream provider:

```ts
import { Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createProxyRouter } from "../src/server/proxy/proxyRoutes";

describe("proxy routes", () => {
  it("returns partial content for range requests", async () => {
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        openReadStream: async ({ start, end }) => Readable.from(Buffer.from("0123456789").subarray(start, end + 1)),
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/1").set("Range", "bytes=2-5").expect(206);
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.text).toBe("2345");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/range.test.ts tests/proxyRoutes.test.ts
```

Expected: tests fail because proxy modules do not exist.

- [ ] **Step 3: Implement range and proxy routes**

Create `src/server/proxy/range.ts`:

```ts
export type ByteRange = { start: number; end: number; size: number };

export function parseRangeHeader(header: string | undefined, totalSize: number | null): ByteRange | null {
  if (!header || totalSize === null) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : totalSize - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= totalSize) return null;
  return { start, end: Math.min(end, totalSize - 1), size: Math.min(end, totalSize - 1) - start + 1 };
}
```

Create `src/server/proxy/proxyRoutes.ts` with:

- `GET /proxy/:installToken/:fileId`.
- `HEAD /proxy/:installToken/:fileId`.
- token/file ownership validation through injected resolver.
- `206` with `Content-Range` for valid ranges.
- `200` for full file when no range is present.
- `416` when a range header is present and invalid.
- `Accept-Ranges: bytes` for known sizes.
- stream cleanup on client disconnect.

The route factory signature should match the test:

```ts
export function createProxyRouter(deps: {
  resolve(input: { installToken: string; fileId: number }): Promise<{
    filename: string;
    sizeBytes: number | null;
    openReadStream(input: { start: number; end: number }): Promise<NodeJS.ReadableStream>;
  } | null>;
}) { /* implementation */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/range.test.ts tests/proxyRoutes.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxy src/server/app.ts tests/range.test.ts tests/proxyRoutes.test.ts
git commit -m "feat: add http range stream proxy"
```

---

### Task 9: React Config Portal

**Files:**
- Create: `index.html`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`
- Create: `src/web/api.ts`
- Create: `src/web/styles.css`
- Modify: `src/server/app.ts`
- Test: `tests/webApp.test.tsx`

- [ ] **Step 1: Write failing UI smoke test**

Create `tests/webApp.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/web/App";

describe("App", () => {
  it("renders the FTP configuration portal", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "FTP Streams" })).toBeTruthy();
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(screen.getByText("Index status")).toBeTruthy();
  });
});
```

Add `@testing-library/react` and `@testing-library/jest-dom` as dev dependencies when implementing this task.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/webApp.test.tsx
```

Expected: test fails because React app does not exist.

- [ ] **Step 3: Implement modern config UI**

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FTP Streams</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

Create `src/web/App.tsx` as a single operational portal with:

- compact header titled `FTP Streams`;
- first-run profile panel with passphrase field and recovery UID display;
- FTP settings form with host, port, username, replace-only password, TLS mode, invalid certificate toggle, and root paths;
- status panel titled `Index status`;
- buttons: `Test connection`, `Save`, `Install in Stremio`, `Rescan`, `Pause`, `Rotate`, `Delete`;
- icon buttons from `lucide-react` for copy, refresh, pause, rotate, and delete;
- no marketing hero.

Create `src/web/styles.css` with responsive CSS:

- neutral light background;
- white tool panels with 8px radius;
- two-column desktop grid and single-column mobile;
- stable button dimensions;
- status badges using green, amber, red, and gray;
- no gradients, decorative blobs, or nested cards.

Modify `src/server/app.ts` to serve `dist/public` in production and fallback `/configure` and `/` to `index.html`.

- [ ] **Step 4: Install UI test dependencies**

Run:

```bash
npm install -D @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 5: Run tests and build**

Run:

```bash
npm test -- tests/webApp.test.tsx
npm run build:web
npm run typecheck
```

Expected: UI test, web build, and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add index.html src/web src/server/app.ts package.json package-lock.json tests/webApp.test.tsx
git commit -m "feat: add configuration portal"
```

---

### Task 10: Docker, README, And End-To-End Verification

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Modify: `README.md`
- Test: `tests/appHealth.test.ts`

- [ ] **Step 1: Write failing health integration test**

Create `tests/appHealth.test.ts`:

```ts
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";

describe("app health", () => {
  it("serves health response", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const config: AppConfig = {
      baseUrl: "https://addon.example.test",
      configDir: "/tmp",
      sqlitePath: ":memory:",
      encryptionKey: "0123456789abcdef0123456789abcdef",
      port: 7000,
      logLevel: "error",
      crawlerConcurrency: 2,
      ftpTimeoutMs: 15000,
      indexRefreshIntervalMs: 21600000,
      maxOnDemandSearchMs: 4500,
      negativeCacheTtlMs: 300000,
      proxyIdleTimeoutMs: 30000,
    };
    const response = await request(createApp(config, db)).get("/health").expect(200);
    expect(response.body).toEqual({ ok: true, service: "stremio-ftp", baseUrl: "https://addon.example.test" });
  });
});
```

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
npm run build
```

Expected: all tests and production build pass.

- [ ] **Step 3: Add Docker packaging**

Create `Dockerfile`:

```Dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7000
ENV CONFIG_DIR=/config
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME ["/config"]
EXPOSE 7000
CMD ["node", "dist/server/index.js"]
```

Create `docker-compose.yml`:

```yaml
services:
  stremio-ftp:
    build: .
    ports:
      - "7000:7000"
    environment:
      BASE_URL: "http://127.0.0.1:7000"
      CONFIG_ENCRYPTION_KEY: "replace-with-at-least-32-random-characters"
      PORT: "7000"
      CONFIG_DIR: "/config"
    volumes:
      - ./config:/config
    restart: unless-stopped
```

- [ ] **Step 4: Expand README**

Replace `README.md` with sections:

- what the addon does;
- legal content/access note;
- local development;
- Docker Compose startup;
- required HTTPS reverse proxy for remote Stremio use;
- configuration portal workflow;
- generated manifest URL example;
- sample environment variables;
- troubleshooting for FTP TLS/certificate issues and empty index.

- [ ] **Step 5: Verify Docker build**

Run:

```bash
docker build -t stremio-ftp:local .
```

Expected: image builds successfully.

- [ ] **Step 6: Run app locally**

Run:

```bash
npm run build
BASE_URL=http://127.0.0.1:7000 CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef CONFIG_DIR=.config PORT=7000 npm start
```

Expected: server prints `stremio-ftp listening on 7000`. Visit `http://127.0.0.1:7000/health` and expect JSON with `ok: true`.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml README.md tests/appHealth.test.ts
git commit -m "docs: add docker deployment guide"
```

---

## Plan Self-Review

- Spec coverage: the tasks cover the approved TypeScript monolith, encrypted browser UID/passphrase profiles, manifest URL generation, SQLite state, hybrid FTP indexing foundation, Cinemeta-backed movie/episode matching, HTTP proxy range support, clean config portal, Docker deployment, and README guidance.
- Scope control: v1 excludes catalogs, transcoding, archive extraction, WebDAV, cloud accounts, and full-file media caching, matching the design doc.
- Test coverage: each behavior area starts with failing tests and ends with targeted verification commands.
- Type consistency: profile IDs are numeric database IDs; install tokens are raw URL tokens externally and SHA-256 hashes in storage; Stremio IDs stay raw IMDb/Cinemeta IDs.

## Related Learnings

- [TVA-inspired configuration portal polish](../../solutions/design-patterns/tva-inspired-config-portal-polish-2026-05-06.md) documents the later portal refinements that supersede parts of the initial UI plan: setup-first sequencing, TVA visual language, accessible accordions/menus, transform-based progress animation, custom checkbox states, and a scannable changelog drawer.

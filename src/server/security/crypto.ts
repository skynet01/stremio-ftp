import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  const parts = verifier.split("$");
  if (parts.length !== 3) return false;
  const [scheme, saltEncoded, expectedEncoded] = parts;
  if (scheme !== "scrypt" || !BASE64URL_PATTERN.test(saltEncoded) || !BASE64URL_PATTERN.test(expectedEncoded)) return false;
  const salt = Buffer.from(saltEncoded, "base64url");
  const expected = Buffer.from(expectedEncoded, "base64url");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(passphrase, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

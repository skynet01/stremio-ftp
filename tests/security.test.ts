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

  it("rejects malformed passphrase verifiers", () => {
    const verifier = createPassphraseVerifier("anything");
    expect(verifyPassphrase("anything", "scrypt$aaaa$!!!!")).toBe(false);
    expect(verifyPassphrase("anything", "scrypt$a$a")).toBe(false);
    expect(verifyPassphrase("anything", `${verifier}$extra`)).toBe(false);
  });

  it("hashes tokens and redacts sensitive strings", () => {
    const token = randomToken();
    expect(hashToken(token)).toHaveLength(64);
    expect(redactSecrets(`ftp://user:pass@example.test/${token}`)).toBe("ftp://[redacted]@example.test/[redacted-token]");
  });

  it("redacts object-style secrets and URL query parameters", () => {
    expect(redactSecrets('{"password":"secret"}')).toBe('{"password":"[redacted]"}');
    expect(redactSecrets('{"passphrase":"correct horse battery staple"}')).toBe('{"passphrase":"[redacted]"}');
    expect(redactSecrets("token: shortvalue")).toBe("token: [redacted]");
    expect(redactSecrets("passphrase: correct horse battery staple")).toBe("passphrase: [redacted]");
    expect(redactSecrets("passphrase=abc")).toBe("passphrase=[redacted]");
    expect(redactSecrets("https://example.test/?token=shortvalue&password=secret")).toBe(
      "https://example.test/?token=[redacted]&password=[redacted]",
    );
    expect(redactSecrets("ftps://user:pass@example.test/path")).toBe("ftps://[redacted]@example.test/path");
  });
});

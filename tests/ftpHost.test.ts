import { describe, expect, it } from "vitest";
import { isPrivateNetworkHost, splitFtpHost } from "../src/shared/ftpHost";

describe("splitFtpHost", () => {
  it("strips FTP URL schemes, paths, and whitespace", () => {
    expect(splitFtpHost(" ftp://ftp.example.com ")).toEqual({ host: "ftp.example.com", port: null });
    expect(splitFtpHost("ftps://Host.Example.com/Movies/")).toEqual({ host: "Host.Example.com", port: null });
    expect(splitFtpHost("FTPES://ftp.example.com")).toEqual({ host: "ftp.example.com", port: null });
    expect(splitFtpHost("ftp.example.com/")).toEqual({ host: "ftp.example.com", port: null });
  });

  it("moves a typed port out of the host", () => {
    expect(splitFtpHost("ftp://192.168.68.72:13017")).toEqual({ host: "192.168.68.72", port: 13017 });
    expect(splitFtpHost("genesis.whatbox.ca:13017")).toEqual({ host: "genesis.whatbox.ca", port: 13017 });
    expect(splitFtpHost("[fe80::1]:2121")).toEqual({ host: "fe80::1", port: 2121 });
  });

  it("leaves plain hosts and bare IPv6 addresses alone", () => {
    expect(splitFtpHost("sputnik.whatbox.ca")).toEqual({ host: "sputnik.whatbox.ca", port: null });
    expect(splitFtpHost("fe80::1")).toEqual({ host: "fe80::1", port: null });
    expect(splitFtpHost("host:99999")).toEqual({ host: "host:99999", port: null });
  });
});

describe("isPrivateNetworkHost", () => {
  it("flags private, loopback, and link-local addresses", () => {
    for (const host of ["192.168.68.72", "10.0.0.5", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "localhost", "::1", "fe80::1", "fd00::1", "ftp://192.168.1.2:21"]) {
      expect(isPrivateNetworkHost(host), host).toBe(true);
    }
  });

  it("does not flag public addresses or hostnames", () => {
    for (const host of ["sputnik.whatbox.ca", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:4860::8888", ""]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });
});

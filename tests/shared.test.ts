import { describe, expect, it } from "vitest";
import { isLocalHostname } from "../src/shared";

describe("isLocalHostname", () => {
  it("treats loopback origins as local (repo present)", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLocalHostname(host)).toBe(true);
    }
  });

  it("treats hosted origins as remote (must guide from git clone)", () => {
    for (const host of ["writer.zhoulab.io", "192.168.1.42", "10.0.0.5", "0.0.0.0", "example.com"]) {
      expect(isLocalHostname(host)).toBe(false);
    }
  });
});

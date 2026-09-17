import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyUrl, routeIsLive, routes } from "../src/portless.ts";

let home: string;

const state = (files: Record<string, string>): void => {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "portless-"));
  process.env.PORTLESS_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.PORTLESS_HOME;
});

describe("proxyUrl", () => {
  it("carries the port when the proxy is not on the default", () => {
    state({ "proxy.port": "1355", "proxy.tls": "1" });
    expect(proxyUrl("shop")).toBe("https://shop.localhost:1355");
  });

  it("omits the port on 443, which is what a rooted proxy uses", () => {
    state({ "proxy.port": "443", "proxy.tls": "1" });
    expect(proxyUrl("shop")).toBe("https://shop.localhost");
  });

  it("follows the proxy's own scheme", () => {
    state({ "proxy.port": "80", "proxy.tls": "0" });
    expect(proxyUrl("shop")).toBe("http://shop.localhost");
  });

  it("falls back to https when portless has left nothing behind", () => {
    expect(proxyUrl("shop")).toBe("https://shop.localhost");
  });
});

describe("routes", () => {
  it("is empty rather than throwing when the file is corrupt", () => {
    state({ "routes.json": "{not json" });
    expect(routes()).toBeEmpty();
  });

  it("counts a route whose process is alive", () => {
    state({
      "routes.json": JSON.stringify([
        { hostname: "shop.localhost", port: 4481, pid: process.pid },
      ]),
    });
    expect(routeIsLive("shop.localhost")).toBe(true);
  });

  it("ignores a route left behind by a dead process", () => {
    // A killed dev server does not remove its route; treating that as taken
    // would move every later run off a name that is free.
    state({
      "routes.json": JSON.stringify([
        { hostname: "shop.localhost", port: 4481, pid: 0x7ffffff0 },
      ]),
    });
    expect(routeIsLive("shop.localhost")).toBe(false);
  });
});

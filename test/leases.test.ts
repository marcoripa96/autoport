import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, lockIsStale, probeFree, readLeases, release, releaseAll } from "../src/leases.ts";
import { hostname } from "node:os";

let home: string;
const projects: string[] = [];

const project = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "autoport-p-"));
  projects.push(dir);
  return dir;
};

// A port nothing on a developer machine is likely to be holding, so "the first
// project gets the canonical port" is a statement about autoport, not about
// whatever happens to be running.
const CANONICAL = 49999;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "autoport-home-"));
  process.env.AUTOPORT_HOME = home;
  process.env.AUTOPORT_RANGE = "49500-49600";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AUTOPORT_HOME;
  delete process.env.AUTOPORT_RANGE;
});

const requests = (...names: string[]) =>
  names.map((name) => ({ name, canonicalPort: CANONICAL, managed: true }));

describe("acquire", () => {
  it("gives the canonical port to the first project that asks", () => {
    expect(acquire(project(), () => "a", requests("db")).grants.db).toMatchObject({
      port: CANONICAL,
      via: "allocated",
    });
  });

  it("moves a second project out of the way", () => {
    acquire(project(), () => "a", requests("db"));
    const { grants } = acquire(project(), () => "b", requests("db"));
    expect(grants.db!.port).toBeGreaterThanOrEqual(49500);
  });

  it("is sticky — the same project keeps its port", () => {
    const key = project();
    const first = acquire(key, () => "a", requests("db"));
    const second = acquire(key, () => "a", requests("db"));
    expect(second.grants.db).toMatchObject({ port: first.grants.db!.port, via: "lease" });
  });

  it("never hands the same port to two services of one project", () => {
    const { grants } = acquire(project(), () => "a", requests("db", "replica", "analytics"));
    expect(new Set(Object.values(grants).map((grant) => grant.port)).size).toBe(3);
  });

  it("reserves a sibling package's port rather than handing it out again", () => {
    const key = project();
    const web = acquire(key, () => "a", requests("web")).grants.web!.port;
    const api = acquire(key, () => "a", requests("api")).grants.api!.port;
    expect(api).not.toBe(web);
    expect(acquire(key, () => "a", requests("web")).grants.web!.port).toBe(web);
  });

  it("warns instead of evicting when a fixed port is leased elsewhere", () => {
    const first = project();
    acquire(first, () => "a", requests("db"));
    const { grants, warnings } = acquire(project(), () => "b", [
      { name: "db", canonicalPort: CANONICAL, managed: false },
    ]);
    expect(grants.db).toMatchObject({ port: CANONICAL, via: "pinned" });
    expect(warnings.join()).toContain("leased to a");
    // The project that legitimately holds it keeps it.
    expect(readLeases().projects[first]!.services.db).toBe(CANONICAL);
  });

  it("disambiguates names that are already taken", () => {
    acquire(project(), (taken) => (taken("shop") ? "shop-x" : "shop"), requests("db"));
    const key = project();
    acquire(key, (taken) => (taken("shop") ? "shop-x" : "shop"), requests("db"));
    expect(readLeases().projects[key]!.name).toBe("shop-x");
  });

  it("keeps a lease whose directory is only temporarily unreachable", () => {
    const gone = project();
    acquire(gone, () => "gone", requests("db"));
    rmSync(gone, { recursive: true, force: true });
    acquire(project(), () => "here", requests("db"));
    // Recently seen: an unmounted share looks exactly like a deleted directory.
    expect(readLeases().projects[gone]).toBeDefined();
  });

  it("retires a long-unused project whose directory is gone", () => {
    const gone = project();
    acquire(gone, () => "gone", requests("db"));
    rmSync(gone, { recursive: true, force: true });

    const file = JSON.parse(
      require("node:fs").readFileSync(join(home, "leases.json"), "utf8"),
    ) as { projects: Record<string, { lastSeen: string }> };
    file.projects[gone]!.lastSeen = new Date(Date.now() - 30 * 86_400_000).toISOString();
    writeFileSync(join(home, "leases.json"), JSON.stringify(file));

    acquire(project(), () => "here", requests("db"));
    expect(readLeases().projects[gone]).toBeUndefined();
  });

  it("throws a useful message when the range is exhausted", () => {
    process.env.AUTOPORT_RANGE = "49700-49701";
    acquire(project(), () => "a", [
      { name: "x", canonicalPort: 49700, managed: true },
      { name: "y", canonicalPort: 49701, managed: true },
    ]);
    expect(() =>
      acquire(project(), () => "b", [{ name: "z", canonicalPort: 49700, managed: true }]),
    ).toThrow(/no free port in range/);
  });

  it("sets aside a corrupt lease file instead of flattening it", () => {
    writeFileSync(join(home, "leases.json"), "{ not json");
    acquire(project(), () => "a", requests("db"));
    const leftovers = require("node:fs")
      .readdirSync(home)
      .filter((file: string) => file.includes("corrupt"));
    expect(leftovers).toHaveLength(1);
  });
});

describe("locking", () => {
  const takeLock = (owner: Record<string, unknown>): string => {
    const lock = join(home, "lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
    return lock;
  };

  it("does not consider a fresh lock with a live holder stale", () => {
    // The bug this pins: staleness used to be judged from how long the *waiter*
    // had been queued, so a busy-but-healthy holder got its lock deleted.
    expect(
      lockIsStale(takeLock({ pid: process.pid, host: hostname(), at: Date.now() })),
    ).toBe(false);
  });

  it("considers a lock stale once its holder has exited", () => {
    expect(lockIsStale(takeLock({ pid: 999_999, host: hostname(), at: Date.now() }))).toBe(true);
  });

  it("considers an ancient lock stale even if a pid happens to match", () => {
    expect(
      lockIsStale(takeLock({ pid: process.pid, host: hostname(), at: Date.now() - 120_000 })),
    ).toBe(true);
  });

  it("takes over a lock left behind by a dead process", () => {
    takeLock({ pid: 999_999, host: hostname(), at: Date.now() });
    expect(acquire(project(), () => "a", requests("db")).grants.db!.port).toBe(CANONICAL);
  });
});

describe("release", () => {
  it("frees the ports for the next project", () => {
    const key = project();
    acquire(key, () => "a", requests("db"));
    expect(release(key)).toBe(true);
    expect(release(key)).toBe(false);
    expect(acquire(project(), () => "b", requests("db")).grants.db!.port).toBe(CANONICAL);
  });

  it("releaseAll names what it dropped", () => {
    acquire(project(), () => "a", requests("db"));
    acquire(project(), () => "b", requests("db"));
    expect(releaseAll().sort()).toEqual(["a", "b"]);
    expect(Object.keys(readLeases().projects)).toHaveLength(0);
  });
});

describe("probeFree", () => {
  it("sees a port that something else is listening on", () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 49321, socket: { data() {} } });
    try {
      expect(probeFree(49321)).toBe(false);
      expect(probeFree(49322)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("routes allocation around a port held by a stranger", () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 49500, socket: { data() {} } });
    try {
      const { grants } = acquire(project(), () => "a", [
        { name: "db", canonicalPort: 49500, managed: true },
      ]);
      expect(grants.db!.port).not.toBe(49500);
    } finally {
      server.stop(true);
    }
  });

  it("reports a held port that is occupied rather than silently reallocating", () => {
    const key = project();
    const port = acquire(key, () => "a", [{ name: "db", canonicalPort: 49444, managed: true }])
      .grants.db!.port;
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    try {
      const again = acquire(key, () => "a", [{ name: "db", canonicalPort: 49444, managed: true }]);
      expect(again.grants.db).toMatchObject({ port, via: "lease", occupied: true });
    } finally {
      server.stop(true);
    }
  });
});

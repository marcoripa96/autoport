import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export interface ProjectLease {
  name: string;
  /** service name (or `service:role`) -> host port */
  services: Record<string, number>;
  /** When each service was last asked for, so stale ones can be retired. */
  serviceSeen: Record<string, string>;
  lastSeen: string;
}

export interface LeaseFile {
  version: 2;
  /** project root realpath -> lease */
  projects: Record<string, ProjectLease>;
}

const DEFAULT_RANGE: [number, number] = [40000, 45000];

/** How long a service keeps its port after nothing asks for it. */
const RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** Instance leases belong to a test run, so they are reclaimed far sooner. */
const RETIRE_INSTANCE_AFTER_MS = 6 * 60 * 60 * 1000;

/** A lease key may carry an `#instance` suffix; the directory is the part before it. */
/** Lease key for a project, or for one run against it. */
export const projectLeaseKey = (root: string, instance?: string): string =>
  instance ? `${root}#${instance}` : root;

export const leaseDirectory = (key: string): string => key.split("#")[0]!;
export const isInstanceKey = (key: string): boolean => key.includes("#");
/** How long a lock may be held before another process assumes the holder died. */
const LOCK_STALE_MS = 30_000;

export const leaseHome = (): string => process.env.AUTOPORT_HOME ?? join(homedir(), ".autoport");

const leasePath = (): string => join(leaseHome(), "leases.json");

export const configuredRange = (): [number, number] => {
  const raw = process.env.AUTOPORT_RANGE;
  if (!raw) return DEFAULT_RANGE;
  const [from, to] = raw.split("-").map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from! >= to!) return DEFAULT_RANGE;
  return [from!, to!];
};

const empty = (): LeaseFile => ({ version: 2, projects: {} });

export interface ReadResult {
  file: LeaseFile;
  /** Set when the stored file could not be used and was set aside. */
  recovered?: string;
}

const readLeaseFile = (): ReadResult => {
  const path = leasePath();
  if (!existsSync(path)) return { file: empty() };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { file: empty() };
  }

  try {
    const parsed = JSON.parse(text) as LeaseFile;
    if (parsed?.version === 2 && parsed.projects && typeof parsed.projects === "object") {
      return { file: parsed };
    }
    if ((parsed as { version?: number })?.version === 1) {
      // Version 1 had no per-service timestamps; adopt it rather than discard.
      const upgraded: LeaseFile = { version: 2, projects: {} };
      for (const [key, lease] of Object.entries(
        (parsed as unknown as { projects: Record<string, ProjectLease> }).projects ?? {},
      )) {
        upgraded.projects[key] = {
          name: lease.name,
          services: lease.services ?? {},
          serviceSeen: {},
          lastSeen: lease.lastSeen ?? new Date().toISOString(),
        };
      }
      return { file: upgraded };
    }
  } catch {
    // Fall through to the backup path.
  }

  // Never silently flatten other projects' leases: keep the evidence.
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
  } catch {
    return { file: empty() };
  }
  return { file: empty(), recovered: backup };
};

export const readLeases = (): LeaseFile => readLeaseFile().file;

const writeAtomic = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
};

const writeLeases = (file: LeaseFile): void => {
  writeAtomic(leasePath(), `${JSON.stringify(file, null, 2)}\n`);
};

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

interface LockOwner {
  pid: number;
  host: string;
  at: number;
}

const readLockOwner = (lock: string): LockOwner | undefined => {
  try {
    return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
};

/** Is the process that took this lock still alive on this machine? */
const holderAlive = (owner: LockOwner | undefined): boolean => {
  if (!owner) return true;
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Is this lock abandoned?
 *
 * Judged from the lock's own age and the holder's liveness — never from how long
 * *we* have been waiting. A waiter that simply queued behind several healthy
 * holders must not conclude that the current one has died.
 */
export const lockIsStale = (lock: string): boolean => {
  const owner = readLockOwner(lock);
  if (!holderAlive(owner)) return true;

  const age = (() => {
    if (owner) return Date.now() - owner.at;
    try {
      return Date.now() - statSync(lock).mtimeMs;
    } catch {
      return 0;
    }
  })();
  return age > LOCK_STALE_MS;
};

/** Hold a cross-process lock for the duration of `fn`. */
export const lockPath = (): string => join(leaseHome(), "lock");

export const withLock = <T>(fn: (file: LeaseFile) => { file: LeaseFile; value: T }): T => {
  const dir = leaseHome();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "lock");

  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
      break;
    } catch {
      if (lockIsStale(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      sleep(20 + Math.floor(Math.random() * 30));
    }
  }

  try {
    const result = readLeaseFile();
    const { file, value } = fn(result.file);
    writeLeases(file);
    if (result.recovered) {
      process.emitWarning(
        `autoport: ${leasePath()} was unreadable and has been set aside at ${result.recovered}`,
      );
    }
    return value;
  } finally {
    // Only release a lock we still own, so a stolen lock is not deleted twice.
    const owner = readLockOwner(lock);
    if (!owner || owner.pid === process.pid) rmSync(lock, { recursive: true, force: true });
  }
};

let listeningCache: { ports: Set<number>; at: number } | undefined;

const parseProcfs = (): Set<number> | undefined => {
  const ports = new Set<number>();
  let readAny = false;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    readAny = true;
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      // columns: sl local_address rem_address st ...  ("0A" is TCP_LISTEN)
      if (columns.length < 4 || columns[3] !== "0A") continue;
      const local = columns[1]?.split(":")[1];
      if (local) ports.add(Number.parseInt(local, 16));
    }
  }
  return readAny ? ports : undefined;
};

/** Ports from a command that prints socket state, for platforms without procfs. */
const parseCommand = (): Set<number> | undefined => {
  const attempts: [string, string[], RegExp][] = [
    ["ss", ["-H", "-ltn"], /[:.](\d+)\s/g],
    ["netstat", ["-an"], /^\S+\s+\d+\s+\d+\s+\S*[:.](\d+)\s+\S+\s+LISTEN/gm],
    ["lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], /[:.](\d+)\s*\(LISTEN\)/g],
  ];

  for (const [command, args, pattern] of attempts) {
    let output: string;
    try {
      output = execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
    } catch {
      continue;
    }
    const ports = new Set<number>();
    for (const match of output.matchAll(pattern)) {
      const port = Number(match[1]);
      if (Number.isFinite(port)) ports.add(port);
    }
    return ports;
  }
  return undefined;
};

/**
 * Every port in LISTEN state.
 *
 * procfs where it exists, otherwise one call to whichever socket tool is
 * installed. Doing this once and caching it keeps the cost of scanning a whole
 * range to a single syscall-ish operation rather than one per candidate.
 */
export const listeningPorts = (): Set<number> | undefined => {
  if (listeningCache && Date.now() - listeningCache.at < 1000) return listeningCache.ports;
  const ports = parseProcfs() ?? parseCommand();
  if (!ports) return undefined;
  listeningCache = { ports, at: Date.now() };
  return ports;
};

const bunListen = (): ((options: unknown) => { stop: (closeActive?: boolean) => void }) | undefined =>
  (globalThis as { Bun?: { listen: (options: unknown) => { stop: (closeActive?: boolean) => void } } })
    .Bun?.listen;

/** Is this port free right now? */
export const probeFree = (port: number): boolean => {
  if (listeningPorts()?.has(port)) return false;

  const listen = bunListen();
  if (!listen) return true;
  try {
    listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    }).stop(true);
    return true;
  } catch {
    return false;
  }
};

export interface PortRequest {
  /** `service` for a primary port, `service:role` for a secondary one. */
  name: string;
  canonicalPort: number;
  /** False when the config asks autoport to leave the port alone. */
  managed: boolean;
}

export interface Grant {
  port: number;
  via: "lease" | "allocated" | "pinned";
  /** The port is currently in use by something. */
  occupied?: boolean;
}

export interface AcquireResult {
  grants: Record<string, Grant>;
  name: string;
  warnings: string[];
}

/**
 * Drop leases whose project directory is gone.
 *
 * `existsSync` returning false is not proof: an unmounted share or an
 * unreadable parent looks identical to a deleted directory, so a lease is only
 * dropped once it has also gone unused for a fortnight.
 */
const prune = (file: LeaseFile): void => {
  const now = Date.now();
  for (const [key, lease] of Object.entries(file.projects)) {
    const directory = leaseDirectory(key);
    const age = now - Date.parse(lease.lastSeen || new Date(0).toISOString());

    if (isInstanceKey(key) && age > RETIRE_INSTANCE_AFTER_MS) {
      delete file.projects[key];
      continue;
    }
    if (existsSync(directory)) continue;
    // `existsSync` returning false is not proof: an unmounted share or an
    // unreadable parent looks identical to a deleted directory.
    if (existsSync(dirname(directory)) && age > RETIRE_AFTER_MS) delete file.projects[key];
  }
};

/** Forget services within a project that nothing has asked for in a long time. */
const retireServices = (lease: ProjectLease, asked: Set<string>): void => {
  const now = Date.now();
  for (const service of Object.keys(lease.services)) {
    if (asked.has(service)) continue;
    const seen = Date.parse(lease.serviceSeen[service] ?? lease.lastSeen);
    if (Number.isFinite(seen) && now - seen > RETIRE_AFTER_MS) {
      delete lease.services[service];
      delete lease.serviceSeen[service];
    }
  }
};

export const acquire = (
  key: string,
  nameFor: (taken: (name: string) => boolean) => string,
  requests: PortRequest[],
  range: [number, number] = configuredRange(),
): AcquireResult =>
  withLock((file) => {
    prune(file);

    const warnings: string[] = [];
    const claimedElsewhere = new Map<number, string>();
    for (const [projectKey, lease] of Object.entries(file.projects)) {
      if (projectKey === key) continue;
      for (const port of Object.values(lease.services)) claimedElsewhere.set(port, lease.name);
    }

    const existing = file.projects[key];
    const name =
      existing?.name ??
      nameFor((candidate) => Object.values(file.projects).some((p) => p.name === candidate));

    const services: Record<string, number> = {};
    const serviceSeen: Record<string, string> = {};
    const grants: Record<string, Grant> = {};
    const takenHere = new Set<number>();
    const now = new Date().toISOString();

    const asked = new Set(requests.map((request) => request.name));
    for (const [service, port] of Object.entries(existing?.services ?? {})) {
      if (!asked.has(service)) takenHere.add(port);
    }

    for (const request of requests) {
      if (!request.managed) {
        // A fixed port is the user's choice, but it must not evict a project
        // that legitimately leased it.
        const owner = claimedElsewhere.get(request.canonicalPort);
        if (owner) {
          warnings.push(
            `"${request.name}" is fixed to ${request.canonicalPort}, which is leased to ${owner} — they will collide`,
          );
        }
        services[request.name] = request.canonicalPort;
        serviceSeen[request.name] = now;
        grants[request.name] = {
          port: request.canonicalPort,
          via: "pinned",
          occupied: !probeFree(request.canonicalPort),
        };
        takenHere.add(request.canonicalPort);
        continue;
      }

      const held = existing?.services[request.name];
      if (held !== undefined && !claimedElsewhere.has(held) && !takenHere.has(held)) {
        services[request.name] = held;
        serviceSeen[request.name] = now;
        // A held port that is busy is usually this project's own service still
        // running, so it is reported rather than reallocated.
        grants[request.name] = { port: held, via: "lease", occupied: !probeFree(held) };
        takenHere.add(held);
        continue;
      }

      const port = allocate(range, request.canonicalPort, claimedElsewhere, takenHere);
      services[request.name] = port;
      serviceSeen[request.name] = now;
      grants[request.name] = { port, via: "allocated" };
      takenHere.add(port);
    }

    // Keep ports held for services this call did not ask about. In a monorepo
    // `apps/web` and `apps/api` resolve separately against the same stack, and
    // neither should evict the other's dev-server port.
    const kept: Record<string, number> = {};
    const keptSeen: Record<string, string> = {};
    for (const [service, port] of Object.entries(existing?.services ?? {})) {
      if (asked.has(service) || claimedElsewhere.has(port)) continue;
      kept[service] = port;
      keptSeen[service] = existing?.serviceSeen[service] ?? existing?.lastSeen ?? now;
    }

    const lease: ProjectLease = {
      name,
      services: { ...kept, ...services },
      serviceSeen: { ...keptSeen, ...serviceSeen },
      lastSeen: now,
    };
    retireServices(lease, asked);
    file.projects[key] = lease;

    return { file, value: { grants, name, warnings } };
  });

const allocate = (
  range: [number, number],
  canonical: number,
  claimedElsewhere: Map<number, string>,
  takenHere: Set<number>,
): number => {
  const [from, to] = range;
  const usable = (port: number): boolean =>
    port > 0 && !claimedElsewhere.has(port) && !takenHere.has(port) && probeFree(port);

  if (usable(canonical)) return canonical;
  for (let port = from; port <= to; port++) {
    if (usable(port)) return port;
  }
  throw new Error(
    `autoport: no free port in range ${from}-${to}. Run "autoport status" to see what is leased, or set AUTOPORT_RANGE.`,
  );
};

export const release = (key: string): boolean =>
  withLock((file) => {
    const had = key in file.projects;
    delete file.projects[key];
    return { file, value: had };
  });

export const releaseAll = (): string[] =>
  withLock((file) => {
    const names = Object.values(file.projects).map((lease) => lease.name);
    file.projects = {};
    return { file, value: names };
  });

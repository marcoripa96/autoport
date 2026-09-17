import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AutoportConfig } from "./config.ts";
import { findComposeFiles } from "./compose.ts";
import { detectDotenvConflicts } from "./conflicts.ts";
import { APP_ENV_FILES } from "./dotenv.ts";
import { inferServices } from "./infer.ts";
import { acquire, configuredRange, leaseHome, readLeases, type PortRequest } from "./leases.ts";
import { findProject, projectName, type ProjectLayout } from "./project.ts";
import { renderResources, urlFor } from "./render.ts";
import { currentInstance } from "./session.ts";
import { renderTypes, TYPES_FILE } from "./typegen.ts";
import type {
  ResolvedPort,
  ResolvedProject,
  ResolvedService,
  ServiceSpec,
  Warning,
} from "./types.ts";

export const CACHE_DIR = ".autoport";

export const CONFIG_FILES = [
  "autoport.config.ts",
  "autoport.config.mts",
  "autoport.config.js",
  "autoport.config.mjs",
  "autoport.config.json",
];

type Fingerprint = Record<string, number | string>;

interface Cached extends ResolvedProject {
  fingerprint: Fingerprint;
  /** True when a config file contributed; the sync path cannot reproduce it. */
  configApplied: boolean;
  /** Keys whose value came from a project dotenv file. */
  fileSourced: Record<string, { file: string; value: string }>;
}

/** Inputs whose change means the answer may have changed. */
const fingerprint = (layout: ProjectLayout): Fingerprint => {
  const out: Fingerprint = {};
  const stamp = (path: string, label: string): void => {
    try {
      out[label] = statSync(path).mtimeMs;
    } catch {
      // Absent files simply do not appear, and `same` treats that as a change.
    }
  };

  for (const file of findComposeFiles(layout.root)) stamp(file, `compose:${file}`);
  for (const file of CONFIG_FILES) stamp(join(layout.root, file), file);
  stamp(join(layout.root, ".env"), "root/.env");
  if (layout.appDir) {
    stamp(join(layout.appDir, "package.json"), "app/package.json");
    for (const file of APP_ENV_FILES) stamp(join(layout.appDir, file), `app/${file}`);
  }

  // The lease file is an input too: a release elsewhere invalidates our answer.
  stamp(join(leaseHome(), "leases.json"), "leases");
  out.home = leaseHome();
  out.range = configuredRange().join("-");
  out.instance = process.env.AUTOPORT_INSTANCE ?? "";
  return out;
};

const same = (a: Fingerprint, b: Fingerprint): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};

export const findConfigFile = (root: string): string | undefined =>
  CONFIG_FILES.map((name) => join(root, name)).find((path) => existsSync(path));

const applyOverrides = (specs: ServiceSpec[], config?: AutoportConfig): ServiceSpec[] => {
  if (!config?.services) return specs;
  const known = new Set(specs.map((spec) => spec.name));
  const merged = specs.map((spec) => {
    const override = config.services?.[spec.name];
    if (!override) return spec;
    return {
      ...spec,
      type: override.type ?? spec.type,
      http: override.http ?? spec.http,
      app: override.app ?? spec.app,
      containerPort: override.containerPort ?? spec.containerPort,
      canonicalPort: override.canonicalPort ?? spec.canonicalPort,
      managed: override.fixed ? false : spec.managed,
      source: `${spec.source} + autoport.config`,
    };
  });

  for (const [name, override] of Object.entries(config.services)) {
    if (known.has(name)) continue;
    merged.push({
      name,
      type: override.type ?? "unknown",
      containerPort: override.containerPort,
      canonicalPort: override.canonicalPort ?? override.containerPort ?? 0,
      http: override.http ?? false,
      app: override.app ?? false,
      extraPorts: [],
      managed: !override.fixed,
      meta: {},
      command: [],
      protocol: "tcp",
      source: "autoport.config",
    });
  }

  return merged;
};

export interface ResolveOptions {
  /** Directory to resolve from. Defaults to the cwd. */
  cwd?: string;
  layout?: ProjectLayout;
  config?: AutoportConfig;
  /** Extra ports requested by name, from `reservePort`. */
  reservations?: string[];
}

const leaseKeyFor = (service: string, role?: string): string =>
  role === undefined ? service : `${service}:${role}`;

/** Infer, allocate, render, cache. */
export const resolveProject = (options: ResolveOptions = {}): ResolvedProject => {
  const layout = options.layout ?? findProject(options.cwd);
  const { root } = layout;
  const appDir = layout.appDir ?? root;
  const config = options.config;

  const inference = inferServices(layout);
  const specs = applyOverrides(inference.services, config);
  const warnings: Warning[] = [...inference.warnings];

  // A parallel run can ask for its own set of ports without disturbing the dev
  // server that is already using this project's — named by the user, or minted
  // by an outer autoport and inherited through the environment.
  const instance = currentInstance();

  // The canonical port belongs to the project's own set, so an extra run does
  // not try 5432 first: a solo project should still land there, and a second
  // run of it should not take it away from the first the moment the first is
  // stopped.
  const preferred = (port: number): number => (instance ? 0 : port);

  const requests: PortRequest[] = [];
  for (const spec of specs) {
    if (spec.canonicalPort > 0) {
      requests.push({
        name: spec.name,
        canonicalPort: preferred(spec.canonicalPort),
        managed: spec.managed,
      });
    }
    for (const extra of spec.extraPorts) {
      requests.push({
        name: leaseKeyFor(spec.name, extra.role),
        canonicalPort: preferred(extra.canonicalPort),
        managed: spec.managed,
      });
    }
  }
  for (const reservation of options.reservations ?? []) {
    if (!requests.some((request) => request.name === reservation)) {
      requests.push({ name: reservation, canonicalPort: 0, managed: true });
    }
  }

  const leaseKey = instance ? `${root}#${instance}` : root;

  const acquired = acquire(
    leaseKey,
    (taken) =>
      instance
        ? `${config?.name ?? projectName(root, () => false)}#${instance}`
        : (config?.name ?? projectName(root, taken)),
    requests,
    config?.range,
  );
  for (const message of acquired.warnings) warnings.push({ code: "lease", message });

  const services: Record<string, ResolvedService> = {};
  for (const spec of specs) {
    const grant = acquired.grants[spec.name];
    if (!grant) {
      warnings.push({
        code: "service-skipped",
        message: `service "${spec.name}" has no usable port and was skipped`,
      });
      continue;
    }

    const extras: Record<string, ResolvedPort> = {};
    for (const extra of spec.extraPorts) {
      const extraGrant = acquired.grants[leaseKeyFor(spec.name, extra.role)];
      if (!extraGrant) continue;
      extras[extra.role!] = {
        role: extra.role!,
        port: extraGrant.port,
        containerPort: extra.containerPort,
        http: extra.http,
        url: extra.http
          ? `http://127.0.0.1:${extraGrant.port}`
          : `${extra.protocol}://127.0.0.1:${extraGrant.port}`,
      };
    }

    const base: ResolvedService = {
      ...spec,
      port: grant.port,
      via: grant.via,
      occupied: grant.occupied,
      extras,
      url: "",
    };
    base.url = config?.services?.[spec.name]?.url?.(base) ?? urlFor(spec, grant.port);
    services[spec.name] = base;

    if (spec.pinnedInFile && grant.port !== spec.canonicalPort) {
      warnings.push({
        code: "port-moved",
        message: `"${spec.name}" is published on ${spec.canonicalPort} in compose, but that port was taken — using ${grant.port}`,
      });
    }
    if (grant.occupied && grant.via === "lease") {
      warnings.push({
        code: "lease-occupied",
        message: `"${spec.name}" holds ${grant.port}, which is currently in use — expected if it is already running, otherwise run "autoport release"`,
      });
    }
  }

  const rendered = renderResources(services);
  warnings.push(...rendered.warnings);

  const resources = rendered.resources;
  const provenance = { ...rendered.provenance };
  for (const [name, port] of Object.entries(acquired.grants)) {
    if (name.includes(":") || name in services) continue;
    resources[`${name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_PORT`] = port.port;
  }

  for (const [key, value] of Object.entries(config?.resources?.(services) ?? {})) {
    resources[key] = value;
    provenance[key] = "autoport.config";
  }

  const conflicts = detectDotenvConflicts(appDir, resources);
  warnings.push(...conflicts.warnings);

  const project: ResolvedProject = {
    version: 2,
    key: root,
    appDir,
    name: acquired.name,
    sources: inference.sources,
    resolvedAt: new Date().toISOString(),
    services,
    resources,
    provenance,
    warnings,
  };

  writeCache(project, layout, config !== undefined, conflicts.fileSourced);
  syncTypes(project);
  return project;
};

/**
 * Where a resolution is cached.
 *
 * Named per instance, because two concurrent runs of one directory each hold
 * their own set of ports and would otherwise fight over a single file — the
 * lease check below would reject the loser's cache every time, turning the
 * cache into overhead for both.
 */
export const cachePath = (appDir: string, instance = currentInstance()): string =>
  join(appDir, CACHE_DIR, instance ? `resolved.${instance}.json` : "resolved.json");

const writeCache = (
  project: ResolvedProject,
  layout: ProjectLayout,
  configApplied: boolean,
  fileSourced: Cached["fileSourced"],
): void => {
  try {
    const dir = join(project.appDir, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    const payload: Cached = {
      ...project,
      fingerprint: fingerprint(layout),
      configApplied,
      fileSourced,
    };
    const path = cachePath(project.appDir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, path);
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  } catch {
    // A read-only checkout still works, it just re-resolves every time.
  }
};

/**
 * Keep `autoport-env.d.ts` in step with reality, as a side effect of resolving.
 *
 * Types that need a command to be remembered are types that are wrong.
 */
const syncTypes = (project: ResolvedProject): void => {
  if (process.env.AUTOPORT_TYPEGEN === "0") return;
  if (process.env.NODE_ENV === "production") return;
  if (!existsSync(join(project.appDir, "package.json"))) return;

  try {
    const path = join(project.appDir, TYPES_FILE);
    const next = renderTypes(project);
    if (existsSync(path) && readFileSync(path, "utf8") === next) return;
    writeFileSync(path, next);
    ensureGitignored(project.appDir);
  } catch {
    // Types are a convenience; never fail a resolve over them.
  }
};

/** Generated files should not show up as uncommitted work. */
const ensureGitignored = (appDir: string): void => {
  const path = join(appDir, ".gitignore");
  const line = `/${TYPES_FILE}`;
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split(/\r?\n/).some((entry) => entry.trim() === line || entry.trim() === TYPES_FILE)) {
      return;
    }
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(path, `${current}${prefix}${line}\n`);
  } catch {
    // Not every project has a git repo to ignore things in.
  }
};

export interface CacheRead {
  project: ResolvedProject;
  configApplied: boolean;
  fileSourced: Cached["fileSourced"];
}

/**
 * Read the cache, rejecting it unless the leases still say what it says.
 *
 * Mtimes alone are not enough: `autoport release` in another terminal leaves
 * every input file untouched while making the cached ports wrong.
 */
export const readCache = (layout: ProjectLayout): CacheRead | undefined => {
  const path = cachePath(layout.appDir ?? layout.root);
  if (!existsSync(path)) return undefined;

  let parsed: Cached;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Cached;
  } catch {
    return undefined;
  }
  if (parsed?.version !== 2) return undefined;
  if (!same(parsed.fingerprint ?? {}, fingerprint(layout))) return undefined;

  const instance = currentInstance();
  const lease = readLeases().projects[instance ? `${layout.root}#${instance}` : layout.root];
  if (!lease) return undefined;
  for (const service of Object.values(parsed.services ?? {})) {
    if (lease.services[service.name] !== service.port) return undefined;
    for (const extra of Object.values(service.extras ?? {})) {
      if (lease.services[`${service.name}:${extra.role}`] !== extra.port) return undefined;
    }
  }

  return { project: parsed, configApplied: parsed.configApplied, fileSourced: parsed.fileSourced ?? {} };
};

/**
 * The synchronous path used by the library.
 *
 * Prefers the cache. A fresh resolve keeps `tsx script.ts` working with no
 * prior CLI call, at the cost of ignoring a TypeScript config, which cannot be
 * imported synchronously — so that case is reported rather than silently
 * dropping the keys the config would have added.
 */
export const resolveSync = (cwd?: string): { project: ResolvedProject; fileSourced: Cached["fileSourced"] } => {
  const layout = findProject(cwd);
  const cached = readCache(layout);
  if (cached) return { project: cached.project, fileSourced: cached.fileSourced };

  const configFile = findConfigFile(layout.root);
  const needsCli = configFile !== undefined && !configFile.endsWith(".json");

  const project = resolveProject({ layout });
  if (needsCli) {
    project.warnings.push({
      code: "config-not-applied",
      message: `${basename(configFile!)} could not be applied from a plain import — any keys it adds are missing until an autoport command runs`,
    });
  }
  const conflicts = detectDotenvConflicts(project.appDir, project.resources);
  return { project, fileSourced: conflicts.fileSourced };
};

export interface Inspection {
  layout: ProjectLayout;
  name: string;
  specs: ServiceSpec[];
  /** Ports currently leased for this project, including retired services. */
  leased: Record<string, number>;
  sources: string[];
  warnings: Warning[];
}

/**
 * Describe the project without allocating anything.
 *
 * Listing has to be read-only: running `autoport status` in a directory should
 * never be the thing that creates a lease.
 */
export const inspectProject = (layout: ProjectLayout, config?: AutoportConfig): Inspection => {
  const inference = inferServices(layout);
  const lease = readLeases().projects[layout.root];
  return {
    layout,
    name: lease?.name ?? config?.name ?? basename(layout.root),
    specs: applyOverrides(inference.services, config),
    leased: lease?.services ?? {},
    sources: inference.sources,
    warnings: inference.warnings,
  };
};

import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import { parse } from "yaml";
import { lookupImage, type CatalogEntry } from "./catalog.ts";
import { readDotenv } from "./dotenv.ts";
import { interpolateDeep } from "./interpolate.ts";
import type { PortSpec, ServiceSpec, Warning } from "./types.ts";

const BASE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const OVERRIDE_FILES = [
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
  "compose.override.yml",
  "compose.override.yaml",
];

export const findComposeFile = (root: string): string | undefined =>
  BASE_FILES.map((name) => join(root, name)).find((path) => existsSync(path));

/**
 * Every compose file docker would read, in order.
 *
 * `COMPOSE_FILE` wins outright when set, matching docker's own behaviour;
 * otherwise the base file plus its override, which is the idiom people use to
 * keep local-only services out of the committed file.
 */
export const findComposeFiles = (root: string): string[] => {
  const fromEnv = process.env.COMPOSE_FILE;
  if (fromEnv) {
    const separator = process.env.COMPOSE_PATH_SEPARATOR ?? delimiter;
    return fromEnv
      .split(separator)
      .filter(Boolean)
      .map((file) => (isAbsolute(file) ? file : resolvePath(root, file)))
      .filter((file) => existsSync(file));
  }

  const base = findComposeFile(root);
  if (!base) return [];
  const override = OVERRIDE_FILES.map((name) => join(root, name)).find((path) => existsSync(path));
  return override ? [base, override] : [base];
};

/** compose accepts both `KEY: value` maps and `- KEY=value` lists. */
const normalizeEnvironment = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      // `- KEY` with no value means "take it from the host environment".
      if (eq === -1) {
        const inherited = process.env[item];
        if (inherited !== undefined) out[item] = inherited;
        continue;
      }
      out[item.slice(0, eq)] = item.slice(eq + 1);
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value != null) out[key] = String(value);
    }
  }
  return out;
};

/** `env_file:` accepts a string, a list of strings, or a list of `{path, required}`. */
const envFilePaths = (raw: unknown): string[] => {
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return (item as { path?: string }).path;
      return undefined;
    })
    .filter((item): item is string => typeof item === "string");
};

const splitCommand = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquote) ?? [];
  return [];
};

const unquote = (value: string): string =>
  (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;

interface PortMapping {
  host?: number;
  container: number;
  protocol: "tcp" | "udp";
}

/** Understands "5432", "5432:5432", "127.0.0.1:5432:5432/udp" and the long form. */
const parsePortEntry = (entry: unknown): PortMapping | undefined => {
  if (typeof entry === "number") return { container: entry, protocol: "tcp" };
  if (entry && typeof entry === "object") {
    const target = (entry as { target?: number }).target;
    const published = (entry as { published?: number | string }).published;
    const protocol = ((entry as { protocol?: string }).protocol ?? "tcp") as "tcp" | "udp";
    if (typeof target !== "number") return undefined;
    const host = published === undefined ? undefined : Number(published);
    return { container: target, host: Number.isFinite(host) ? host : undefined, protocol };
  }
  if (typeof entry !== "string") return undefined;

  const [addresses, rawProtocol] = entry.split("/");
  const protocol = rawProtocol === "udp" ? "udp" : "tcp";
  const parts = addresses!.split(":");
  const container = Number(parts[parts.length - 1]);
  if (!Number.isFinite(container)) return undefined;
  if (parts.length === 1) return { container, protocol };
  const host = Number(parts[parts.length - 2]);
  return { container, host: Number.isFinite(host) ? host : undefined, protocol };
};

type ServiceDefinition = Record<string, unknown>;

/** Merge compose files the way docker does: maps merge, these lists concatenate. */
const CONCATENATED = new Set(["ports", "expose", "env_file", "dns", "dns_search", "tmpfs"]);

const mergeService = (base: ServiceDefinition, next: ServiceDefinition): ServiceDefinition => {
  const out: ServiceDefinition = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const existing = out[key];
    if (CONCATENATED.has(key) && Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...existing, ...value];
    } else if (
      key === "environment" &&
      existing &&
      typeof existing === "object" &&
      value &&
      typeof value === "object"
    ) {
      out[key] = { ...normalizeEnvironment(existing), ...normalizeEnvironment(value) };
    } else {
      out[key] = value;
    }
  }
  return out;
};

export interface ComposeDocument {
  files: string[];
  services: Record<string, ServiceDefinition>;
  warnings: Warning[];
}

/**
 * Read the project's compose files and resolve `${VAR}` against the same sources
 * docker uses: the project `.env` file, then the process environment.
 */
export const readComposeDocument = (root: string): ComposeDocument | undefined => {
  const files = findComposeFiles(root);
  if (files.length === 0) return undefined;

  const warnings: Warning[] = [];
  const lookup: Record<string, string | undefined> = {
    ...readDotenv(join(root, ".env")),
    ...process.env,
  };

  let services: Record<string, ServiceDefinition> = {};
  for (const file of files) {
    let document: unknown;
    try {
      document = parse(readFileSync(file, "utf8"));
    } catch (error) {
      warnings.push({
        code: "compose-parse",
        message: `could not parse ${file}: ${(error as Error).message}`,
      });
      continue;
    }

    const missing = new Set<string>();
    const interpolated = interpolateDeep(document, lookup, missing);
    if (missing.size > 0) {
      warnings.push({
        code: "compose-unset-variable",
        message: `${relativeTo(root, file)} refers to unset ${[...missing].sort().join(", ")} — those values will be empty`,
      });
    }

    const raw = (interpolated as { services?: Record<string, unknown> } | null)?.services;
    if (!raw || typeof raw !== "object") continue;
    for (const [name, definition] of Object.entries(raw)) {
      if (!definition || typeof definition !== "object") continue;
      const previous = services[name];
      services[name] = previous
        ? mergeService(previous, definition as ServiceDefinition)
        : (definition as ServiceDefinition);
    }
  }

  return { files, services, warnings };
};

const relativeTo = (root: string, file: string): string =>
  file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;

/** Environment of a service: `env_file` first, then inline `environment`. */
const serviceEnvironment = (root: string, definition: ServiceDefinition): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const file of envFilePaths(definition.env_file)) {
    Object.assign(out, readDotenv(isAbsolute(file) ? file : join(root, file)));
  }
  Object.assign(out, normalizeEnvironment(definition.environment));
  return out;
};

const secretFileKeys = (meta: Record<string, string>): string[] =>
  Object.keys(meta).filter((key) => key.endsWith("_FILE"));

export interface ComposeInference {
  files: string[];
  services: ServiceSpec[];
  warnings: Warning[];
}

/**
 * Turn compose services into port specs.
 *
 * Everything the catalog knows — container port, secondary ports, protocol —
 * is applied here so that the rest of the pipeline only deals in ports.
 */
export const inferFromCompose = (root: string): ComposeInference | undefined => {
  const document = readComposeDocument(root);
  if (!document) return undefined;

  const warnings = [...document.warnings];
  const services: ServiceSpec[] = [];
  const label = document.files.map((file) => relativeTo(root, file)).join(" + ");

  for (const [name, definition] of Object.entries(document.services)) {
    const image = typeof definition.image === "string" ? definition.image : undefined;
    const build = definition.build !== undefined;
    const entry = image ? lookupImage(image) : undefined;
    const meta = serviceEnvironment(root, definition);
    const command = splitCommand(definition.command);

    const mappings = Array.isArray(definition.ports)
      ? definition.ports.map(parsePortEntry).filter((m): m is PortMapping => m !== undefined)
      : [];
    const exposed = Array.isArray(definition.expose)
      ? definition.expose.map((e) => Number(String(e).split("/")[0])).filter(Number.isFinite)
      : [];

    const fromCommand = entry?.portFromCommand?.(command);
    const containerPort = fromCommand ?? entry?.port ?? mappings[0]?.container ?? exposed[0];
    if (containerPort === undefined) {
      warnings.push({
        code: "service-no-port",
        message: `${label}: service "${name}" exposes no port and is not in the catalog — skipped`,
      });
      continue;
    }

    if (fromCommand !== undefined && entry && fromCommand !== entry.port) {
      warnings.push({
        code: "port-from-command",
        message: `${label}: service "${name}" is configured for port ${fromCommand} by its command:`,
      });
    }

    const primary = mappings.find((m) => m.container === containerPort);
    const primaryProtocol = primary?.protocol ?? "tcp";
    const extraPorts = collectExtraPorts(entry, mappings, exposed, containerPort, primaryProtocol);

    services.push({
      name,
      type: entry?.type ?? "unknown",
      containerPort,
      canonicalPort: primary?.host ?? containerPort,
      http: entry?.http ?? false,
      // A datastore's HTTP console is not the project's application.
      app: false,
      extraPorts,
      managed: true,
      pinnedInFile: primary?.host !== undefined,
      meta,
      command,
      protocol: primaryProtocol,
      source: `${label}:services.${name}${image ? ` (${image})` : build ? " (build)" : ""}`,
    });

    if (!entry) {
      warnings.push({
        code: "image-not-in-catalog",
        message: image
          ? `${label}: image "${image}" is not in the catalog — using port ${containerPort} and a generic URL`
          : `${label}: service "${name}" is built from source — using port ${containerPort} and a generic URL`,
      });
    }
    const secrets = secretFileKeys(meta);
    if (secrets.length > 0) {
      warnings.push({
        code: "secret-file",
        message: `${label}: service "${name}" reads ${secrets.join(", ")} from a file — autoport cannot see that value`,
      });
    }
  }

  return { files: document.files, services, warnings };
};

/**
 * Secondary ports, from the catalog and from anything else the file publishes.
 *
 * A service that publishes two ports needs two leases; leasing only the first
 * leaves the second colliding between checkouts.
 */
const collectExtraPorts = (
  entry: CatalogEntry | undefined,
  mappings: PortMapping[],
  exposed: number[],
  containerPort: number,
  primaryProtocol: "tcp" | "udp",
): PortSpec[] => {
  // Keyed by protocol as well as number: a service publishing both tcp and udp
  // on 3478 needs two leases, not one that swallows the other.
  const key = (port: number, protocol: string): string => `${port}/${protocol}`;
  const seen = new Set<string>([key(containerPort, primaryProtocol)]);
  const extras: PortSpec[] = [];

  for (const extra of entry?.extraPorts ?? []) {
    if (seen.has(key(extra.port, "tcp"))) continue;
    seen.add(key(extra.port, "tcp"));
    const mapping = mappings.find((m) => m.container === extra.port);
    extras.push({
      role: extra.role,
      containerPort: extra.port,
      canonicalPort: mapping?.host ?? extra.port,
      http: extra.http ?? false,
      pinnedInFile: mapping?.host !== undefined,
      protocol: mapping?.protocol ?? "tcp",
    });
  }

  for (const mapping of [
    ...mappings,
    ...exposed.map((port) => ({ container: port, host: undefined, protocol: "tcp" as const })),
  ]) {
    if (seen.has(key(mapping.container, mapping.protocol))) continue;
    seen.add(key(mapping.container, mapping.protocol));
    extras.push({
      role: mapping.protocol === "udp" ? `${mapping.container}-udp` : String(mapping.container),
      containerPort: mapping.container,
      canonicalPort: mapping.host ?? mapping.container,
      http: false,
      pinnedInFile: mapping.host !== undefined,
      protocol: mapping.protocol,
    });
  }

  return extras;
};

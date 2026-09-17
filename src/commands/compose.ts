import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { findComposeFiles } from "../compose.ts";
import { loadConfig } from "../config-loader.ts";
import { findProject, safeLabel } from "../project.ts";
import { CACHE_DIR, resolveProject } from "../resolve.ts";
import type { ResolvedProject } from "../types.ts";
import { exec } from "./run.ts";
import { printWarnings } from "./output.ts";

const execFile = promisify(execFileCallback);

export const GENERATED_FILE = "compose.yml";

interface ComposeModel {
  name?: string;
  services?: Record<string, { ports?: unknown[] }>;
  [key: string]: unknown;
}

/**
 * Ask docker for the fully resolved model rather than re-reading the YAML.
 *
 * `COMPOSE_PROJECT_NAME` has to be set for this call, not just written into the
 * result: docker expands volume and network names from the project name *during*
 * resolution, so renaming the project afterwards would rename the containers and
 * leave two checkouts sharing one `shop_pgdata` volume and one `shop_default`
 * network — which means sharing a database.
 */
const dockerConfig = async (
  files: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ComposeModel> => {
  const args = ["compose", "--project-directory", cwd];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");

  const { stdout } = await execFile("docker", args, {
    cwd,
    env,
    maxBuffer: 32 * 1024 * 1024,
  }).catch((error: { stderr?: string; message: string }) => {
    throw new Error(`docker compose config failed:\n${(error.stderr ?? error.message).trim()}`);
  });
  return JSON.parse(stdout) as ComposeModel;
};

interface PortEntry {
  target?: number;
  published?: string | number;
  host_ip?: string;
  protocol?: string;
  mode?: string;
}

/**
 * Replace published host ports with the leased ones.
 *
 * Rewriting the whole model, rather than layering an override file, is what lets
 * this work at all: compose *concatenates* `ports` across files, so an override
 * would publish the leased port in addition to the one already written down —
 * and the one already written down is the one that collides.
 */
export const applyPorts = (
  model: ComposeModel,
  project: ResolvedProject,
): { model: ComposeModel; warnings: string[] } => {
  const warnings: string[] = [];
  const services = model.services ?? {};

  for (const [name, definition] of Object.entries(services)) {
    const service = project.services[name];
    if (!service || !service.managed) continue;

    // Every port this service publishes, primary and secondary, each with its
    // own lease. Leasing only the first leaves the rest colliding.
    const leased = new Map<number, { port: number; protocol: string }>();
    if (service.containerPort !== undefined) {
      leased.set(service.containerPort, { port: service.port, protocol: service.protocol });
    }
    for (const extra of Object.values(service.extras)) {
      leased.set(extra.containerPort, { port: extra.port, protocol: "tcp" });
    }

    const entries = (definition.ports ?? []) as PortEntry[];
    const rewritten: PortEntry[] = [];
    const placed = new Set<number>();

    for (const entry of entries) {
      const protocol = entry.protocol ?? "tcp";
      const match = entry.target === undefined ? undefined : leased.get(entry.target);
      // Protocol matters: a service publishing both tcp and udp on one number
      // must keep both entries, not have one silently swallow the other.
      if (match && protocol === match.protocol && !placed.has(entry.target!)) {
        placed.add(entry.target!);
        rewritten.push({ ...entry, host_ip: "127.0.0.1", published: String(match.port) });
        continue;
      }
      if (match && protocol !== match.protocol) {
        rewritten.push({ ...entry, host_ip: "127.0.0.1", published: String(match.port) });
        continue;
      }
      rewritten.push(entry);
      if (entry.published !== undefined) {
        warnings.push(
          `${name}: port ${entry.published}->${entry.target}/${protocol} is published outside autoport and may still collide`,
        );
      }
    }

    for (const [containerPort, { port, protocol }] of leased) {
      if (placed.has(containerPort)) continue;
      rewritten.push({
        target: containerPort,
        published: String(port),
        host_ip: "127.0.0.1",
        protocol,
        mode: "ingress",
      });
    }

    definition.ports = rewritten;
  }

  model.name = project.name;
  return { model, warnings };
};

export const writeGenerated = (project: ResolvedProject, model: ComposeModel): string => {
  const dir = join(project.key, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const path = join(dir, GENERATED_FILE);
  writeFileSync(
    path,
    `# Generated by autoport from your compose file. Do not edit.\n${stringify(model)}`,
  );
  return path;
};

const USAGE = `usage: autoport compose [docker compose args...]

Runs docker compose against a generated copy of your compose file with the
leased host ports. With no arguments, prints what it would generate.
`;

export const composeCommand = async (args: string[]): Promise<number> => {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const layout = findProject();
  const files = findComposeFiles(layout.root);
  if (files.length === 0) {
    process.stderr.write("autoport: no docker-compose file found\n");
    return 1;
  }

  const config = await loadConfig(layout.root);
  const project = resolveProject({ layout, config, reservations: config?.reserve });
  printWarnings(project.warnings);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(project.resources)) {
    if (env[key] === undefined || env[key] === "") env[key] = String(value);
  }
  // Set before resolution so volumes and networks are namespaced too. Docker
  // only accepts [a-z0-9_-], and an instance name arrives as `shop#e2e`, so the
  // name is flattened rather than passed through — a run's containers and
  // volumes are its own, which is most of what makes a second run independent.
  env.COMPOSE_PROJECT_NAME = safeLabel(project.name);

  let model: ComposeModel;
  try {
    model = await dockerConfig(files, layout.root, env);
  } catch (error) {
    process.stderr.write(`autoport: ${(error as Error).message}\n`);
    return 1;
  }

  const { model: patched, warnings } = applyPorts(model, project);
  for (const warning of warnings) process.stderr.write(`autoport: ${warning}\n`);
  const generated = writeGenerated(project, patched);

  if (args.length === 0) {
    process.stdout.write(`${relative(process.cwd(), generated)}\n`);
    process.stdout.write(`project name: ${project.name}\n`);
    for (const service of Object.values(project.services)) {
      if (service.containerPort === undefined) continue;
      process.stdout.write(
        `  ${service.name}  127.0.0.1:${service.port} -> ${service.containerPort}\n`,
      );
      for (const extra of Object.values(service.extras)) {
        process.stdout.write(
          `  ${service.name} (${extra.role})  127.0.0.1:${extra.port} -> ${extra.containerPort}\n`,
        );
      }
    }
    return 0;
  }

  return await exec(
    ["docker", "compose", "--project-directory", layout.root, "-f", generated, ...args],
    env,
    layout.root,
  );
};

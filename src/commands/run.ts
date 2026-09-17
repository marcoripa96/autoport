import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { findFrameworkByType, flagValue, type FrameworkEntry } from "../catalog.ts";
import type { AutoportConfig } from "../config.ts";
import { loadConfig } from "../config-loader.ts";
import { detectDotenvConflicts } from "../conflicts.ts";
import { findProject, safeLabel } from "../project.ts";
import { probeFree, projectLeaseKey, release } from "../leases.ts";
import { findAppService, portKey } from "../render.ts";
import { cachePath, resolveProject } from "../resolve.ts";
import { inRun, isAnonymousRun, mintRun } from "../session.ts";
import type { ResolvedProject } from "../types.ts";
import { which } from "../which.ts";
import { defaultCommand } from "./dev.ts";
import { printWarnings } from "./output.ts";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx"]);

/** `defaultCommand` resolves the manager to an absolute path, so compare names. */
const basenameOf = (command: string): string => command.split("/").pop() ?? command;

const scriptBody = (appDir: string, argv: string[]): string | undefined => {
  const [manager, ...rest] = argv;
  if (!manager || !PACKAGE_MANAGERS.has(basenameOf(manager))) return undefined;
  const script = rest.find((arg) => arg !== "run" && !arg.startsWith("-"));
  if (!script) return undefined;
  const path = join(appDir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts?.[script];
  } catch {
    return undefined;
  }
};

/** Whole-word match, so `vitest` is never mistaken for `vite`. */
const mentions = (text: string, binary: string): boolean =>
  new RegExp(`(^|[\\s/"'=])${binary}([\\s"']|$)`).test(text);

interface PortFlagPlan {
  argv: string[];
  note?: string;
}

/**
 * Get the leased port into the dev server.
 *
 * Three cases have to be handled together: servers that read `$PORT`, servers
 * that only take a flag, and — the one that quietly defeats everything — a dev
 * script with a port already written into it, which is exactly what a developer
 * adds after their first port conflict.
 */
const withPortFlag = (
  appDir: string,
  argv: string[],
  project: ResolvedProject,
): PortFlagPlan => {
  const app = findAppService(project.services);
  if (!app) return { argv };
  const framework = findFrameworkByType(app.type);
  if (!framework) return { argv };

  // A flag the user passed on the command line is deliberate; leave it alone.
  if (framework.pinFlags?.some((flag) => argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)))) {
    return { argv, note: `command line already fixes a port; leaving it alone` };
  }

  const body = scriptBody(appDir, argv);
  const pinnedInScript = body
    ? flagValue(splitScript(body), ...(framework.pinFlags ?? []))
    : undefined;

  const direct = argv.some((arg) => framework.binaries.includes(arg.split("/").pop() ?? arg));
  const viaScript = body ? framework.binaries.some((binary) => mentions(body, binary)) : false;
  if (!direct && !viaScript) {
    return pinnedInScript
      ? { argv, note: `dev script fixes port ${pinnedInScript} and autoport cannot override it` }
      : { argv };
  }

  if (!framework.portFlag) {
    return pinnedInScript
      ? { argv, note: `dev script fixes port ${pinnedInScript} and ${framework.type} has no flag to override it` }
      : { argv };
  }

  const manager = basenameOf(argv[0] ?? "");
  const separator = viaScript && (manager === "npm" || manager === "yarn") ? ["--"] : [];
  const next = [...argv, ...separator, framework.portFlag, String(app.port)];
  return {
    argv: next,
    note: pinnedInScript
      ? `dev script fixes port ${pinnedInScript}; appended ${framework.portFlag} ${app.port} to override it`
      : framework.needsPortFlag
        ? `appended ${framework.portFlag} ${app.port} (this dev server ignores $PORT)`
        : undefined,
  };
};

const splitScript = (body: string): string[] =>
  body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];

/**
 * Put the command behind a local HTTPS proxy so the app has a stable hostname.
 *
 * autoport does not run a proxy of its own; it drives portless when portless is
 * installed, so the whole thing stays one command.
 */
const withProxy = (
  argv: string[],
  project: ResolvedProject,
  env: NodeJS.ProcessEnv,
  config: AutoportConfig | undefined,
  disabled: boolean,
): { argv: string[]; hostname?: string } => {
  const mode = config?.proxy ?? "auto";
  if (disabled || mode === false) return { argv };
  if (!findAppService(project.services)) return { argv };
  if (process.env.AUTOPORT_ADOPT_PORT === "1") return { argv };

  const portless = which("portless");
  if (!portless) {
    if (mode === "portless") {
      process.stderr.write("autoport: proxy is set to portless, but portless is not installed\n");
    }
    return { argv };
  }

  // A run's dev server is its own, so it needs a hostname of its own: the
  // project name is deliberately shared between concurrent runs (the stack is),
  // and two of them registering one name with portless would leave APP_URL in
  // the second run pointing at the first one's port.
  const label = safeLabel(
    isAnonymousRun() ? `${project.name}-${process.env.AUTOPORT_RUN}` : project.name,
  );
  const hostname = `https://${label}.localhost`;
  env.APP_URL = hostname;
  // portless assigns the HTTP port itself and injects framework flags for the
  // dev servers that need them, so ours must not also be applied.
  delete env.PORT;
  env.AUTOPORT_ADOPT_PORT = "1";
  return { argv: [portless, label, ...argv], hostname };
};

/**
 * Put the project's own `node_modules/.bin` in front, as npm and bun do for the
 * scripts they run. `autoport vitest` typed at a shell is otherwise a spawn
 * ENOENT for a binary that is plainly installed, and wrapping a dependency is
 * most of what autoport is for.
 */
const withLocalBin = (project: ResolvedProject, path: string | undefined): string => {
  const dirs: string[] = [];
  for (const dir of new Set([project.appDir, project.key])) {
    const bin = join(dir, "node_modules", ".bin");
    if (existsSync(bin)) dirs.push(bin);
  }
  return [...dirs, ...(path ? [path] : [])].join(delimiter);
};

/**
 * Build the child's environment.
 *
 * A value already exported wins, because that is how CI and production override
 * things — but a value that merely came from the project's own `.env` file does
 * not, because every checkout carries the same one and it names a fixed port.
 */
const buildEnv = (project: ResolvedProject): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = withLocalBin(project, env.PATH);
  const { fileSourced } = detectDotenvConflicts(project.appDir, project.resources);

  for (const [key, value] of Object.entries(project.resources)) {
    const current = env[key];
    const fromFile = fileSourced[key];
    const isFileValue = fromFile !== undefined && fromFile.value === current;
    if (current === undefined || current === "" || isFileValue) {
      env[key] = String(value);
      continue;
    }
    if (current !== String(value)) {
      process.stderr.write(
        `autoport: ${key} is already set to ${current} in the environment, so ${value} is not used\n`,
      );
    }
  }
  env.AUTOPORT_PROJECT = project.name;
  return env;
};

/**
 * Ports this run would bind itself, as opposed to publish from a container.
 *
 * A datastore's port being busy is the normal case — the stack is up, and a
 * second command against it should join that stack, not clone it. A *host*
 * port being busy means another run of this project is already serving, which
 * is the thing a fresh set exists to get out of the way of.
 */
const hostPorts = (project: ResolvedProject, reservations: string[] | undefined): number[] => {
  const ports: number[] = [];
  for (const service of Object.values(project.services)) {
    if (service.containerPort === undefined) ports.push(service.port);
  }
  for (const name of reservations ?? []) {
    const key = portKey(name);
    const value = project.resources[key];
    if (typeof value === "number") ports.push(value);
  }
  return ports;
};

/**
 * Give the run's ports back when it ends.
 *
 * An anonymous run is nobody's to reuse: the id lives in this process's
 * environment and dies with it, so a lease left behind is garbage that the
 * six-hour reclaim would otherwise have to collect.
 *
 * `exit` only. A SIGINT or SIGTERM handler would *replace* node's default
 * termination, and this process must keep dying when it is told to — the run
 * already forwards those to the child and returns when the child is gone, so
 * the normal and interrupted paths both arrive here. A SIGKILL or a crash
 * leaves the lease to the reclaim, which is what it is for.
 */
const releaseWhenDone = (key: string, cache: string): void => {
  process.on("exit", () => {
    try {
      release(key);
      // The cache names this run's ports, and the run is over.
      rmSync(cache, { force: true });
    } catch {
      // Losing a lease on the way out is the reclaim's problem, not a reason to
      // fail the command that just finished.
    }
  });
};

export const runCommand = async (rawArgs: string[]): Promise<number> => {
  const noProxy = rawArgs.includes("--no-proxy");
  const fresh = rawArgs.includes("--fresh");
  const args = rawArgs.filter((arg) => arg !== "--no-proxy" && arg !== "--fresh");
  const given = args[0] === "--" ? args.slice(1) : args;

  const layout = findProject();
  const config = await loadConfig(layout.root);
  let project = resolveProject({
    layout,
    config,
    reservations: config?.reserve,
  });

  // Run the same project twice and the second one gets a set of its own, rather
  // than the first one's ports with something already on them. Only the
  // outermost autoport decides this: once a run exists its id is in the
  // environment, and every nested call joins it instead of splitting again.
  if (!inRun()) {
    const busy = hostPorts(project, config?.reserve).filter((port) => !probeFree(port));
    if (fresh || busy.length > 0) {
      const run = mintRun();
      process.env.AUTOPORT_RUN = run;
      project = resolveProject({ layout, config, reservations: config?.reserve });
      releaseWhenDone(projectLeaseKey(project.key, run), cachePath(project.appDir));
      const why = fresh ? "asked for a fresh set" : `${busy.join(", ")} already serving`;
      process.stderr.write(`autoport: ${why} — this run has its own ports\n`);
    }
  }

  // Bare `autoport` runs whatever this project calls its dev script.
  const argv = given.length > 0 ? given : defaultCommand(project.appDir);
  if (!argv || argv.length === 0) {
    process.stderr.write(
      'autoport: nothing to run — add a "dev" script, or pass a command: autoport pnpm dev\n',
    );
    return 2;
  }

  printWarnings(project.warnings);

  const env = buildEnv(project);
  const flagged = withPortFlag(project.appDir, argv, project);
  const proxied = withProxy(flagged.argv, project, env, config, noProxy);
  const usingProxy = proxied.hostname !== undefined;

  if (flagged.note && !usingProxy) process.stderr.write(`autoport: ${flagged.note}\n`);

  const summary = Object.values(project.services)
    .filter((service) => !(usingProxy && service.app))
    .map((service) => `${service.name}:${service.port}`)
    .join(" ");
  process.stderr.write(
    `autoport: ${project.name}${proxied.hostname ? ` ${proxied.hostname}` : ""} ${summary}\n`,
  );

  return await exec(usingProxy ? proxied.argv : flagged.argv, env, project.appDir);
};

export const exec = (argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> =>
  new Promise((settle) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit", env, cwd });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);

    child.on("error", (error) => {
      process.stderr.write(`autoport: ${(error as Error).message}\n`);
      settle(127);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      settle(signal ? 128 + 15 : (code ?? 0));
    });
  });

export type { FrameworkEntry };

import { inspect } from "node:util";
import { findProject } from "./project.ts";
import { findAppService, portKey, urlFor } from "./render.ts";
import { resolveProject, resolveSync } from "./resolve.ts";
import type { ResolvedProject, ResolvedService } from "./types.ts";

export type { ResolvedProject, ResolvedService };

/**
 * Augmented by the generated `autoport-env.d.ts`:
 *
 * ```ts
 * declare module "@mr96/autoport" {
 *   interface Resources { DATABASE_URL: string; PORT: number }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Resources {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Services {}

/**
 * Permissive until the generated types exist, exact afterwards.
 *
 * Without this the declared index signature would swallow every key and a typo
 * would never be a compile error, which is the entire point of generating types.
 */
type Widen<Declared, Fallback> = keyof Declared extends never ? Fallback : Declared;

export type ResourceMap = Widen<Resources, Record<string, string | number>>;
export type ServiceMap = Widen<Services, Record<string, ResolvedService>>;

interface State {
  project: ResolvedProject;
  /** Keys whose ambient value came from a project dotenv file. */
  fileSourced: Record<string, { file: string; value: string }>;
}

let state: State | undefined;
let stateKey: string | undefined;
let warned = false;

/**
 * The proxies' targets, kept in step with the resolved values.
 *
 * `util.inspect` formats a proxy's target rather than going through its traps,
 * so an empty target is why `console.log(resources)` would otherwise print `{}`
 * — the first thing anyone tries when a value looks wrong.
 */
const resourceTarget: Record<string, string | number> = {};
const serviceTarget: Record<string, ResolvedService> = {};

/** Set when the user has asked autoport to stand down entirely. */
const disabled = (): boolean =>
  process.env.AUTOPORT === "0" || process.env.AUTOPORT_DISABLE === "1";

/** Resolve once per process, per project. */
export const resolve = (options: { force?: boolean; cwd?: string } = {}): ResolvedProject => {
  const key = options.cwd ?? process.cwd();
  if (state && !options.force && stateKey === key) return state.project;

  const { project, fileSourced } = resolveSync(options.cwd);
  const adopted = adoptAmbientPort(project);
  state = { project: adopted, fileSourced };
  stateKey = key;
  for (const name of Object.keys(resourceTarget)) delete resourceTarget[name];
  for (const name of Object.keys(serviceTarget)) delete serviceTarget[name];
  Object.assign(resourceTarget, adopted.resources);
  Object.assign(serviceTarget, adopted.services);
  announce(adopted);
  return adopted;
};

/** @deprecated Use {@link resolve}. */
export const load = resolve;

/**
 * Warnings are useless if nobody sees them.
 *
 * The CLI prints them; a plain `import` has no other channel, so they go through
 * the process warning mechanism, once.
 */
const announce = (project: ResolvedProject): void => {
  if (warned || process.env.AUTOPORT_QUIET === "1") return;
  warned = true;
  for (const warning of project.warnings) {
    process.emitWarning(warning.message, { code: `autoport:${warning.code}` });
  }
};

/**
 * A proxy such as portless starts the process with a port already chosen.
 *
 * Gated on an explicit signal rather than on `PORT` itself: a stray `PORT` in a
 * shell profile or a CI runner is exactly the collision autoport exists to
 * prevent, and silently obeying it would defeat the tool.
 */
const adoptAmbientPort = (project: ResolvedProject): ResolvedProject => {
  if (process.env.AUTOPORT_ADOPT_PORT !== "1") return project;
  const ambient = Number(process.env.PORT);
  if (!Number.isFinite(ambient) || ambient <= 0) return project;

  const app = findAppService(project.services);
  if (!app || app.port === ambient) return project;

  const updated: ResolvedService = {
    ...app,
    port: ambient,
    via: "env",
    url: process.env.APP_URL ?? urlFor(app, ambient),
  };
  project.services[app.name] = updated;
  project.resources.PORT = ambient;
  project.resources.APP_URL = updated.url;
  project.resources[portKey(app.name)] = ambient;
  return project;
};

const coerce = (key: string, raw: string): string | number => {
  if (!/(^|_)PORT$/.test(key)) return raw;
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
};

/**
 * Read one value.
 *
 * `process.env` is consulted first so that a deployed process never touches the
 * filesystem — except for a value that came from a project dotenv file, which is
 * local dev configuration that autoport is precisely trying to replace.
 */
const overridden = new Set<string>();

/** Deployed processes must not touch the filesystem to answer a question. */
const deployed = (): boolean => process.env.NODE_ENV === "production";

export const tryResource = (key: string): string | number | undefined => {
  const ambient = process.env[key];
  const hasAmbient = ambient !== undefined && ambient !== "";

  if (disabled()) return hasAmbient ? coerce(key, ambient) : undefined;
  if (hasAmbient && deployed()) return coerce(key, ambient);

  const project = resolve();
  const leased = project.resources[key];

  if (!hasAmbient) return leased;

  // A value that merely came from the project's own dotenv file is local dev
  // configuration naming a fixed port, which is what autoport replaces.
  const fromFile = state?.fileSourced[key];
  if (fromFile && fromFile.value === ambient) return leased;

  // An exported value wins, because that is how CI and production override
  // things — but never silently, since a stray PORT in a shell profile is
  // exactly the collision autoport exists to prevent.
  if (leased !== undefined && String(leased) !== ambient && !overridden.has(key)) {
    overridden.add(key);
    process.emitWarning(
      `${key} is already set to ${ambient} in the environment, so autoport's ${leased} is not used`,
      { code: "autoport:env-override" },
    );
  }
  return coerce(key, ambient);
};

export const getResource = (key: string): string | number => {
  const value = tryResource(key);
  if (value !== undefined) return value;

  const known = Object.keys(resolve().resources).sort().join(", ");
  throw new Error(
    `autoport: no resource named "${key}". Known: ${known || "(none inferred)"}. ` +
      `Set ${key} in the environment, or declare it in autoport.config.ts.`,
  );
};

/**
 * Names that must not reach the resolver: symbols, and the properties runtimes
 * probe on any object (`then` decides whether a value is a promise).
 */
const asName = (key: PropertyKey): string | undefined => {
  if (typeof key !== "string") return undefined;
  if (key === "then" || key === "toJSON" || key === "constructor") return undefined;
  return key;
};

/**
 * Environment values for this project, resolved lazily.
 *
 * Reads like `process.env.X`, which is the point; `tryResource` is there for the
 * cases where a missing value is not an error.
 */
export const resources = new Proxy(resourceTarget as ResourceMap, {
  get(_target, key) {
    if (key === "toJSON") return () => ({ ...resolve().resources });
    if (key === inspect.custom) return () => resolve().resources;
    const name = asName(key);
    return name === undefined ? undefined : getResource(name);
  },
  has: (_target, key) => typeof key === "string" && tryResource(key) !== undefined,
  ownKeys: () => Object.keys(resolve().resources),
  getOwnPropertyDescriptor(_target, key) {
    const name = asName(key);
    if (name === undefined) return undefined;
    const value = tryResource(name);
    if (value === undefined) return undefined;
    return { enumerable: true, configurable: true, value };
  },
}) as ResourceMap;

/** The services behind those values, when you need to build a URL yourself. */
export const services = new Proxy(serviceTarget as ServiceMap, {
  get(_target, key) {
    if (key === "toJSON") return () => ({ ...resolve().services });
    if (key === inspect.custom) return () => resolve().services;
    const name = asName(key);
    if (name === undefined) return undefined;
    const service = resolve().services[name];
    if (service) return service;
    const known = Object.keys(resolve().services).join(", ");
    throw new Error(`autoport: no service named "${name}". Known: ${known || "(none inferred)"}.`);
  },
  has: (_target, key) => typeof key === "string" && key in resolve().services,
  ownKeys: () => Object.keys(resolve().services),
  getOwnPropertyDescriptor(_target, key) {
    const name = asName(key);
    if (name === undefined) return undefined;
    const service = resolve().services[name];
    return service ? { enumerable: true, configurable: true, value: service } : undefined;
  },
}) as ServiceMap;

/**
 * Lease a port for something autoport cannot infer — a debugger, a second
 * worker, a websocket server. Stable for this project across restarts.
 */
export const reservePort = (name: string): number => {
  const ambient = process.env[portKey(name)];
  if (ambient) {
    const value = Number(ambient);
    if (Number.isFinite(value)) return value;
  }

  const layout = findProject();
  const project = resolveProject({ layout, reservations: [name] });
  state = undefined;
  stateKey = undefined;
  const key = portKey(name);
  const port = project.resources[key];
  if (typeof port !== "number") throw new Error(`autoport: could not reserve a port for "${name}"`);
  return port;
};

/** Everything as a plain object, for spawning child processes. Values are strings. */
export const toEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(resolve().resources)) out[key] = String(tryResource(key));
  return out;
};

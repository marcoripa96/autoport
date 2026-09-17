import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

/** Files that define a stack, and therefore the scope ports are leased against. */
const STACK_MARKERS = [
  "autoport.config.ts",
  "autoport.config.mts",
  "autoport.config.js",
  "autoport.config.mjs",
  "autoport.config.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

const realpath = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

const ancestors = function* (from: string): Generator<string> {
  let dir = resolve(from);
  for (;;) {
    yield dir;
    // Never climb out of the checkout: a git worktree is the outer boundary.
    if (existsSync(join(dir, ".git"))) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
};

export interface ProjectLayout {
  /**
   * The stack's directory: where the compose file or config lives. Ports are
   * leased against this, so every app in a monorepo shares one database.
   */
  root: string;
  /**
   * The package being run: the nearest package.json at or above the cwd. In a
   * single-package project this is the same as `root`.
   */
  appDir?: string;
}

/**
 * Locate the stack and the package inside it.
 *
 * Resolving these separately is what makes a monorepo work. `docker-compose.yml`
 * at the repo root defines one stack; `apps/web` and `apps/api` are two packages
 * sharing it, each with its own dev-server port but the same DATABASE_URL.
 */
export const findProject = (from: string = process.cwd()): ProjectLayout => {
  let appDir: string | undefined;

  for (const dir of ancestors(from)) {
    if (!appDir && existsSync(join(dir, "package.json"))) appDir = dir;
    if (STACK_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
      return { root: realpath(dir), appDir: appDir ? realpath(appDir) : undefined };
    }
  }

  // No stack file anywhere: the package itself is the stack.
  const root = appDir ?? resolve(from);
  return { root: realpath(root), appDir: appDir ? realpath(appDir) : undefined };
};

export const findProjectRoot = (from?: string): string => findProject(from).root;

const shortHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 6);

/** Prefer the package's own name over the directory, which is often `web`. */
const packageName = (dir: string): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
    return pkg.name?.replace(/^@[^/]+\//, "");
  } catch {
    return undefined;
  }
};

/**
 * A name safe for the places one gets used verbatim: a docker project
 * (`[a-z0-9][a-z0-9_-]*`) and a DNS label in a proxy hostname.
 */
export const safeLabel = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "") || "autoport";

/**
 * Human-readable label. Two worktrees of `shop` become `shop` and `shop-4f1a2c`,
 * which is also what keeps their docker container names apart.
 */
export const projectName = (root: string, taken: (name: string) => boolean): string => {
  const base = packageName(root) ?? basename(root) ?? "project";
  if (!taken(base)) return base;
  return `${base}-${shortHash(root)}`;
};

/** Service name for a package's dev server: `web` at the root, else its directory. */
export const appServiceName = (root: string, appDir: string): string => {
  if (appDir === root) return "web";
  return basename(appDir).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "web";
};

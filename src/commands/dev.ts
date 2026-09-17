import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "../which.ts";

const LOCKFILES: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** The package manager this project is actually using. */
const packageManager = (appDir: string): string => {
  const pkg = readPackage(appDir);
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared && which(declared)) return declared;
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(join(appDir, lockfile)) && which(manager)) return manager;
  }
  return which("npm") ?? "npm";
};

const readPackage = (
  appDir: string,
): { scripts?: Record<string, string>; packageManager?: string } | undefined => {
  const path = join(appDir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
};

/**
 * What bare `autoport` runs: this project's dev script.
 *
 * Returns undefined when there is nothing obvious to run, so the caller can
 * print usage instead of guessing.
 */
export const defaultCommand = (appDir: string): string[] | undefined => {
  const scripts = readPackage(appDir)?.scripts ?? {};
  const script = ["dev", "start", "serve"].find((name) => name in scripts);
  if (!script) return undefined;
  return [packageManager(appDir), "run", script];
};

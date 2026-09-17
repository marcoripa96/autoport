import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AutoportConfig } from "./config.ts";
import { findConfigFile } from "./resolve.ts";

/**
 * Load `autoport.config.*`.
 *
 * Kept out of the library entry point on purpose: the dynamic `import()` below
 * makes bundlers emit "the request of a dependency is an expression" for every
 * application that merely reads a port.
 */
export const loadConfig = async (root: string): Promise<AutoportConfig | undefined> => {
  const path = findConfigFile(root);
  if (!path) return undefined;
  if (path.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8")) as AutoportConfig;
  const module = (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as {
    default?: AutoportConfig;
  };
  return module.default;
};

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * First executable named `name` in `extra` then on PATH, or undefined.
 *
 * `extra` is how a project's own `node_modules/.bin` gets searched: a tool
 * installed as a dev dependency is on PATH under `npm run`, because the package
 * manager puts it there, and not when autoport is invoked directly — so without
 * this, whether a local install is found depends on how you started it.
 */
export const which = (name: string, extra: string[] = []): string | undefined => {
  for (const dir of [...extra, ...(process.env.PATH ?? "").split(delimiter)]) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
};

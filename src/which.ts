import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** First executable named `name` on PATH, or undefined. */
export const which = (name: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
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

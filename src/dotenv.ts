import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse a dotenv file.
 *
 * Deliberately small: compose's own interpolation only needs KEY=value with
 * optional quoting, and a dependency here would be read at import time by every
 * application that uses the library.
 */
export const parseDotenv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
};

export const readDotenv = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/** The files a Node app loads, lowest precedence first. */
export const APP_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

export interface DotenvSource {
  file: string;
  values: Record<string, string>;
}

/** Every dotenv file present in a directory, in the order an app would load them. */
export const readAppDotenv = (dir: string): DotenvSource[] =>
  APP_ENV_FILES.map((file) => ({ file, values: readDotenv(join(dir, file)) })).filter(
    (source) => Object.keys(source.values).length > 0,
  );

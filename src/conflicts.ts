import { readAppDotenv } from "./dotenv.ts";
import type { Warning } from "./types.ts";

export interface DotenvConflicts {
  /** Keys autoport manages whose value comes from a project dotenv file. */
  fileSourced: Record<string, { file: string; value: string }>;
  warnings: Warning[];
}

/**
 * Find managed keys that a project `.env` file also sets.
 *
 * This matters more than it looks. Every worktree is a copy of the repo, so all
 * of them carry the same `.env.local` pointing at the same hardcoded port — and
 * a dotenv value reaches `process.env` before application code runs, so without
 * this check autoport would lease a port, announce it, and be quietly ignored.
 */
export const detectDotenvConflicts = (
  appDir: string,
  resources: Record<string, string | number>,
): DotenvConflicts => {
  const fileSourced: Record<string, { file: string; value: string }> = {};
  const warnings: Warning[] = [];

  for (const source of readAppDotenv(appDir)) {
    for (const [key, value] of Object.entries(source.values)) {
      if (!(key in resources)) continue;
      fileSourced[key] = { file: source.file, value };
    }
  }

  for (const [key, { file, value }] of Object.entries(fileSourced)) {
    const ours = String(resources[key]);
    if (ours === value) continue;
    warnings.push({
      code: "dotenv-conflict",
      message: `${file} sets ${key}=${value}, but autoport resolved ${ours} — autoport's value is used; delete that line to silence this`,
    });
  }

  return { fileSourced, warnings };
};

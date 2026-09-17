import type { Warning } from "../types.ts";

/** Warnings the user asked not to see again. */
const suppressed = (): Set<string> =>
  new Set((process.env.AUTOPORT_SILENCE ?? "").split(",").map((code) => code.trim()).filter(Boolean));

export const printWarnings = (warnings: Warning[]): void => {
  if (process.env.AUTOPORT_QUIET === "1") return;
  const skip = suppressed();
  for (const warning of warnings) {
    if (skip.has(warning.code)) continue;
    process.stderr.write(`autoport: ${warning.message}\n`);
  }
};

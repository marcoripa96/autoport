import { rmSync } from "node:fs";
import { join } from "node:path";
import { readLeases, release, releaseAll } from "../leases.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findProject, safeLabel } from "../project.ts";
import { cacheFiles, resolveProject } from "../resolve.ts";

const USAGE = `usage: autoport release [--all --yes]

Drops this project's leases so the ports can be reused. Containers and volumes
are not touched — stop those with "autoport compose down" first.
`;

export const releaseCommand = async (args: string[]): Promise<number> => {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.includes("--all")) {
    const leases = readLeases();
    const names = Object.values(leases.projects).map((lease) => lease.name);
    if (names.length === 0) {
      process.stderr.write("autoport: nothing leased\n");
      return 0;
    }
    if (!args.includes("--yes") && !args.includes("-y")) {
      // Every project on the machine is a lot to drop on a typo.
      process.stderr.write(
        `autoport: this would release ${names.length} project(s): ${names.join(", ")}\n` +
          `autoport: re-run with --yes to confirm\n`,
      );
      return 2;
    }
    const released = releaseAll();
    process.stderr.write(`autoport: released ${released.join(", ")}\n`);
    return 0;
  }

  const layout = findProject();
  const name = safeLabel(resolveProject({ layout }).name);
  const had = release(layout.root);
  // The cache records the ports we just gave up, so it has to go with them —
  // every run's, not just this process's: each one names a file of its own.
  for (const dir of new Set([layout.root, layout.appDir ?? layout.root])) {
    for (const file of cacheFiles(dir)) rmSync(file, { force: true });
  }
  process.stderr.write(
    had ? `autoport: released ${layout.root}\n` : `autoport: nothing leased for ${layout.root}\n`,
  );

  // Releasing the ports does not stop the stack that is publishing them, and a
  // stack nobody names again is how orphaned containers and volumes accumulate.
  if (had) await sayIfStillUp(name);
  return 0;
};

/** Point at a stack this release has just stopped tracking. */
const sayIfStillUp = async (project: string): Promise<void> => {
  try {
    const { stdout } = await promisify(execFile)("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    const count = stdout.split("\n").filter(Boolean).length;
    if (count > 0) {
      process.stderr.write(
        `autoport: ${count} container(s) of "${project}" are still there — ` +
          `"autoport compose down" removes them, or "autoport prune" once this checkout is gone\n`,
      );
    }
  } catch {
    // No docker, or none of its business. The ports are released either way.
  }
};

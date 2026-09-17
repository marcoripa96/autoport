import { rmSync } from "node:fs";
import { join } from "node:path";
import { readLeases, release, releaseAll } from "../leases.ts";
import { findProject } from "../project.ts";
import { CACHE_DIR } from "../resolve.ts";

const USAGE = `usage: autoport release [--all --yes]

Drops this project's leases so the ports can be reused. Containers and volumes
are not touched — stop those with "autoport compose down" first.
`;

export const releaseCommand = (args: string[]): number => {
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
  const had = release(layout.root);
  // The cache records the ports we just gave up, so it has to go with them.
  for (const dir of new Set([layout.root, layout.appDir ?? layout.root])) {
    rmSync(join(dir, CACHE_DIR, "resolved.json"), { force: true });
  }
  process.stderr.write(
    had ? `autoport: released ${layout.root}\n` : `autoport: nothing leased for ${layout.root}\n`,
  );
  return 0;
};

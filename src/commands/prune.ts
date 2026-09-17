import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { isInstanceKey, leaseDirectory, readLeases, release } from "../leases.ts";
import { safeLabel } from "../project.ts";

const run = promisify(execFile);

const USAGE = `usage: autoport prune [--yes]

Stacks whose checkout is gone. Without --yes, prints what it would remove.
`;

/**
 * Docker state belonging to one compose project.
 *
 * Read by label rather than by name prefix: compose stamps every container,
 * volume and network it creates with the project, and a prefix match would also
 * catch `shop-experiment` while cleaning up `shop`.
 */
const belongingTo = async (project: string): Promise<Record<string, string[]>> => {
  const filter = `label=com.docker.compose.project=${project}`;
  const of = async (kind: "ps" | "volume" | "network"): Promise<string[]> => {
    const args = kind === "ps" ? ["ps", "-aq"] : [kind, "ls", "-q"];
    try {
      const { stdout } = await run("docker", [...args, "--filter", filter]);
      return stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { containers: await of("ps"), volumes: await of("volume"), networks: await of("network") };
};

const remove = async (kind: string, ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  const argv =
    kind === "containers" ? ["rm", "-f", ...ids] : [kind.replace(/s$/, ""), "rm", ...ids];
  try {
    await run("docker", argv);
  } catch (error) {
    process.stderr.write(`autoport: could not remove ${kind} — ${(error as Error).message}\n`);
  }
};

export const pruneCommand = async (args: string[]): Promise<number> => {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const confirmed = args.includes("--yes");

  // A lease is the only record of what a checkout was called, so a stack is
  // reapable only while its lease survives. Leases for a vanished directory are
  // kept a fortnight before being dropped, which is the window to run this in.
  const leases = readLeases().projects;
  const stale = Object.entries(leases).filter(([key]) => !existsSync(leaseDirectory(key)));

  if (stale.length === 0) {
    process.stderr.write("autoport: nothing to prune — every leased checkout is still here\n");
    return 0;
  }

  for (const [key, lease] of stale) {
    const project = safeLabel(lease.name);
    const found = await belongingTo(project);
    const counts = Object.entries(found)
      .filter(([, ids]) => ids.length > 0)
      .map(([kind, ids]) => `${ids.length} ${kind}`)
      .join(", ");

    process.stdout.write(`${lease.name}  ${leaseDirectory(key)}\n`);
    process.stdout.write(`  ${counts || "no docker state"}${isInstanceKey(key) ? " (a run)" : ""}\n`);

    if (!confirmed) continue;

    // Containers first: a volume in use by one cannot be removed.
    await remove("containers", found.containers!);
    await remove("volumes", found.volumes!);
    await remove("networks", found.networks!);
    release(key);
    process.stdout.write("  removed\n");
  }

  if (!confirmed) {
    process.stderr.write("\nautoport: nothing removed — run with --yes\n");
  }
  return 0;
};

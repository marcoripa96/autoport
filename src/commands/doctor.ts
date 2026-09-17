import { existsSync } from "node:fs";
import { loadConfig } from "../config-loader.ts";
import { leaseDirectory, listeningPorts, probeFree, readLeases } from "../leases.ts";
import { findProject } from "../project.ts";
import { inspectProject } from "../resolve.ts";
import { which } from "../which.ts";

/** Check the things that quietly make autoport wrong, and say what to do. */
export const doctorCommand = async (): Promise<number> => {
  let problems = 0;
  const say = (ok: boolean, message: string, fix?: string): void => {
    if (!ok) problems++;
    process.stdout.write(`${ok ? "ok  " : "warn"}  ${message}\n`);
    if (!ok && fix) process.stdout.write(`      ${fix}\n`);
  };

  const canProbe = listeningPorts() !== undefined;
  say(
    canProbe,
    canProbe
      ? "can see which ports are in use"
      : "cannot see which ports are in use on this platform",
    "install iproute2 (ss), or run the CLI under bun, or autoport will only avoid ports it leased itself",
  );

  say(which("docker") !== undefined, "docker is installed", "autoport compose needs docker");
  const portless = which("portless") !== undefined;
  process.stdout.write(
    `ok    portless ${portless ? "is installed — HTTP services get a hostname" : "is not installed — HTTP services get a port"}\n`,
  );

  const layout = findProject();
  const inspection = inspectProject(layout, await loadConfig(layout.root));
  process.stdout.write(`\nproject ${inspection.name} at ${layout.root}\n`);

  for (const warning of inspection.warnings) {
    say(false, warning.message);
  }

  for (const [service, port] of Object.entries(inspection.leased)) {
    if (probeFree(port)) continue;
    process.stdout.write(`ok    ${service} is listening on ${port}\n`);
  }

  const leases = readLeases();
  const seen = new Map<number, string>();
  for (const [key, lease] of Object.entries(leases.projects)) {
    for (const port of Object.values(lease.services)) {
      const other = seen.get(port);
      if (other && other !== key) {
        say(false, `port ${port} is leased by two projects`, "run: autoport release");
      }
      seen.set(port, key);
    }
    if (!existsSync(leaseDirectory(key))) {
      process.stdout.write(`ok    ${lease.name} points at a missing directory; it will be retired\n`);
    }
  }

  process.stdout.write(problems === 0 ? "\nno problems found\n" : `\n${problems} thing(s) to look at\n`);
  return 0;
};

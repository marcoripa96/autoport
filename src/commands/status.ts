import { existsSync } from "node:fs";
import { loadConfig } from "../config-loader.ts";
import { leaseDirectory, probeFree, readLeases } from "../leases.ts";
import { findProject } from "../project.ts";
import { inspectProject } from "../resolve.ts";
import { printWarnings } from "./output.ts";

const pad = (value: string, width: number): string => value.padEnd(width);

const USAGE = `usage: autoport status [--json]

Lists every project leasing ports on this machine, then describes this one.
Read-only: it never allocates.
`;

export const statusCommand = async (args: string[]): Promise<number> => {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const leases = readLeases();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(leases, null, 2)}\n`);
    return 0;
  }

  const entries = Object.entries(leases.projects);
  const layout = findProject();
  const here = layout.root;

  if (entries.length === 0) {
    process.stdout.write("no leases yet\n");
  } else {
    const nameWidth = Math.max(4, ...entries.map(([, lease]) => lease.name.length));
    for (const [key, lease] of entries.sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const marker = key === here ? "*" : " ";
      const ports = Object.entries(lease.services)
        .map(([service, port]) => `${service}:${port}`)
        .join("  ");
      const missing = existsSync(leaseDirectory(key)) ? "" : "  (directory missing)";
      process.stdout.write(`${marker} ${pad(lease.name, nameWidth)}  ${ports}${missing}\n`);
      process.stdout.write(`  ${pad("", nameWidth)}  ${key}\n`);
    }
  }

  const inspection = inspectProject(layout, await loadConfig(here));
  process.stdout.write(`\nthis project (${inspection.name})\n`);
  if (inspection.sources.length > 0) {
    process.stdout.write(`  inferred from ${inspection.sources.join(", ")}\n`);
  }

  for (const spec of inspection.specs) {
    const port = inspection.leased[spec.name];
    const state = port === undefined ? "not leased" : probeFree(port) ? "free" : "in use";
    process.stdout.write(
      `  ${spec.name} -> ${port ?? "-"} [${state}] ${spec.type}\n      from ${spec.source}\n`,
    );
    for (const extra of spec.extraPorts) {
      const extraPort = inspection.leased[`${spec.name}:${extra.role}`];
      process.stdout.write(`      ${extra.role} -> ${extraPort ?? "-"} (container ${extra.containerPort})\n`);
    }
  }

  const live = new Set(inspection.specs.map((spec) => spec.name));
  for (const [service, port] of Object.entries(inspection.leased)) {
    if (live.has(service) || service.includes(":")) continue;
    process.stdout.write(`  ${service} -> ${port}  held by this stack, unused by this package\n`);
  }

  printWarnings(inspection.warnings);
  return 0;
};

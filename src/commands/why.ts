import { loadConfig } from "../config-loader.ts";
import { readAppDotenv } from "../dotenv.ts";
import { findProject } from "../project.ts";
import { resolveProject } from "../resolve.ts";

const USAGE = `usage: autoport why <KEY>

Explains where one resource value comes from.
`;

/** Answer "why is DATABASE_URL that?" without printing the whole machine. */
export const whyCommand = async (args: string[]): Promise<number> => {
  const key = args.find((arg) => !arg.startsWith("-"));
  if (!key || args.includes("--help")) {
    process.stdout.write(USAGE);
    return key ? 0 : 2;
  }

  const layout = findProject();
  const project = resolveProject({ layout, config: await loadConfig(layout.root) });

  const value = project.resources[key];
  if (value === undefined) {
    const known = Object.keys(project.resources).sort().join(", ");
    process.stderr.write(`autoport: no resource named "${key}"\nknown: ${known}\n`);
    return 1;
  }

  process.stdout.write(`${key}=${value}\n`);
  process.stdout.write(`  from ${project.provenance[key] ?? "autoport"}\n`);

  const service = Object.values(project.services).find(
    (candidate) => project.provenance[key]?.includes(`service ${candidate.name}`),
  );
  if (service) {
    process.stdout.write(`  service "${service.name}" (${service.type}) via ${service.via}\n`);
    process.stdout.write(`  declared in ${service.source}\n`);
    if (service.containerPort !== undefined) {
      process.stdout.write(`  host ${service.port} -> container ${service.containerPort}\n`);
    }
  }

  const ambient = process.env[key];
  if (ambient !== undefined && ambient !== String(value)) {
    process.stdout.write(`  note: the environment already sets ${key}=${ambient}, which wins\n`);
  }
  for (const source of readAppDotenv(project.appDir)) {
    if (key in source.values) {
      process.stdout.write(`  note: ${source.file} sets ${key}=${source.values[key]}\n`);
    }
  }
  return 0;
};

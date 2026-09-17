import { loadConfig } from "../config-loader.ts";
import { portKey } from "../render.ts";
import { findProject } from "../project.ts";
import { resolveProject } from "../resolve.ts";

const USAGE = `usage: autoport port <name>

Leases a port for something autoport cannot infer — a debugger, a worker, a
websocket server — and prints it. Stable for this project across restarts.
`;

export const portCommand = async (args: string[]): Promise<number> => {
  const name = args.find((arg) => !arg.startsWith("-"));
  if (!name || args.includes("--help")) {
    process.stdout.write(USAGE);
    return name ? 0 : 2;
  }

  const layout = findProject();
  const project = resolveProject({
    layout,
    config: await loadConfig(layout.root),
    reservations: [name],
  });

  const key = portKey(name);
  const port = project.resources[key];
  if (port === undefined) {
    process.stderr.write(`autoport: could not reserve a port for "${name}"\n`);
    return 1;
  }
  process.stdout.write(`${port}\n`);
  return 0;
};

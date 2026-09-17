import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const USAGE = `usage: autoport skills [list | get <name> | install [--global]]

  list                 every skill this version ships
  get <name>           print one, for an agent to read
  install [--global]   copy the discovery stub into .claude/skills
`;

/**
 * Where the skills live in the installed package.
 *
 * Resolved from this file rather than the working directory: the content has to
 * match the version that is running, which is the whole reason it ships in the
 * package instead of in a doc someone copies into their repo.
 */
const packageDir = (): string => {
  // Bundled, this file is `dist/cli.js`; from source it is `src/commands/`.
  // Walking up finds the package root either way, so the lookup does not depend
  // on how autoport was started.
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, "skill-data"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(import.meta.dirname, "..");
};

const dataDir = (): string => join(packageDir(), "skill-data");
const stubDir = (): string => join(packageDir(), "skills", "autoport");

/**
 * A skill's one-line summary: its frontmatter description, which is written to
 * be exactly that. The body's first paragraph is a poor stand-in — it opens
 * mid-thought as often as not.
 */
const summarise = (body: string): string => {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? "";
  const described = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  // The first sentence is the summary; the rest of a description is triggers.
  return described.split(/(?<=\.)\s/)[0] ?? "";
};

const names = (): string[] => {
  try {
    return readdirSync(dataDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dataDir(), entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

export const skillsCommand = async (args: string[]): Promise<number> => {
  const [action = "list", ...rest] = args;

  if (action === "--help" || action === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (action === "list") {
    const available = names();
    if (available.length === 0) {
      process.stderr.write("autoport: this build ships no skills\n");
      return 1;
    }
    for (const name of available) {
      const body = readFileSync(join(dataDir(), name, "SKILL.md"), "utf8");
      process.stdout.write(`  ${name.padEnd(16)}${summarise(body)}\n`);
    }
    process.stdout.write("\nautoport skills get <name>\n");
    return 0;
  }

  if (action === "get") {
    const name = rest[0];
    if (!name) {
      process.stderr.write(USAGE);
      return 2;
    }
    const path = join(dataDir(), name, "SKILL.md");
    if (!existsSync(path)) {
      process.stderr.write(`autoport: no skill named "${name}"\nknown: ${names().join(", ")}\n`);
      return 1;
    }
    process.stdout.write(readFileSync(path, "utf8"));
    return 0;
  }

  if (action === "install") {
    return install(rest.includes("--global"));
  }

  process.stderr.write(USAGE);
  return 2;
};

/** Copy the stub where an agent's skill discovery will find it. */
const install = (global: boolean): number => {
  const home = process.env.HOME ?? "";
  const base = global ? join(home, ".claude", "skills") : join(process.cwd(), ".claude", "skills");
  const target = join(base, "autoport");
  try {
    mkdirSync(target, { recursive: true });
    copyFileSync(join(stubDir(), "SKILL.md"), join(target, "SKILL.md"));
    process.stderr.write(`autoport: installed ${join(target, "SKILL.md")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`autoport: could not install the skill — ${(error as Error).message}\n`);
    return 1;
  }
};

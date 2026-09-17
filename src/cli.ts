#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeCommand } from "./commands/compose.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { envCommand } from "./commands/env.ts";
import { portCommand } from "./commands/port.ts";
import { releaseCommand } from "./commands/release.ts";
import { runCommand } from "./commands/run.ts";
import { statusCommand } from "./commands/status.ts";
import { whyCommand } from "./commands/why.ts";

/**
 * Read the version from the package rather than baking one in: the string is
 * next to the code that ships it, so a release cannot disagree with `--version`.
 */
const version = (): string => {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const path = join(import.meta.dirname, "..", "package.json");
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
};

const USAGE = `autoport — conflict-free ports for local dev stacks

  autoport                     run this project's dev script
  autoport <command> [args]    run any command with the ports injected
  autoport -- <command>        same, for a command named like a subcommand

  autoport env [--json|--export|--write <file>]
                               print this project's resources
  autoport compose [args]      docker compose with the leased ports
  autoport status [--json]     every project on this machine and its ports
  autoport why <KEY>           explain where one value comes from
  autoport port <name>         lease a port for something not inferred
  autoport doctor              check what might be making autoport wrong
  autoport release [--all --yes]
                               drop leases so the ports can be reused

Flags:
  --fresh                      give this run its own ports, always
  --no-proxy                   do not route HTTP through portless
  --help, --version

Environment:
  AUTOPORT=0            stand down; resources come only from process.env
  AUTOPORT_HOME         lease directory (default ~/.autoport)
  AUTOPORT_RANGE        allocation range, e.g. 40000-45000
  AUTOPORT_TYPEGEN=0    stop writing autoport-env.d.ts
  AUTOPORT_QUIET=1      suppress warnings
  AUTOPORT_RUN          this run's id; set by autoport, inherited by children
  AUTOPORT_SILENCE      comma-separated warning codes to suppress
`;

/**
 * Names that mean autoport rather than a program to run.
 *
 * Anything else is a command. `autoport -- ls` runs the real `ls`.
 */
const SUBCOMMANDS: Record<string, (args: string[]) => number | Promise<number>> = {
  env: envCommand,
  compose: composeCommand,
  status: statusCommand,
  ls: statusCommand,
  list: statusCommand,
  why: whyCommand,
  port: portCommand,
  doctor: doctorCommand,
  release: releaseCommand,
};

/** Flags autoport itself understands before a command. */
const GLOBAL_FLAGS = new Set(["--no-proxy", "--fresh"]);
const isGlobalFlag = (arg: string): boolean => GLOBAL_FLAGS.has(arg);

const main = async (argv: string[]): Promise<number> => {
  const [first, ...rest] = argv;

  // Asked for anywhere ahead of the command, not just first: `autoport --fresh
  // --help` is a question about autoport, and answering it with "unknown flag"
  // because a global flag came first is a riddle.
  const end = argv.indexOf("--");
  const leading = end === -1 ? argv : argv.slice(0, end);
  const asked = (...names: string[]): boolean =>
    leading.some((arg, index) => names.includes(arg) && leading.slice(0, index).every(isGlobalFlag));

  if (first === "help" || asked("--help", "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (asked("--version", "-v")) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (first !== undefined && first !== "--" && !first.startsWith("-")) {
    const subcommand = SUBCOMMANDS[first];
    // `autoport env DATABASE_URL=x cmd` means the program; `autoport env --json`
    // and `autoport env --write f` mean the subcommand. Only a leading non-flag
    // argument is the giveaway — anything later may be a flag's value.
    const shadowed = first === "env" && rest[0] !== undefined && !rest[0].startsWith("-");
    if (subcommand && !shadowed) return await subcommand(rest);
  }

  // Only what comes before `--` is addressed to autoport; past it the flags are
  // the command's, however much they look like ours.
  const unknownFlag = leading.find((arg) => arg.startsWith("-") && !isGlobalFlag(arg));
  const beforeCommand = leading.indexOf(unknownFlag ?? "") < leading.findIndex((arg) => !arg.startsWith("-"));
  if (unknownFlag && (beforeCommand || !leading.some((arg) => !arg.startsWith("-")))) {
    process.stderr.write(`autoport: unknown flag "${unknownFlag}"\n\n${USAGE}`);
    return 2;
  }

  return await runCommand(argv);
};

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`autoport: ${(error as Error).message}\n`);
    process.exit(1);
  });

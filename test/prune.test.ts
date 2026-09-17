import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLeases } from "../src/leases.ts";
import { resolveProject } from "../src/resolve.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let home: string;
let root: string;

const run = async (args: string[]) => {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: root,
    env: { ...process.env, AUTOPORT_HOME: home, AUTOPORT_PROXY: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "autoport-home-"));
  process.env.AUTOPORT_HOME = home;
  root = mkdtempSync(join(tmpdir(), "autoport-live-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "live" }));
  writeFileSync(
    join(root, "docker-compose.yml"),
    "services:\n  db:\n    image: postgres:16\n",
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.AUTOPORT_HOME;
});

describe("prune", () => {
  it("leaves a project whose checkout is still there", async () => {
    resolveProject({ cwd: root });
    const { stdout, stderr } = await run(["prune"]);
    expect(`${stdout}${stderr}`).toContain("nothing to prune");
  });

  it("names a project whose checkout is gone, and removes nothing without --yes", async () => {
    const doomed = mkdtempSync(join(tmpdir(), "autoport-doomed-"));
    writeFileSync(join(doomed, "package.json"), JSON.stringify({ name: "doomed" }));
    writeFileSync(join(doomed, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");
    resolveProject({ cwd: doomed });
    rmSync(doomed, { recursive: true, force: true });

    const { stdout, stderr } = await run(["prune"]);
    expect(stdout).toContain("doomed");
    expect(stderr).toContain("nothing removed");
    // The lease is the only record of what the stack was called, so a dry run
    // must not drop it.
    expect(Object.keys(readLeases().projects).some((key) => key.includes("doomed"))).toBe(true);
  });

  it("releases the lease of a checkout that is gone, with --yes", async () => {
    const doomed = mkdtempSync(join(tmpdir(), "autoport-doomed-"));
    writeFileSync(join(doomed, "package.json"), JSON.stringify({ name: "doomed" }));
    writeFileSync(join(doomed, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");
    resolveProject({ cwd: doomed });
    rmSync(doomed, { recursive: true, force: true });

    await run(["prune", "--yes"]);
    expect(Object.keys(readLeases().projects).some((key) => key.includes("doomed"))).toBe(false);
  });

  it("keeps the live project's lease while pruning a dead one", async () => {
    resolveProject({ cwd: root });
    const doomed = mkdtempSync(join(tmpdir(), "autoport-doomed-"));
    writeFileSync(join(doomed, "package.json"), JSON.stringify({ name: "doomed" }));
    writeFileSync(join(doomed, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");
    resolveProject({ cwd: doomed });
    rmSync(doomed, { recursive: true, force: true });

    await run(["prune", "--yes"]);
    const keys = Object.keys(readLeases().projects);
    expect(keys.some((key) => key.includes("autoport-live-"))).toBe(true);
    expect(keys.some((key) => key.includes("doomed"))).toBe(false);
  });
});

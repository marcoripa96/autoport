import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const DATA = join(import.meta.dir, "..", "skill-data");
const STUB = join(import.meta.dir, "..", "skills", "autoport", "SKILL.md");

const run = async (args: string[], cwd = process.cwd()) => {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

const topics = readdirSync(DATA);

describe("skills", () => {
  it("lists every skill that ships", async () => {
    const { code, stdout } = await run(["skills", "list"]);
    expect(code).toBe(0);
    for (const topic of topics) expect(stdout).toContain(topic);
  });

  it("prints one in full", async () => {
    const { code, stdout } = await run(["skills", "get", "core"]);
    expect(code).toBe(0);
    expect(stdout).toBe(readFileSync(join(DATA, "core", "SKILL.md"), "utf8"));
  });

  it("names the alternatives when asked for one that does not exist", async () => {
    const { code, stderr } = await run(["skills", "get", "nope"]);
    expect(code).toBe(1);
    expect(stderr).toContain("core");
  });

  it("installs the stub where skill discovery looks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autoport-skills-"));
    try {
      const { code } = await run(["skills", "install"], dir);
      expect(code).toBe(0);
      expect(existsSync(join(dir, ".claude", "skills", "autoport", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points only at skills that exist, so no branch is a dead end", () => {
    // The stub cannot change between releases, so a topic it names and the
    // package does not ship is a dead end for every agent on that version.
    const stub = readFileSync(STUB, "utf8");
    for (const named of stub.matchAll(/autoport skills get (\w+)/g)) {
      expect(topics).toContain(named[1]!);
    }
  });

  it("gives every skill a frontmatter description, which is its pointer", () => {
    for (const topic of topics) {
      const body = readFileSync(join(DATA, topic, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? "";
      expect(frontmatter).toContain(`name: ${topic}`);
      expect(/^description:\s*\S/m.test(frontmatter)).toBe(true);
    }
  });
});

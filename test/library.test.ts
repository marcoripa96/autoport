import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "autoport-home-"));
  root = mkdtempSync(join(tmpdir(), "autoport-lib-"));
  writeFileSync(
    join(root, "docker-compose.yml"),
    `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: pw\n`,
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lib", dependencies: { next: "15" } }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Each case runs in its own process, because the library memoises per process. */
const inProcess = async (script: string, env: Record<string, string> = {}) => {
  const proc = Bun.spawn(["bun", "-e", `const autoport = await import(${JSON.stringify(ENTRY)});\n${script}`], {
    cwd: root,
    env: { ...process.env, AUTOPORT_HOME: home, AUTOPORT_RANGE: "49200-49250", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    stdout: (await new Response(proc.stdout).text()).trim(),
    stderr: (await new Response(proc.stderr).text()).trim(),
  };
};

describe("resources", () => {
  it("resolves from a plain import with no CLI call", async () => {
    const { stdout } = await inProcess(`console.log(autoport.resources.DATABASE_URL)`);
    expect(stdout).toContain("postgres://postgres:pw@127.0.0.1:");
  });

  it("stays off the filesystem in production when the value is already set", async () => {
    // A deployed container has no ~/.autoport and must not need one.
    const { stdout, code } = await inProcess(`console.log(autoport.resources.DATABASE_URL)`, {
      NODE_ENV: "production",
      HOME: "/nonexistent",
      AUTOPORT_HOME: "/nonexistent/.autoport",
      DATABASE_URL: "postgres://real/db",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("postgres://real/db");
  });

  it("stands down entirely when AUTOPORT=0", async () => {
    const { stdout } = await inProcess(
      `console.log(autoport.resources.REDIS_URL, String(autoport.tryResource("NOPE")))`,
      { AUTOPORT: "0", REDIS_URL: "redis://ci:6379" },
    );
    expect(stdout).toBe("redis://ci:6379 undefined");
  });

  it("warns rather than silently obeying a stray ambient value", async () => {
    const { stdout, stderr } = await inProcess(`console.log(autoport.resources.PORT)`, {
      PORT: "3000",
    });
    expect(stdout).toBe("3000");
    expect(stderr).toContain("autoport's");
  });

  it("obeys a proxy that announces itself", async () => {
    const { stdout } = await inProcess(`console.log(autoport.resources.PORT)`, {
      AUTOPORT_ADOPT_PORT: "1",
      PORT: "4137",
    });
    expect(stdout).toBe("4137");
  });

  it("throws a helpful error for an unknown key, and tryResource does not", async () => {
    const thrown = await inProcess(`autoport.resources.NOPE`);
    expect(thrown.code).not.toBe(0);
    expect(thrown.stderr).toContain("no resource named");

    const soft = await inProcess(`console.log(String(autoport.tryResource("NOPE")))`);
    expect(soft.stdout).toBe("undefined");
  });

  it("is inspectable and enumerable", async () => {
    // console.log on the proxy is the first thing anyone tries when a value
    // looks wrong, and util.inspect formats the target rather than the traps.
    const { stdout } = await inProcess(
      `autoport.resolve(); console.log(Object.keys(autoport.resources).includes("DATABASE_URL"), require("node:util").inspect(autoport.resources).includes("DATABASE_URL"))`,
    );
    expect(stdout).toBe("true true");
  });

  it("surfaces warnings a library-only user would otherwise never see", async () => {
    writeFileSync(join(root, "docker-compose.yml"), `services:\n  x:\n    image: acme/unknown\n    expose:\n      - "1234"\n`);
    const { stderr } = await inProcess(`autoport.resolve()`);
    expect(stderr).toContain("not in the catalog");
  });

  it("leases a port on demand for something it cannot infer", async () => {
    const { stdout } = await inProcess(`console.log(autoport.reservePort("worker"))`);
    expect(Number(stdout)).toBeGreaterThan(0);
  });
});

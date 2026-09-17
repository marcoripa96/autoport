import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPorts } from "../src/commands/compose.ts";
import { resolveProject, resolveSync } from "../src/resolve.ts";
import { release } from "../src/leases.ts";
import { renderTypes, TYPES_FILE } from "../src/typegen.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let home: string;
let root: string;

const fixture = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "autoport-fix-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

const COMPOSE = `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${DB_PASS:-secret}
      POSTGRES_DB: shop
  cache:
    image: redis:7
`;

const PACKAGE = JSON.stringify({ name: "shop", dependencies: { next: "15.0.0" } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "autoport-home-"));
  process.env.AUTOPORT_HOME = home;
  process.env.AUTOPORT_RANGE = "49300-49400";
  root = fixture({ "docker-compose.yml": COMPOSE, "package.json": PACKAGE });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.AUTOPORT_HOME;
  delete process.env.AUTOPORT_RANGE;
});

describe("resolveProject", () => {
  it("infers a whole stack with no declaration", () => {
    const project = resolveProject({ cwd: root });
    expect(Object.keys(project.services).sort()).toEqual(["cache", "db", "web"]);
    expect(project.resources.DATABASE_URL).toContain("secret");
    expect(project.resources.DATABASE_URL).toContain("/shop");
    expect(project.resources.REDIS_URL).toStartWith("redis://");
    expect(typeof project.resources.PORT).toBe("number");
  });

  it("is stable across calls", () => {
    expect(resolveProject({ cwd: root }).resources).toEqual(resolveProject({ cwd: root }).resources);
  });

  it("keeps two projects off each other's ports", () => {
    const other = fixture({ "docker-compose.yml": COMPOSE, "package.json": PACKAGE });
    const a = resolveProject({ cwd: root });
    const b = resolveProject({ cwd: other });
    const ports = (p: typeof a) => Object.values(p.services).map((s) => s.port);
    expect(ports(a).filter((port) => ports(b).includes(port))).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  it("applies config overrides to a service it guessed wrong", () => {
    const project = resolveProject({
      cwd: root,
      config: {
        services: { cache: { type: "postgres" } },
        resources: ({ db }) => ({ SHADOW_DATABASE_URL: `${db!.url}_shadow` }),
      },
    });
    expect(project.services.cache!.type).toBe("postgres");
    expect(project.resources.SHADOW_DATABASE_URL).toEndWith("_shadow");
  });

  it("leases a port for something it could not infer", () => {
    const project = resolveProject({ cwd: root, reservations: ["worker-debug"] });
    expect(typeof project.resources.WORKER_DEBUG_PORT).toBe("number");
  });
});

describe("cache", () => {
  it("is rejected once the lease behind it is gone", () => {
    // Mtimes alone never notice this: `autoport release` touches no input file.
    const first = resolveSync(root).project;
    release(root);
    const second = resolveSync(root).project;
    expect(second.resources.DB_PORT).toBeDefined();
    expect(typeof second.resources.DB_PORT).toBe("number");
    expect(first.key).toBe(second.key);
  });

  it("is rejected when a compose file changes", () => {
    resolveProject({ cwd: root });
    writeFileSync(
      join(root, "docker-compose.yml"),
      `${COMPOSE}  mail:\n    image: axllent/mailpit\n`,
    );
    expect(Object.keys(resolveSync(root).project.services)).toContain("mail");
  });
});

describe("dotenv", () => {
  it("warns when a project .env file fixes a port autoport manages", () => {
    const project = resolveProject({ cwd: root });
    writeFileSync(
      join(root, ".env.local"),
      `DATABASE_URL=postgres://postgres:secret@127.0.0.1:${(project.services.db!.port as number) + 1}/shop\n`,
    );
    const again = resolveProject({ cwd: root });
    const codes = again.warnings.map((warning) => warning.code);
    expect(codes).toContain("dotenv-conflict");
  });
});

describe("generated files", () => {
  it("replaces published ports rather than adding to them", () => {
    const project = resolveProject({ cwd: root });
    const { model } = applyPorts(
      {
        services: {
          db: { ports: [{ target: 5432, published: "5432", protocol: "tcp", mode: "ingress" }] },
          cache: { ports: [] },
        },
      },
      project,
    );

    const db = model.services!.db!.ports as { published: string; target: number }[];
    expect(db).toHaveLength(1);
    expect(db[0]).toMatchObject({ published: String(project.services.db!.port), target: 5432 });

    const cache = model.services!.cache!.ports as { published: string; target: number }[];
    expect(cache[0]).toMatchObject({ published: String(project.services.cache!.port), target: 6379 });
  });

  it("names the compose project so two checkouts do not share containers", () => {
    const project = resolveProject({ cwd: root });
    expect(applyPorts({ services: {} }, project).model.name).toBe(project.name);
  });

  it("warns about extra published ports it does not manage", () => {
    const project = resolveProject({ cwd: root });
    const { warnings } = applyPorts(
      { services: { db: { ports: [{ target: 9999, published: "9999" }] } } },
      project,
    );
    expect(warnings.join()).toContain("may still collide");
  });

  it("writes types as a side effect of resolving, and gitignores them", () => {
    resolveProject({ cwd: root });
    expect(readFileSync(join(root, TYPES_FILE), "utf8")).toContain(`"DATABASE_URL": string;`);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(TYPES_FILE);
  });

  it("types ports as numbers and urls as strings", () => {
    const types = renderTypes(resolveProject({ cwd: root }));
    expect(types).toContain(`"DATABASE_URL": string;`);
    expect(types).toContain(`"PORT": number;`);
    expect(types).toContain(`declare module "@mr96/autoport"`);
  });
});

describe("cli", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: await proc.exited,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  };

  it("prints dotenv", async () => {
    const { code, stdout } = await run(["env"]);
    expect(code).toBe(0);
    expect(stdout).toContain("DATABASE_URL=postgres://postgres:secret@127.0.0.1:");
  });

  it("prints json", async () => {
    const { stdout } = await run(["env", "--json"]);
    expect(JSON.parse(stdout).REDIS_URL).toStartWith("redis://");
  });

  it("includes ports the config reserves, as the run and compose commands do", async () => {
    writeFileSync(
      join(root, "autoport.config.json"),
      JSON.stringify({ reserve: ["web", "realtime"] }),
    );
    const { stdout } = await run(["env", "--json"]);
    const resources = JSON.parse(stdout);
    expect(resources.WEB_PORT).toBeNumber();
    expect(resources.REALTIME_PORT).toBeNumber();
    expect(resources.WEB_PORT).not.toBe(resources.REALTIME_PORT);
  });

  it("writes a dotenv file for tools that cannot be wrapped", async () => {
    await run(["env", "--write", ".env.autoport"]);
    expect(readFileSync(join(root, ".env.autoport"), "utf8")).toContain("DATABASE_URL=");
  });

  it("rejects an unknown flag instead of resolving first", async () => {
    const { code, stderr } = await run(["env", "--yaml"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown flag");
  });

  it("injects the environment into a child process", async () => {
    const { stdout } = await run(["sh", "-c", "echo $DATABASE_URL"]);
    expect(stdout.trim()).toContain("/shop");
  });

  it("overrides a port that came from a project dotenv file", async () => {
    // Every worktree carries the same .env.local, so obeying it would mean every
    // worktree talking to the same database.
    writeFileSync(join(root, ".env.local"), "DATABASE_URL=postgres://nope@127.0.0.1:5432/shop\n");
    const { stdout } = await run(["sh", "-c", "echo $DATABASE_URL"]);
    expect(stdout.trim()).not.toContain("nope");
  });

  it("respects a value truly exported by the caller", async () => {
    const { stdout } = await run(["sh", "-c", "echo $DATABASE_URL"], {
      DATABASE_URL: "postgres://ci/db",
    });
    expect(stdout.trim()).toBe("postgres://ci/db");
  });

  it("runs the dev script when given no command at all", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ ...JSON.parse(PACKAGE), scripts: { dev: "echo dev-script-ran" } }),
    );
    const { stdout } = await run([]);
    expect(stdout).toContain("dev-script-ran");
  });

  it("appends a port flag to override one fixed in the dev script", async () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ ...JSON.parse(PACKAGE), scripts: { dev: "echo next dev -p 3000" } }),
    );
    const { stderr } = await run([]);
    expect(stderr).toContain("dev script fixes port 3000");
  });

  it("prefers the subcommand, and -- reaches the real program", async () => {
    expect((await run(["status"])).stdout).toContain("this project");
    expect((await run(["--", "echo", "literal"])).stdout.trim()).toBe("literal");
  });

  it("treats `env` with an argument as the program", async () => {
    expect((await run(["env", "FOO=bar", "sh", "-c", "echo $FOO"])).stdout.trim()).toBe("bar");
  });

  it("status does not allocate anything", async () => {
    const empty = mkdtempSync(join(tmpdir(), "autoport-empty-"));
    resolveProject({ cwd: root });
    const proc = Bun.spawn(["bun", CLI, "status"], { cwd: empty, env: process.env, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const leases = JSON.parse(readFileSync(join(home, "leases.json"), "utf8")) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(leases.projects)).not.toContain(empty);
    rmSync(empty, { recursive: true, force: true });
  });

  it("explains where a value came from", async () => {
    const { stdout } = await run(["why", "DATABASE_URL"]);
    expect(stdout).toContain("service db");
    expect(stdout).toContain("docker-compose.yml");
  });

  it("leases a port on demand", async () => {
    const { stdout } = await run(["port", "debugger"]);
    expect(Number(stdout.trim())).toBeGreaterThan(0);
  });

  it("refuses to release every project without confirmation", async () => {
    await run(["env"]);
    const { code, stderr } = await run(["release", "--all"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--yes");
  });

  it("passes the child's exit code through", async () => {
    expect((await run(["sh", "-c", "exit 7"])).code).toBe(7);
  });

  it("reports a command that does not exist", async () => {
    const { code, stderr } = await run(["definitely-not-a-program"]);
    expect(code).toBe(127);
    expect(stderr).toContain("definitely-not-a-program");
  });
});

describe("monorepo", () => {
  it("shares one stack between packages, each with its own dev-server port", () => {
    const repo = mkdtempSync(join(tmpdir(), "autoport-mono-"));
    writeFileSync(join(repo, "docker-compose.yml"), COMPOSE);
    mkdirSync(join(repo, "apps", "web"), { recursive: true });
    mkdirSync(join(repo, "apps", "api"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "package.json"), PACKAGE);
    writeFileSync(
      join(repo, "apps", "api", "package.json"),
      JSON.stringify({ name: "api", dependencies: { fastify: "5" } }),
    );

    const web = resolveProject({ cwd: join(repo, "apps", "web") });
    const api = resolveProject({ cwd: join(repo, "apps", "api") });

    expect(web.key).toBe(api.key);
    expect(web.resources.DATABASE_URL).toBe(api.resources.DATABASE_URL);
    expect(web.resources.PORT).not.toBe(api.resources.PORT);
    expect(resolveProject({ cwd: join(repo, "apps", "web") }).resources.PORT).toBe(web.resources.PORT);

    rmSync(repo, { recursive: true, force: true });
  });

  it("finds a framework hoisted to the repo root", () => {
    const repo = mkdtempSync(join(tmpdir(), "autoport-hoist-"));
    writeFileSync(join(repo, "docker-compose.yml"), COMPOSE);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "mono", devDependencies: { next: "15" } }),
    );
    mkdirSync(join(repo, "apps", "web"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "@mono/web" }));

    const project = resolveProject({ cwd: join(repo, "apps", "web") });
    expect(typeof project.resources.PORT).toBe("number");
    rmSync(repo, { recursive: true, force: true });
  });
});

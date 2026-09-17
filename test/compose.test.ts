import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferFromCompose } from "../src/compose.ts";

const fixture = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "autoport-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

const withCompose = (yaml: string, extra: Record<string, string> = {}): string =>
  fixture({ "docker-compose.yml": yaml, ...extra });

const codes = (result: { warnings: { code: string }[] }): string[] =>
  result.warnings.map((warning) => warning.code);

describe("inferFromCompose", () => {
  it("returns undefined when there is no compose file", () => {
    expect(inferFromCompose(mkdtempSync(join(tmpdir(), "autoport-")))).toBeUndefined();
  });

  it("reads catalog ports and environment maps", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_DB: shop\n`,
      ),
    )!;
    expect(result.services[0]).toMatchObject({
      name: "db",
      type: "postgres",
      containerPort: 5432,
      canonicalPort: 5432,
      managed: true,
      app: false,
      meta: { POSTGRES_DB: "shop" },
    });
  });

  it("interpolates ${VAR} from the project .env, like docker does", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASS:-fallback}\n      POSTGRES_DB: \${DB_NAME}\n`,
        { ".env": "DB_PASS=s3cret\nDB_NAME=shop\n" },
      ),
    )!;
    expect(result.services[0]!.meta).toEqual({ POSTGRES_PASSWORD: "s3cret", POSTGRES_DB: "shop" });
  });

  it("falls back to the default and warns when a variable is unset", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${MISSING_THING}\n`,
      ),
    )!;
    expect(result.services[0]!.meta.POSTGRES_PASSWORD).toBe("");
    expect(codes(result)).toContain("compose-unset-variable");
  });

  it("reads env_file, with inline environment winning", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  db:\n    image: postgres:16\n    env_file: ./db.env\n    environment:\n      POSTGRES_DB: inline\n`,
        { "db.env": "POSTGRES_USER=shopuser\nPOSTGRES_PASSWORD=envfilepass\nPOSTGRES_DB=fromfile\n" },
      ),
    )!;
    expect(result.services[0]!.meta).toMatchObject({
      POSTGRES_USER: "shopuser",
      POSTGRES_PASSWORD: "envfilepass",
      POSTGRES_DB: "inline",
    });
  });

  it("reads the list form of environment", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  db:\n    image: postgres:16\n    environment:\n      - POSTGRES_PASSWORD=x=y\n`,
      ),
    )!;
    expect(result.services[0]!.meta.POSTGRES_PASSWORD).toBe("x=y");
  });

  it("takes the container port from the command when it is set there", () => {
    const result = inferFromCompose(
      withCompose(`services:\n  db:\n    image: postgres:16\n    command: -p 5433\n`),
    )!;
    expect(result.services[0]!.containerPort).toBe(5433);
    expect(codes(result)).toContain("port-from-command");
  });

  it("treats a published host port as the preferred port, not a pin", () => {
    const result = inferFromCompose(
      withCompose(`services:\n  db:\n    image: postgres:16\n    ports:\n      - "5555:5432"\n`),
    )!;
    expect(result.services[0]).toMatchObject({
      managed: true,
      pinnedInFile: true,
      canonicalPort: 5555,
      containerPort: 5432,
    });
  });

  it("leases a secondary port for every extra port the image publishes", () => {
    const result = inferFromCompose(
      withCompose(`services:\n  mail:\n    image: axllent/mailpit\n`),
    )!;
    expect(result.services[0]!.extraPorts).toEqual([
      { role: "ui", containerPort: 8025, canonicalPort: 8025, http: true, pinnedInFile: false, protocol: "tcp" },
    ]);
  });

  it("keeps udp and tcp on the same number apart", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  turn:\n    image: acme/turn\n    ports:\n      - "3478:3478/tcp"\n      - "3478:3478/udp"\n`,
      ),
    )!;
    expect(result.services[0]!.protocol).toBe("tcp");
    expect(result.services[0]!.extraPorts.some((port) => port.protocol === "udp")).toBe(true);
  });

  it("merges docker-compose.override.yml the way docker does", () => {
    const result = inferFromCompose(
      withCompose(`services:\n  db:\n    image: postgres:16\n`, {
        "docker-compose.override.yml":
          `services:\n  db:\n    environment:\n      POSTGRES_DB: overridden\n  cache:\n    image: redis:7\n`,
      }),
    )!;
    expect(result.services.map((service) => service.name).sort()).toEqual(["cache", "db"]);
    expect(result.services.find((s) => s.name === "db")!.meta.POSTGRES_DB).toBe("overridden");
  });

  it("warns when a value it needs lives in a secret file", () => {
    const result = inferFromCompose(
      withCompose(
        `services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD_FILE: /run/secrets/pw\n`,
      ),
    )!;
    expect(codes(result)).toContain("secret-file");
  });

  it("falls back to expose for unknown images, and warns", () => {
    const result = inferFromCompose(
      withCompose(`services:\n  queue:\n    image: acme/queue:1\n    expose:\n      - "7000"\n`),
    )!;
    expect(result.services[0]).toMatchObject({ type: "unknown", containerPort: 7000 });
    expect(codes(result)).toContain("image-not-in-catalog");
  });

  it("warns about a service built from source rather than staying silent", () => {
    const result = inferFromCompose(
      withCompose(`services:\n  api:\n    build: .\n    expose:\n      - "8080"\n`),
    )!;
    expect(codes(result)).toContain("image-not-in-catalog");
  });

  it("skips a service with no discoverable port", () => {
    const result = inferFromCompose(withCompose(`services:\n  worker:\n    image: acme/worker\n`))!;
    expect(result.services).toHaveLength(0);
    expect(codes(result)).toContain("service-no-port");
  });

  it("survives malformed yaml", () => {
    const result = inferFromCompose(withCompose("services:\n  - [unbalanced\n"))!;
    expect(result.services).toHaveLength(0);
    expect(codes(result)).toContain("compose-parse");
  });
});

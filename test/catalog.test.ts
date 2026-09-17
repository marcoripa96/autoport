import { describe, expect, it } from "bun:test";
import { findCatalogEntry, lookupFramework, lookupImage, normalizeImage } from "../src/catalog.ts";

const url = (type: string, meta: Record<string, string> = {}, command: string[] = []) =>
  findCatalogEntry(type)!.url({ port: 4001, meta, name: type, command });

describe("normalizeImage", () => {
  it("strips registry host, port, library namespace, tag and digest", () => {
    const cases: [string, string][] = [
      ["postgres:16", "postgres"],
      ["docker.io/library/postgres:16", "postgres"],
      ["library/postgres", "postgres"],
      ["localhost:5000/postgres:16", "postgres"],
      ["registry.local:5000/postgres", "postgres"],
      ["public.ecr.aws/docker/library/postgres", "postgres"],
      ["postgres@sha256:abc", "postgres"],
      ["pgvector/pgvector:pg17", "pgvector/pgvector"],
    ];
    for (const [input, expected] of cases) expect(normalizeImage(input)).toBe(expected);
  });
});

describe("lookupImage", () => {
  it("recognises the flavours people actually run", () => {
    for (const image of [
      "postgres:16",
      "timescale/timescaledb:latest-pg16",
      "postgis/postgis:16-3.4",
      "bitnami/postgresql",
      "cgr.dev/chainguard/postgres",
      "mirror.gcr.io/postgres",
    ]) {
      expect(lookupImage(image)?.type).toBe("postgres");
    }
    expect(lookupImage("clickhouse:24")?.type).toBe("clickhouse");
    expect(lookupImage("docker.elastic.co/elasticsearch/elasticsearch:8.15.0")?.type).toBe(
      "elasticsearch",
    );
    expect(lookupImage("valkey/valkey:8")?.type).toBe("redis");
  });

  it("returns undefined for images it has never heard of", () => {
    expect(lookupImage("acme/bespoke-queue:1")).toBeUndefined();
  });
});

describe("connection strings", () => {
  it("builds postgres from the compose environment", () => {
    expect(url("postgres", { POSTGRES_PASSWORD: "s3cr3t", POSTGRES_DB: "shop" })).toBe(
      "postgres://postgres:s3cr3t@127.0.0.1:4001/shop",
    );
  });

  it("escapes credentials that would break the url", () => {
    expect(url("postgres", { POSTGRES_USER: "a b", POSTGRES_PASSWORD: "p@ss" })).toBe(
      "postgres://a%20b:p%40ss@127.0.0.1:4001/a b",
    );
  });

  it("honours trust auth", () => {
    expect(url("postgres", { POSTGRES_HOST_AUTH_METHOD: "trust" })).toBe(
      "postgres://postgres@127.0.0.1:4001/postgres",
    );
  });

  it("names the admin database when mongo authenticates a root user", () => {
    // The root user is created in `admin`; without authSource the connection is
    // refused against any other database.
    expect(
      url("mongo", {
        MONGO_INITDB_ROOT_USERNAME: "root",
        MONGO_INITDB_ROOT_PASSWORD: "pw",
        MONGO_INITDB_DATABASE: "shop",
      }),
    ).toBe("mongodb://root:pw@127.0.0.1:4001/shop?authSource=admin");
  });

  it("reads a redis password out of the command line", () => {
    expect(url("redis", {}, ["redis-server", "--requirepass", "hunter2"])).toBe(
      "redis://default:hunter2@127.0.0.1:4001",
    );
  });

  it("uses https for a secured elasticsearch and http when security is off", () => {
    expect(url("elasticsearch", { ELASTIC_PASSWORD: "pw" })).toBe(
      "https://elastic:pw@127.0.0.1:4001",
    );
    expect(url("elasticsearch", { "xpack.security.enabled": "false" })).toBe("http://127.0.0.1:4001");
  });

  it("surfaces minio credentials as aws keys", () => {
    const extra = findCatalogEntry("minio")!.extraResources!({
      port: 1,
      name: "storage",
      command: [],
      meta: { MINIO_ROOT_USER: "admin", MINIO_ROOT_PASSWORD: "password" },
    });
    expect(extra.AWS_ACCESS_KEY_ID).toBe("admin");
    expect(extra.AWS_SECRET_ACCESS_KEY).toBe("password");
  });
});

describe("port overrides from command", () => {
  it("reads postgres and redis ports off the command line", () => {
    expect(findCatalogEntry("postgres")!.portFromCommand!(["-p", "5433"])).toBe(5433);
    expect(findCatalogEntry("redis")!.portFromCommand!(["redis-server", "--port=6380"])).toBe(6380);
  });
});

describe("lookupFramework", () => {
  it("picks the framework from dependencies", () => {
    expect(lookupFramework({ next: "15" })?.port).toBe(3000);
    expect(lookupFramework({ astro: "4" })?.needsPortFlag).toBe(true);
    expect(lookupFramework({ lodash: "4" })).toBeUndefined();
  });

  it("lets the dev script decide when several are installed", () => {
    expect(lookupFramework({ vite: "5", next: "15" }, "vite")?.type).toBe("vite");
    expect(lookupFramework({ vite: "5", next: "15" }, "next dev")?.type).toBe("next");
    expect(lookupFramework({ vite: "5", next: "15" }, "vitest run")?.type).toBe("next");
  });
});

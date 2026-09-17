import { describe, expect, it } from "bun:test";
import { envKey, renderResources } from "../src/render.ts";
import type { ResolvedService } from "../src/types.ts";

const service = (over: Partial<ResolvedService>): ResolvedService => ({
  name: "db",
  type: "postgres",
  canonicalPort: 5432,
  containerPort: 5432,
  http: false,
  app: false,
  extraPorts: [],
  extras: {},
  managed: true,
  meta: {},
  command: [],
  protocol: "tcp",
  source: "test",
  port: 5432,
  url: "postgres://x",
  via: "allocated",
  ...over,
});

describe("envKey", () => {
  it("shouts and sanitises", () => {
    expect(envKey("db")).toBe("DB");
    expect(envKey("my-queue")).toBe("MY_QUEUE");
    expect(envKey("web.api")).toBe("WEB_API");
  });
});

describe("renderResources", () => {
  it("gives every service namespaced keys", () => {
    const { resources } = renderResources({ db: service({ url: "postgres://a" }) });
    expect(resources.DB_PORT).toBe(5432);
    expect(resources.DB_URL).toBe("postgres://a");
  });

  it("gives secondary ports their own keys", () => {
    const { resources } = renderResources({
      mail: service({
        name: "mail",
        type: "mailpit",
        port: 1025,
        url: "smtp://127.0.0.1:1025",
        extras: {
          ui: { role: "ui", port: 8025, containerPort: 8025, http: true, url: "http://127.0.0.1:8025" },
        },
      }),
    });
    expect(resources.MAIL_PORT).toBe(1025);
    expect(resources.MAIL_UI_PORT).toBe(8025);
    expect(resources.MAIL_UI_URL).toBe("http://127.0.0.1:8025");
  });

  it("lets the first postgres claim DATABASE_URL and no other", () => {
    const { resources } = renderResources({
      db: service({ name: "db", url: "postgres://first" }),
      replica: service({ name: "replica", url: "postgres://second" }),
    });
    expect(resources.DATABASE_URL).toBe("postgres://first");
    expect(resources.REPLICA_URL).toBe("postgres://second");
  });

  it("warns when a service name takes an alias another service needed", () => {
    // A Redis service called `database` owns DATABASE_URL by name. That is what
    // Prisma reads, so the postgres service losing it must not be silent.
    const { resources, warnings } = renderResources({
      database: service({ name: "database", type: "redis", url: "redis://other" }),
      pg: service({ name: "pg", url: "postgres://real" }),
    });
    expect(resources.DATABASE_URL).toBe("redis://other");
    expect(resources.PG_URL).toBe("postgres://real");
    expect(warnings.map((warning) => warning.code)).toContain("alias-taken");
  });

  it("gives PORT to the application, never to a datastore that speaks HTTP", () => {
    const { resources } = renderResources({
      storage: service({ name: "storage", type: "minio", http: true, port: 9000, url: "http://127.0.0.1:9000" }),
      web: service({ name: "web", type: "next", http: true, app: true, port: 3000, url: "http://127.0.0.1:3000" }),
    });
    expect(resources.PORT).toBe(3000);
    expect(resources.APP_URL).toBe("http://127.0.0.1:3000");
    expect(resources.STORAGE_PORT).toBe(9000);
  });

  it("leaves PORT unset when the project has no application", () => {
    const { resources } = renderResources({ db: service({}) });
    expect(resources.PORT).toBeUndefined();
  });

  it("records where each value came from", () => {
    const { provenance } = renderResources({ db: service({}) });
    expect(provenance.DATABASE_URL).toContain("service db");
  });
});

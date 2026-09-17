import { findCatalogEntry } from "./catalog.ts";
import type { ResolvedService, ServiceSpec, Warning } from "./types.ts";

/** `db` -> `DB`, `my-queue` -> `MY_QUEUE`. */
export const envKey = (name: string): string =>
  name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

export const urlFor = (spec: ServiceSpec, port: number): string => {
  const entry = findCatalogEntry(spec.type);
  if (entry) return entry.url({ port, meta: spec.meta, name: spec.name, command: spec.command });
  // Nothing is known about the protocol, so inventing a scheme would be a lie —
  // and `tcp://` is not something any client can parse.
  return spec.http ? `http://127.0.0.1:${port}` : `127.0.0.1:${port}`;
};

export interface Rendered {
  resources: Record<string, string | number>;
  /** Where each key came from, for `autoport why`. */
  provenance: Record<string, string>;
  warnings: Warning[];
}

/**
 * Turn resolved services into the environment variables application code reads.
 *
 * Namespaced keys are laid down first because they are derived from service
 * names and so are unique. Catalog aliases then fill in, and a collision between
 * the two is reported rather than silently resolved — a Redis service that
 * happens to be called `database` must not quietly own DATABASE_URL.
 */
export const renderResources = (services: Record<string, ResolvedService>): Rendered => {
  const resources: Record<string, string | number> = {};
  const provenance: Record<string, string> = {};
  const warnings: Warning[] = [];

  const put = (key: string, value: string | number, from: string): void => {
    resources[key] = value;
    provenance[key] = from;
  };

  for (const service of Object.values(services)) {
    const key = envKey(service.name);
    put(`${key}_PORT`, service.port, `service ${service.name}`);
    put(`${key}_URL`, service.url, `service ${service.name}`);
    // What another container on the compose network should use: the service
    // name and its unchanged internal port, not the host mapping.
    if (service.containerPort !== undefined) {
      put(
        `${key}_CONTAINER_URL`,
        service.url.replace(`127.0.0.1:${service.port}`, `${service.name}:${service.containerPort}`),
        `service ${service.name} (inside the compose network)`,
      );
    }
    for (const extra of Object.values(service.extras)) {
      const role = envKey(extra.role);
      put(`${key}_${role}_PORT`, extra.port, `service ${service.name} (${extra.role})`);
      put(`${key}_${role}_URL`, extra.url, `service ${service.name} (${extra.role})`);
    }
  }

  for (const service of Object.values(services)) {
    const entry = findCatalogEntry(service.type);
    for (const alias of entry?.aliases ?? []) {
      const holder = provenance[alias];
      if (holder === undefined) {
        put(alias, service.url, `service ${service.name} (alias)`);
        continue;
      }
      if (holder !== `service ${service.name}` && !holder.endsWith("(alias)")) {
        warnings.push({
          code: "alias-taken",
          message: `${alias} is the name of service "${alias.replace(/_URL$/, "").toLowerCase()}", so ${service.name} could not claim it — use ${envKey(service.name)}_URL instead`,
        });
      }
    }
    for (const [key, value] of Object.entries(
      entry?.extraResources?.({ port: service.port, meta: service.meta, name: service.name, command: service.command }) ?? {},
    )) {
      if (!(key in resources)) put(key, value, `service ${service.name}`);
    }
  }

  // Only the project's own dev server gets PORT: a datastore's HTTP console is
  // not the thing the user is building.
  const app = Object.values(services).find((service) => service.app);
  if (app) {
    put("PORT", app.port, `service ${app.name}`);
    put("APP_URL", app.url, `service ${app.name}`);
  }

  return { resources, provenance, warnings };
};

export const findAppService = (
  services: Record<string, ResolvedService>,
): ResolvedService | undefined => Object.values(services).find((service) => service.app);

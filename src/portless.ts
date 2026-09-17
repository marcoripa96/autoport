import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What portless is currently doing, read from the files it keeps rather than
 * guessed.
 *
 * autoport used to assume the proxy was on 443 and build `https://<name>.
 * localhost` from that. Started without sudo the proxy takes an unprivileged
 * port instead, and every URL it serves carries it — so the assumption produced
 * an `APP_URL` that did not resolve, for the one setup that needs no root.
 */
const home = (): string => process.env.PORTLESS_HOME ?? join(homedir(), ".portless");

const read = (name: string): string | undefined => {
  try {
    return readFileSync(join(home(), name), "utf8").trim();
  } catch {
    return undefined;
  }
};

export interface Route {
  hostname: string;
  port: number;
  pid: number;
}

/** The apps portless is currently routing to. */
export const routes = (): Route[] => {
  const raw = read("routes.json");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Route[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Is `hostname` already served by a process that is still alive?
 *
 * The pid check matters: a route outlives a killed dev server, and treating a
 * stale one as taken would move every later run off a name that is free.
 */
export const routeIsLive = (hostname: string): boolean =>
  routes().some((route) => {
    if (route.hostname !== hostname) return false;
    try {
      process.kill(route.pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/** The URL portless will serve `label` on, port included when it is not the default. */
export const proxyUrl = (label: string): string => {
  const tls = read("proxy.tls") !== "0";
  const scheme = tls ? "https" : "http";
  const port = Number(read("proxy.port"));
  const shown = Number.isFinite(port) && port !== (tls ? 443 : 80) ? `:${port}` : "";
  return `${scheme}://${label}.localhost${shown}`;
};

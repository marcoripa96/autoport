/**
 * Browser and edge build of autoport.
 *
 * Ports are a property of the machine the process runs on, so there is nothing
 * here to read. This exists to turn an unhelpful bundler error about `node:fs`
 * into a sentence that says what to do.
 */
const unavailable = (what: string): never => {
  throw new Error(
    `autoport: ${what} is not available in a browser or edge bundle. Read it on the server — in a Server Component, a route handler, or getServerSideProps — and pass the value down.`,
  );
};

export interface Resources {}
export interface Services {}

export const resources = new Proxy({} as Record<string, never>, {
  get: (_target, key) => (typeof key === "string" ? unavailable(`resources.${key}`) : undefined),
});

export const services = new Proxy({} as Record<string, never>, {
  get: (_target, key) => (typeof key === "string" ? unavailable(`services.${key}`) : undefined),
});

export const resolve = (): never => unavailable("resolve()");
export const load = resolve;
export const toEnv = (): never => unavailable("toEnv()");
export const getResource = (): never => unavailable("getResource()");
export const tryResource = (): undefined => undefined;
export const reservePort = (): never => unavailable("reservePort()");

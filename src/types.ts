export type Provenance = string;

export interface PortSpec {
  /** Suffix for generated keys; the primary port has no role. */
  role?: string;
  /** Port inside the container. */
  containerPort: number;
  /** Tried first when allocating. */
  canonicalPort: number;
  http: boolean;
  /** The compose file already published a host port for this one. */
  pinnedInFile?: boolean;
  protocol: "tcp" | "udp";
}

export interface ServiceSpec {
  /** Key in docker-compose `services:`, or the package name for a dev server. */
  name: string;
  /** Catalog type: "postgres", "redis", "next", "unknown". */
  type: string;
  /** Port inside the container. Absent for host processes like a dev server. */
  containerPort?: number;
  /** First candidate when allocating. Keeps solo projects on 5432/3000. */
  canonicalPort: number;
  /** Speaks HTTP. Says nothing about whether it is your application. */
  http: boolean;
  /**
   * This is the project's application, so it gets PORT and APP_URL and may be
   * fronted by a proxy. Only dev servers are apps; a MinIO console is not.
   */
  app: boolean;
  /** Secondary ports, each leased separately. */
  extraPorts: PortSpec[];
  /** False only when the config asks autoport to keep its hands off. */
  managed: boolean;
  /** The compose file already published a host port for this service. */
  pinnedInFile?: boolean;
  /** Fully interpolated environment of the compose service. */
  meta: Record<string, string>;
  /** The service's `command:`, split into arguments. */
  command: string[];
  protocol: "tcp" | "udp";
  source: Provenance;
}

export interface ResolvedPort {
  role: string;
  port: number;
  containerPort: number;
  http: boolean;
  url: string;
}

export interface ResolvedService extends ServiceSpec {
  /** Host port for the primary port. */
  port: number;
  /** Connection string for clients on the host. */
  url: string;
  /** Secondary ports, keyed by role. */
  extras: Record<string, ResolvedPort>;
  via: "env" | "lease" | "allocated" | "pinned";
  /** Set when the leased port is currently occupied by something. */
  occupied?: boolean;
}

export interface Warning {
  /** Stable identifier so a warning can be suppressed or tested. */
  code: string;
  message: string;
}

export interface ResolvedProject {
  version: 2;
  /** Realpath of the stack root. Identity for leases. */
  key: string;
  /** The package that was resolved from. Same as `key` outside a monorepo. */
  appDir: string;
  name: string;
  /** Files that contributed to the inference, relative to `key`. */
  sources: string[];
  resolvedAt: string;
  services: Record<string, ResolvedService>;
  resources: Record<string, string | number>;
  /** Which service or file each resource key came from, for `autoport why`. */
  provenance: Record<string, string>;
  warnings: Warning[];
}

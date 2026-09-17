import type { ResolvedService } from "./types.ts";

export interface ServiceOverride {
  /** Force the port tried first. Rarely needed — the catalog already knows. */
  canonicalPort?: number;
  containerPort?: number;
  /** Override a wrong guess from an unrecognised image. */
  type?: string;
  /** Speaks HTTP. */
  http?: boolean;
  /** This is the project's application, so it gets PORT and APP_URL. */
  app?: boolean;
  /** Replace the generated connection string. */
  url?: (service: Omit<ResolvedService, "url">) => string;
  /**
   * Keep this service on a fixed host port, accepting that two checkouts
   * running at once will collide on it.
   */
  fixed?: boolean;
}

export interface AutoportConfig {
  /** Defaults to the project directory name. */
  name?: string;
  /** Host port search range. Defaults to 40000-45000. */
  range?: [number, number];
  /** Corrections to what autoport inferred, keyed by compose service name. */
  services?: Record<string, ServiceOverride>;
  /** Extra ports to lease by name, for things autoport cannot infer. */
  reserve?: string[];
  /**
   * Give HTTP services a stable hostname by running the command through a local
   * proxy. "auto" uses portless when it is installed. Default "auto".
   */
  proxy?: "auto" | "portless" | false;
  /** Extra or replacement resource keys, merged over the generated ones. */
  resources?: (services: Record<string, ResolvedService>) => Record<string, string | number>;
}

export const defineConfig = (config: AutoportConfig): AutoportConfig => config;

export type { ResolvedService };

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { lookupFramework } from "./catalog.ts";
import { inferFromCompose } from "./compose.ts";
import { appServiceName, type ProjectLayout } from "./project.ts";
import type { ServiceSpec, Warning } from "./types.ts";

export interface Inference {
  services: ServiceSpec[];
  warnings: Warning[];
  sources: string[];
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readPackageJson = (dir: string): PackageJson | undefined => {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
};

const dependenciesOf = (pkg: PackageJson | undefined): Record<string, string> => ({
  ...(pkg?.dependencies ?? {}),
  ...(pkg?.devDependencies ?? {}),
});

/**
 * Work out the project's services from what is already on disk.
 *
 * The compose files name the backing services; package.json names the dev
 * server. The dev server is a host process rather than a container, which is
 * why it never has to appear in compose.
 */
export const inferServices = (layout: ProjectLayout): Inference => {
  const { root, appDir } = layout;
  const warnings: Warning[] = [];
  const sources: string[] = [];
  const services: ServiceSpec[] = [];

  const compose = inferFromCompose(root);
  if (compose) {
    for (const file of compose.files) sources.push(relative(root, file) || file);
    services.push(...compose.services);
    warnings.push(...compose.warnings);
  }

  if (appDir) {
    const pkg = readPackageJson(appDir);
    const where = relative(root, join(appDir, "package.json")) || "package.json";
    if (pkg) {
      sources.push(where);
      const devScript = pkg.scripts?.dev ?? pkg.scripts?.start ?? pkg.scripts?.serve;

      // A framework is often a root dependency in a monorepo while the app that
      // uses it lives in a workspace package, so look in both places.
      const rootPkg = appDir === root ? undefined : readPackageJson(root);
      const dependencies = { ...dependenciesOf(rootPkg), ...dependenciesOf(pkg) };
      const framework = lookupFramework(dependencies, devScript);

      if (framework) {
        const taken = new Set(services.map((service) => service.name));
        let name = appServiceName(root, appDir);
        if (taken.has(name)) name = `${name}-dev`;
        if (taken.has(name)) name = `${name}-${services.length}`;

        const hoisted = rootPkg !== undefined && framework.packages.some((p) => p in dependenciesOf(rootPkg)) && !framework.packages.some((p) => p in dependenciesOf(pkg));

        services.push({
          name,
          type: framework.type,
          canonicalPort: framework.port,
          http: true,
          app: true,
          extraPorts: [],
          managed: true,
          meta: {},
          command: [],
          protocol: "tcp",
          source: hoisted
            ? `package.json at the repo root (${framework.type}, hoisted)`
            : `${where} (${framework.packages.find((p) => p in dependenciesOf(pkg)) ?? framework.type})`,
        });
      } else if (devScript) {
        warnings.push({
          code: "framework-unknown",
          message: `${where} has a dev script but no framework autoport recognises — no PORT will be allocated for it`,
        });
      }
    }
  }

  if (services.length === 0) {
    warnings.push({
      code: "nothing-inferred",
      message:
        "no services inferred — add a compose file, a web framework dependency, or an autoport.config.ts",
    });
  }

  return { services, warnings, sources };
};

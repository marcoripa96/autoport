/**
 * What autoport knows about software so you never have to declare it.
 *
 * Each entry answers four questions for an image: which port does it speak,
 * which other ports does it publish, what does a connection string look like,
 * and which environment variable names is code expecting to find it under.
 */

export interface UrlContext {
  /** Allocated host port for the primary port. */
  port: number;
  /** Fully resolved environment of the compose service. */
  meta: Record<string, string>;
  /** Service name, e.g. "db". */
  name: string;
  /** Arguments from the service's `command:`, already split. */
  command: string[];
}

export interface ExtraPort {
  /** Suffix for the generated keys: `MAIL_UI_PORT`. */
  role: string;
  port: number;
  http?: boolean;
}

export interface CatalogEntry {
  type: string;
  /** Matched against the image name with registry, `library/` and tag stripped. */
  match: RegExp;
  port: number;
  /** Speaks HTTP, so a browser can open it. Never means "this is your app". */
  http?: boolean;
  /** Secondary ports the image publishes, each leased separately. */
  extraPorts?: ExtraPort[];
  url: (ctx: UrlContext) => string;
  /**
   * Well-known variable names this service can claim, best first. A name is only
   * taken if no earlier service claimed it.
   */
  aliases?: string[];
  /** Extra resource keys, for software where one URL is not enough. */
  extraResources?: (ctx: UrlContext) => Record<string, string>;
  /** Read a port out of `command:`, for images configured that way. */
  portFromCommand?: (command: string[]) => number | undefined;
}

const pick = (meta: Record<string, string>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = meta[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

const auth = (user?: string, password?: string): string => {
  if (!user) return "";
  const encoded = [encodeURIComponent(user), password ? encodeURIComponent(password) : undefined]
    .filter((part) => part !== undefined)
    .join(":");
  return `${encoded}@`;
};

/** Value of `--flag x` or `--flag=x` anywhere in a command. */
export const flagValue = (command: string[], ...flags: string[]): string | undefined => {
  for (let index = 0; index < command.length; index++) {
    const argument = command[index]!;
    for (const flag of flags) {
      if (argument === flag) return command[index + 1];
      if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
    }
  }
  return undefined;
};

const numericFlag = (command: string[], ...flags: string[]): number | undefined => {
  const raw = flagValue(command, ...flags);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

export const IMAGE_CATALOG: CatalogEntry[] = [
  {
    type: "postgres",
    match:
      /^(postgres(ql)?|pgvector\/pgvector|timescale\/timescaledb|supabase\/postgres|paradedb\/paradedb|postgis\/postgis|bitnami\/postgresql|ubuntu\/postgres|chainguard\/postgres|cloudnative-pg\/postgresql)$/,
    port: 5432,
    aliases: ["DATABASE_URL", "POSTGRES_URL"],
    portFromCommand: (command) => numericFlag(command, "-p", "--port"),
    url: ({ port, meta }) => {
      const user = pick(meta, "POSTGRES_USER", "POSTGRESQL_USERNAME") ?? "postgres";
      const trusted = pick(meta, "POSTGRES_HOST_AUTH_METHOD") === "trust";
      const password = pick(meta, "POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD") ?? (trusted ? "" : "postgres");
      const database = pick(meta, "POSTGRES_DB", "POSTGRESQL_DATABASE") ?? user;
      return `postgres://${auth(user, password)}127.0.0.1:${port}/${database}`;
    },
  },
  {
    type: "mysql",
    match: /^(mysql|mariadb|percona|bitnami\/mysql|bitnami\/mariadb)$/,
    port: 3306,
    aliases: ["DATABASE_URL", "MYSQL_URL"],
    portFromCommand: (command) => numericFlag(command, "-P", "--port"),
    url: ({ port, meta }) => {
      const user = pick(meta, "MYSQL_USER", "MARIADB_USER") ?? "root";
      const password =
        user === "root"
          ? pick(meta, "MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD")
          : pick(meta, "MYSQL_PASSWORD", "MARIADB_PASSWORD");
      const database = pick(meta, "MYSQL_DATABASE", "MARIADB_DATABASE") ?? "";
      return `mysql://${auth(user, password)}127.0.0.1:${port}/${database}`;
    },
  },
  {
    type: "redis",
    match:
      /^(redis|redis\/redis-stack(-server)?|valkey\/valkey|valkey|bitnami\/redis|chainguard\/redis)$/,
    port: 6379,
    aliases: ["REDIS_URL"],
    portFromCommand: (command) => numericFlag(command, "--port"),
    url: ({ port, meta, command }) => {
      // A password is far more often set on the command line than in the env.
      const password =
        flagValue(command, "--requirepass") ?? pick(meta, "REDIS_PASSWORD", "REDIS_ARGS");
      const clean = password?.startsWith("--") ? undefined : password;
      return `redis://${auth(clean ? "default" : undefined, clean)}127.0.0.1:${port}`;
    },
  },
  {
    type: "mongo",
    match: /^(mongo|mongodb\/mongodb-community-server|bitnami\/mongodb)$/,
    port: 27017,
    aliases: ["MONGO_URL", "MONGODB_URI"],
    url: ({ port, meta }) => {
      const user = pick(meta, "MONGO_INITDB_ROOT_USERNAME", "MONGODB_ROOT_USER");
      const password = pick(meta, "MONGO_INITDB_ROOT_PASSWORD", "MONGODB_ROOT_PASSWORD");
      const database = pick(meta, "MONGO_INITDB_DATABASE") ?? "";
      // The root user is created in `admin`, so a URL naming another database
      // has to say where to authenticate or the connection is refused.
      const query = user && database ? "?authSource=admin" : "";
      return `mongodb://${auth(user, password)}127.0.0.1:${port}/${database}${query}`;
    },
  },
  {
    type: "minio",
    match: /^(minio\/minio|bitnami\/minio|quay\.io\/minio\/minio)$/,
    port: 9000,
    http: true,
    extraPorts: [{ role: "console", port: 9001, http: true }],
    aliases: ["S3_ENDPOINT", "AWS_ENDPOINT_URL_S3"],
    url: ({ port }) => `http://127.0.0.1:${port}`,
    extraResources: ({ meta }) => ({
      AWS_ACCESS_KEY_ID: pick(meta, "MINIO_ROOT_USER", "MINIO_ACCESS_KEY") ?? "minioadmin",
      AWS_SECRET_ACCESS_KEY: pick(meta, "MINIO_ROOT_PASSWORD", "MINIO_SECRET_KEY") ?? "minioadmin",
      AWS_REGION: pick(meta, "MINIO_REGION") ?? "us-east-1",
    }),
  },
  {
    type: "mailpit",
    match: /^(axllent\/mailpit|mailhog\/mailhog|maildev\/maildev)$/,
    port: 1025,
    extraPorts: [{ role: "ui", port: 8025, http: true }],
    aliases: ["SMTP_URL"],
    url: ({ port }) => `smtp://127.0.0.1:${port}`,
  },
  {
    type: "elasticsearch",
    match: /^(elasticsearch(\/elasticsearch)?|opensearchproject\/opensearch)$/,
    port: 9200,
    http: true,
    extraPorts: [{ role: "transport", port: 9300 }],
    aliases: ["ELASTICSEARCH_URL"],
    url: ({ port, meta }) => {
      // Elasticsearch 8 ships with security on unless it is explicitly disabled.
      const secured = pick(meta, "xpack.security.enabled") !== "false";
      const password = pick(meta, "ELASTIC_PASSWORD");
      const scheme = secured ? "https" : "http";
      return `${scheme}://${auth(secured ? "elastic" : undefined, password)}127.0.0.1:${port}`;
    },
  },
  {
    type: "rabbitmq",
    match: /^(rabbitmq|bitnami\/rabbitmq)$/,
    port: 5672,
    extraPorts: [{ role: "ui", port: 15672, http: true }],
    aliases: ["AMQP_URL"],
    url: ({ port, meta }) =>
      `amqp://${auth(pick(meta, "RABBITMQ_DEFAULT_USER") ?? "guest", pick(meta, "RABBITMQ_DEFAULT_PASS") ?? "guest")}127.0.0.1:${port}`,
  },
  {
    type: "clickhouse",
    match: /^(clickhouse(\/clickhouse-server)?|bitnami\/clickhouse)$/,
    port: 8123,
    http: true,
    extraPorts: [{ role: "native", port: 9000 }],
    aliases: ["CLICKHOUSE_URL"],
    url: ({ port, meta }) => {
      const user = pick(meta, "CLICKHOUSE_USER") ?? "default";
      const password = pick(meta, "CLICKHOUSE_PASSWORD");
      const database = pick(meta, "CLICKHOUSE_DB") ?? "";
      return `http://${auth(user, password)}127.0.0.1:${port}/${database}`;
    },
  },
  {
    type: "localstack",
    match: /^localstack\/localstack(-pro)?$/,
    port: 4566,
    http: true,
    aliases: ["AWS_ENDPOINT_URL"],
    url: ({ port }) => `http://127.0.0.1:${port}`,
  },
];

export interface FrameworkEntry {
  type: string;
  /** npm dependency names that identify this framework. */
  packages: string[];
  port: number;
  /** The flag this dev server takes, when it has one. */
  portFlag?: string;
  /** True when the dev server ignores $PORT and only obeys the flag. */
  needsPortFlag?: boolean;
  /** Binary names in the dev command the flag should be appended to. */
  binaries: string[];
  /** Other flags that pin a port, checked so we can tell when a script fixes one. */
  pinFlags?: string[];
}

export const FRAMEWORK_CATALOG: FrameworkEntry[] = [
  { type: "next", packages: ["next"], port: 3000, portFlag: "-p", binaries: ["next"], pinFlags: ["-p", "--port"] },
  { type: "nuxt", packages: ["nuxt", "nuxt3"], port: 3000, portFlag: "--port", binaries: ["nuxt", "nuxi"], pinFlags: ["-p", "--port"] },
  { type: "nest", packages: ["@nestjs/core"], port: 3000, binaries: ["nest"] },
  { type: "remix", packages: ["@remix-run/dev", "@remix-run/serve"], port: 3000, portFlag: "--port", binaries: ["remix"], pinFlags: ["-p", "--port"] },
  {
    type: "react-router",
    packages: ["@react-router/dev"],
    port: 3000,
    portFlag: "--port",
    needsPortFlag: true,
    binaries: ["react-router"],
    pinFlags: ["--port"],
  },
  { type: "vite", packages: ["vite"], port: 5173, portFlag: "--port", needsPortFlag: true, binaries: ["vite"], pinFlags: ["--port"] },
  { type: "astro", packages: ["astro"], port: 4321, portFlag: "--port", needsPortFlag: true, binaries: ["astro"], pinFlags: ["--port"] },
  { type: "angular", packages: ["@angular/cli"], port: 4200, portFlag: "--port", needsPortFlag: true, binaries: ["ng"], pinFlags: ["--port"] },
  { type: "sveltekit", packages: ["@sveltejs/kit"], port: 5173, portFlag: "--port", needsPortFlag: true, binaries: ["vite"], pinFlags: ["--port"] },
  { type: "express", packages: ["express"], port: 3000, binaries: ["node", "tsx", "nodemon"] },
  { type: "fastify", packages: ["fastify"], port: 3000, binaries: ["node", "tsx", "fastify"] },
  { type: "hono", packages: ["hono"], port: 3000, binaries: ["node", "tsx"] },
];

/**
 * Strip registry host, the implicit `library/` namespace and any tag or digest,
 * so `localhost:5000/library/postgres:16` and `postgres` are the same image.
 */
export const normalizeImage = (image: string): string => {
  let name = image.split("@")[0] ?? image;
  const parts = name.split("/");

  // A first segment containing a dot, a colon, or spelled `localhost` is a
  // registry host rather than a namespace.
  const head = parts[0] ?? "";
  if (parts.length > 1 && (head.includes(".") || head.includes(":") || head === "localhost")) {
    parts.shift();
  }
  // `library` is Docker Hub's implicit namespace for official images, and some
  // mirrors prefix it with a registry alias of their own.
  while (parts.length > 1 && (parts[0] === "library" || parts[0] === "docker")) parts.shift();

  name = parts.join("/");
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  if (colon > slash) name = name.slice(0, colon);
  return name;
};

export const lookupImage = (image: string): CatalogEntry | undefined => {
  const name = normalizeImage(image);
  return IMAGE_CATALOG.find((entry) => entry.match.test(name));
};

export const findCatalogEntry = (type: string): CatalogEntry | undefined =>
  IMAGE_CATALOG.find((entry) => entry.type === type);

/**
 * Which framework this package uses.
 *
 * The dev script decides when a project has more than one — a repo with both
 * `next` and `vite` installed and `"dev": "vite"` is a Vite project, whatever
 * order the dependencies happen to be in.
 */
export const lookupFramework = (
  dependencies: Record<string, string>,
  devScript?: string,
): FrameworkEntry | undefined => {
  const installed = FRAMEWORK_CATALOG.filter((entry) =>
    entry.packages.some((pkg) => pkg in dependencies),
  );
  if (installed.length <= 1) return installed[0];

  if (devScript) {
    const named = installed.find((entry) =>
      entry.binaries.some((binary) => new RegExp(`(^|[\\s/"'])${binary}([\\s"']|$)`).test(devScript)),
    );
    if (named) return named;
  }
  return installed[0];
};

export const findFrameworkByType = (type: string): FrameworkEntry | undefined =>
  FRAMEWORK_CATALOG.find((entry) => entry.type === type);

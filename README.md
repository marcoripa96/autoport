# autoport

Conflict-free ports for local dev stacks, with nothing to declare.

Several agents working several checkouts of the same project all want :3000,
:5432 and :6379. autoport works out which services a project has, leases each one
a host port that nothing else on the machine is using, and hands them to your
code under the environment variable names it already reads.

```ts
import { resources } from "autoport";

resources.DATABASE_URL; // postgres://postgres:secret@127.0.0.1:40001/shop
resources.PORT;         // 40004
```

## Quick start

```bash
bun add autoport
autoport                  # instead of `pnpm dev`
```

That is the whole setup. No config file, no port numbers, no codegen step —
`autoport-env.d.ts` is written and kept current as a side effect of resolving,
so `resources.DATABASE_URL` is typed, and `resources.DATABSE_URL` is a compile
error, from the first time anything runs.

## How it works out your stack

**`docker-compose.yml`** names the backing services. The image says which port it
speaks and what a connection string looks like; the environment supplies the
credentials — including `env_file:`, `${VAR}` interpolation against the project
`.env`, `command:` overrides, and `docker-compose.override.yml`.

```yaml
services:
  db:
    image: postgres:16        # -> 5432, DATABASE_URL
    env_file: ./db.env
    environment:
      POSTGRES_PASSWORD: ${DB_PASS:-secret}
  cache:
    image: redis:7            # -> 6379, REDIS_URL
```

**`package.json`** names the dev server, which is why Next.js never appears in
compose — it is a host process, not a container. A `next` dependency means an
HTTP service that wants `PORT`; `vite` means one that wants `--port` instead,
which autoport appends for you. With several frameworks installed, the dev script
decides.

Known images and frameworks live in [`src/catalog.ts`](src/catalog.ts). An
unknown image falls back to its `expose:` port and a plain `host:port` value, and
says so.

## The values you get

| key | from |
| --- | --- |
| `DB_PORT`, `DB_URL` | the service named `db` |
| `DB_CONTAINER_URL` | the same service as another container sees it |
| `MAIL_UI_PORT` | a service's secondary ports, each leased separately |
| `DATABASE_URL`, `POSTGRES_URL` | the first Postgres service |
| `REDIS_URL` | the first Redis service |
| `AWS_ACCESS_KEY_ID`, `S3_ENDPOINT` | a MinIO service |
| `PORT`, `APP_URL` | your application — never a datastore that speaks HTTP |

If a service's own name takes a well-known key (a Redis service called
`database` owning `DATABASE_URL`), autoport says so rather than letting the
Postgres service lose it quietly.

## Consuming them

**In TypeScript.** `resources` resolves lazily and synchronously, so it works in
a Next.js app, a test run, or a bare `tsx script.ts` with no wrapper command.

```ts
import { resources, services, tryResource, reservePort } from "autoport";

await createClient({ url: resources.REDIS_URL });
server.listen(resources.PORT);

tryResource("MAYBE") ?? "fallback";  // undefined instead of throwing
reservePort("worker-debug");         // a port for something not inferred

services.db.port;          // 40001
services.db.containerPort; // 5432 — unchanged, inside the container
```

It is server-only. Importing it in a client component or an edge function gives
you a sentence telling you to read the value on the server, rather than a
bundler error about `node:fs`.

**Anywhere else.** Put `autoport` in front of anything.

```bash
autoport                       # runs this project's dev script
autoport pnpm dev
autoport psql "$DATABASE_URL"
autoport -- ls                 # `--` for a command named like a subcommand

autoport env                   # dotenv on stdout
autoport env --json
autoport env --write .env.autoport   # for GUI tools that cannot be wrapped
eval "$(autoport env --export)"
```

## Precedence

1. A value **exported** in the environment wins. That is how CI and production
   override things. autoport says when it happens, so a stray `PORT` in a shell
   profile is visible rather than mysterious.
2. A value from the project's own `.env` / `.env.local` **loses**. Every checkout
   carries the same one naming the same fixed port, which is the collision
   autoport exists to remove. You get a warning naming the file and the line.
3. Otherwise, the lease.

In production (`NODE_ENV=production`) a value already in the environment is
returned without touching the filesystem at all. `AUTOPORT=0` makes `resources`
a plain view over `process.env` and nothing else.

## Docker compose

```bash
autoport compose up -d
```

autoport asks docker for the fully resolved model of your compose files,
replaces the published host ports with the leased ones, and runs the result from
`.autoport/compose.yml`.

Rewriting the whole model matters. Compose *concatenates* `ports` across files,
so layering an override would publish the leased port **in addition to**
whatever was already written down — and that is the one that collides. Which is
also why **a host port in your compose file is a preference, not a pin**:

```yaml
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"     # first checkout keeps this; the second moves to 40001
```

Nothing about the container changes — internally Postgres is still on 5432, so
service-to-service links are untouched. Add `services: { db: { fixed: true } }`
to the config if you would rather have the collision.

`COMPOSE_PROJECT_NAME` is set **before** docker resolves the model, so volume
and network names are namespaced too. Without that, two worktrees of one repo
share `shop_pgdata` and `shop_default` — two postmasters on one data directory,
and every container-to-container link crossing checkouts.

## Stable hostnames

If [portless](https://portless.sh) is installed, autoport uses it. Still one
command:

```bash
autoport
# autoport: shop https://shop.localhost  db:40001 cache:40002
```

portless takes the HTTP service and gives it a name; autoport allocates
everything else and sets `APP_URL`. Without portless the app gets an allocated
port and `http://127.0.0.1:<port>`. `autoport --no-proxy`, or `proxy: false` in
the config, opts out.

## Monorepos

The stack and the package are found separately. A compose file at the repo root
defines one stack; each `package.json` under it is a package sharing it.

```
shop/
  docker-compose.yml     -> one database, leased once
  apps/web/package.json  -> its own dev-server port
  apps/api/package.json  -> its own dev-server port
```

Both get the same `DATABASE_URL` and different `PORT`s, and neither evicts the
other's lease. A framework hoisted to the root `package.json` is found too.

## Parallel runs

`AUTOPORT_INSTANCE=<name>` gives a run its own set of ports against the same
project, so a Playwright suite can bring up its own stack while the dev server
keeps using the project's. Instance leases are reclaimed after six hours.

```bash
AUTOPORT_INSTANCE=e2e autoport compose up -d
AUTOPORT_INSTANCE=e2e autoport playwright test
```

## Config, when inference gets it wrong

`autoport.config.ts` is optional and merges over what was inferred.

```ts
import { defineConfig } from "autoport/config";

export default defineConfig({
  services: {
    queue: { type: "redis", containerPort: 6379 },  // an image we don't know
    db: { fixed: true },                             // never move this one
  },
  reserve: ["worker-debug"],
  resources: ({ db }) => ({ SHADOW_DATABASE_URL: `${db.url}_shadow` }),
});
```

A TypeScript config cannot be imported synchronously. The CLI applies it and
caches the result for the library; on a cold library-only start you get a warning
naming the keys that are missing until an autoport command runs.
`autoport.config.json` has no such restriction.

## Leases

Allocations live in `~/.autoport/leases.json`, keyed by the stack directory's
real path — which is why two git worktrees of one repo get separate sets, and why
the same worktree gets the same ports tomorrow.

The canonical port is tried first, so a project alone on your machine still lands
on 5432 and 3000. Later projects drift into 40000-45000.

Before allocating, autoport checks nothing is listening: procfs on Linux,
otherwise `ss`, `netstat` or `lsof`, plus a real bind under Bun. A port **already
leased** to you is kept even if it is busy, because that is usually your own
service still running — reported, not silently reallocated.

```bash
autoport status          # every project on this machine; read-only
autoport why DATABASE_URL
autoport doctor          # what might be making autoport wrong
autoport port <name>     # lease a port for something not inferred
autoport release         # give this project's ports back
autoport release --all --yes
```

A lease whose directory has vanished is kept for a fortnight first: an unmounted
share looks exactly like a deleted directory.

| variable | |
| --- | --- |
| `AUTOPORT=0` | stand down; resources come only from `process.env` |
| `AUTOPORT_HOME` | lease directory, default `~/.autoport` |
| `AUTOPORT_RANGE` | allocation range, e.g. `40000-45000` |
| `AUTOPORT_INSTANCE` | a separate set of ports for this run |
| `AUTOPORT_TYPEGEN=0` | stop writing `autoport-env.d.ts` |
| `AUTOPORT_QUIET=1` | suppress warnings |
| `AUTOPORT_SILENCE` | comma-separated warning codes to suppress |
| `AUTOPORT_ADOPT_PORT=1` | obey an ambient `PORT` (set by the proxy wrapper) |

## Limits worth knowing

- Inference is a guess. `autoport status` prints where every value came from and
  `autoport doctor` checks what might be wrong, so a bad guess is visible.
- `autoport compose` needs docker running. The library and `autoport env` do not.
- `autoport release` returns ports; it does not stop containers or remove
  volumes. Run `autoport compose down` first.
- A service publishing a port autoport does not know about gets a warning, not a
  lease — catalogued secondary ports (MinIO's console, Mailpit's UI,
  Elasticsearch's transport port) are leased.
- Overriding a port already written into a dev script relies on the last flag
  winning, which is true of every framework in the catalog but is not a law.
- `docker compose config` cannot see a value behind `*_FILE` or a docker secret;
  autoport warns instead of inventing one.
- One bridge network per stack: docker's default address pool runs out somewhere
  around thirty simultaneous stacks.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

MIT.

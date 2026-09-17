# autoport

Conflict-free ports for local dev stacks, with nothing to declare.

Several agents working several checkouts of the same project all want :3000,
:5432 and :6379. autoport works out which services a project has, leases each one
a host port that nothing else on the machine is using, and hands them to your
code under the environment variable names it already reads.

```ts
import { resources } from "@mr96/autoport";

resources.DATABASE_URL; // postgres://postgres:secret@127.0.0.1:40001/shop
resources.PORT;         // 40004
```

## Quick start

```bash
bun add -D @mr96/autoport
autoport                  # instead of `pnpm dev`
```

**A dev dependency**, because the values reach your code as environment
variables and autoport is what puts them there. `autoport-env.d.ts` types
`process.env` for this project, so `process.env.DATABASE_URL` is a `string` and
a typo is a compile error — with nothing imported and nothing to resolve at
runtime. A deployed build that pruned autoport still starts, reading whatever
your platform sets.

It merges with an `env.d.ts` you already have, keeping both sets of keys. Every
value is typed `string`, so a file that types one of the same keys as a number
is a `TS2717` conflict — change it to `string` and coerce where it is used.

Install it as a real dependency only for `resources` and `services` below: they
give a number where the environment can only give a string, and throw on a
missing key rather than yielding `undefined`, and that costs an import your
production build has to resolve.

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
import { resources, services, tryResource, reservePort } from "@mr96/autoport";

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

If [portless](https://portless.sh) is installed, autoport uses it — as a dev
dependency of the project as readily as a global install, so a checkout carries
its own proxy and a teammate needs no setup step:

```bash
bun add -D portless
```

It is declared as an optional peer, so nothing installs it for you and autoport
is complete without it. Still one command:

```bash
autoport
# autoport: shop https://shop.localhost  db:40001 cache:40002
```

portless takes the HTTP service and gives it a name; autoport allocates
everything else and sets `APP_URL` — read from the port and scheme portless
records, so a proxy started without sudo on an unprivileged port gives you
`https://shop.localhost:1355` rather than a URL that does not resolve. Without
portless the app gets an allocated port and `http://127.0.0.1:<port>`.
`autoport --no-proxy`, `AUTOPORT_PROXY=0`, or `proxy: false` in the config opts
out.

A second concurrent run is recognised here by the **registered hostname**, not by
a busy port: portless assigns the port itself, so the leased one is never bound
and could never be the signal. The extra run gets a name of its own. A route
whose process has died does not count, since portless leaves it behind.

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

**Task runners that filter the environment.** Turborepo 2 runs tasks in strict
env mode, so a variable autoport exports is not visible to the task unless it is
declared — the task falls back to whatever default your env layer holds, and the
symptom is a dev server binding the port you were trying to move off. Name the
keys in `turbo.json`:

```jsonc
{ "globalEnv": ["POSTGRES_PORT", "REDIS_PORT", "WEB_PORT"] }
```

`globalEnv` rather than `globalPassThroughEnv`, since the values change the
build output and belong in the cache key. Nx's `inputs` and any runner with an
allowlist need the same treatment.

## Running the same project twice

Start a second run while the first is serving and it gets a set of its own,
without being told to:

```bash
autoport            # web on 3000, db on 5432
autoport            # autoport: 3000 already serving — this run has its own ports
```

The second run mints an id, leases its own host ports against it, and gives them
back when it exits. Nothing accumulates and there is nothing to clean up.

**A run moves its own processes, not the stack.** Containers outlive the command
that started them — `-d` is the point of `-d` — so they stay on the project's
ports under the project's name, and both runs talk to the one Postgres that is
actually up. A run whose containers were named after it would leave a stack
behind that nothing could later find to tear down. If you want a second stack
too, name it: `AUTOPORT_INSTANCE=e2e` moves everything, and is yours to bring
down.

Only the **outermost** autoport decides this. The run id is exported to the
child, so every nested call inherits it: `autoport turbo run dev` splits once,
and the `autoport` inside each task joins the run rather than splitting again.
Which is also the rule for scripts — put the wrapper at the top:

```jsonc
// one run: both commands are children of the wrapper, so both see one WEB_PORT
"dev:all": "autoport bun run dev:all:inner",
"dev:all:inner": "bun run dev & bun run wait-for-web && bun run open",

// two runs: siblings, so each mints its own and `open` opens the wrong port
"dev:all": "autoport bun run dev & autoport bun run open",
```

**Ports are not the only thing two runs collide on.** A framework that takes an
exclusive lock on its build directory — Next.js on `.next/lock`, for one — will
refuse to start a second time in one directory however free the port is, and the
error talks about the *first* server rather than the lock. Give each run its own
directory from the run id autoport exports:

```jsonc
// apps/web/package.json
"dev": "sh -c 'exec env ${AUTOPORT_RUN:+NEXT_DIST_DIR=.next-$AUTOPORT_RUN} next dev'"
```

Anything else a run holds exclusively — a socket path, a pidfile, a SQLite file —
wants the same treatment. autoport leases ports; `AUTOPORT_RUN` is there to key
the rest.

Escalation keys on **host** ports for the same reason. A datastore's port being
busy means the stack is up and you want to join it; the dev server's port being
busy means another run is already serving. `--fresh` forces a new set either
way, and a stopped project always gets its own ports back rather than a new set.

`AUTOPORT_INSTANCE=<name>` is the stable version of the same thing: a *named*
set that persists across runs, for a side stack you want to keep — a Playwright
database you re-use rather than re-seed. Named leases are reclaimed after six
hours idle.

```bash
AUTOPORT_INSTANCE=e2e autoport compose up -d
AUTOPORT_INSTANCE=e2e autoport playwright test
```

## Config, when inference gets it wrong

`autoport.config.ts` is optional and merges over what was inferred.

```ts
import { defineConfig } from "@mr96/autoport/config";

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

## What a project is called

The **directory**, as `docker compose` names a project — so two worktrees of one
repo are `shop` and `shop-experiment` without being told. Two checkouts that do
land on the same name become `shop` and `shop-4f1a2c`.

The name is what `COMPOSE_PROJECT_NAME`, the portless hostname and
`autoport status` all use, so `name` in the config overrides it when the
directory is a poor label:

```ts
export default defineConfig({ name: "shop-pr-421" });
```

Renaming a project renames its containers and volumes, so bring the stack down
before changing it and up again after — the old volumes are otherwise orphaned
rather than migrated.

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
| `AUTOPORT_INSTANCE` | a named, persistent set of ports |
| `AUTOPORT_RUN` | set by autoport for a run; inherited by children |
| `AUTOPORT_TYPEGEN=0` | stop writing `autoport-env.d.ts` |
| `AUTOPORT_QUIET=1` | suppress warnings |
| `AUTOPORT_PROXY=0` | do not route through portless |
| `AUTOPORT_SILENCE` | comma-separated warning codes to suppress |
| `AUTOPORT_ADOPT_PORT=1` | obey an ambient `PORT` (set by the proxy wrapper) |

## Limits worth knowing

- Inference is a guess. `autoport status` prints where every value came from and
  `autoport doctor` checks what might be wrong, so a bad guess is visible.
- `autoport compose` needs docker running. The library and `autoport env` do not.
- `autoport release` returns ports; it does not stop containers or remove
  volumes. Run `autoport compose down` first — it says when a stack is still up.
  For a checkout that is already gone, `autoport prune` finds the stacks nothing
  names any more and `--yes` removes them. It works from the lease, so run it
  before the lease is dropped a fortnight later.
- A service publishing a port autoport does not know about gets a warning, not a
  lease — catalogued secondary ports (MinIO's console, Mailpit's UI,
  Elasticsearch's transport port) are leased.
- Overriding a port already written into a dev script relies on the last flag
  winning, which is true of every framework in the catalog but is not a law.
- `docker compose config` cannot see a value behind `*_FILE` or a docker secret;
  autoport warns instead of inventing one.
- One bridge network per stack: docker's default address pool runs out somewhere
  around thirty simultaneous stacks.

## For agents

autoport ships the guide an agent needs, served by the CLI so it matches the
installed version rather than a doc that drifts:

```bash
autoport skills install     # drop the discovery stub into .claude/skills
autoport skills list
autoport skills get setup
```

`install --global` writes to `~/.claude/skills` instead. Without it, the same
content is one command away — `autoport skills get core`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

MIT.

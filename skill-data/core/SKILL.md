---
name: core
description: How autoport decides a project's ports and how to read them. Read before running any autoport command or changing a project's ports.
---

# autoport core

Leases every host port a project binds, keyed by the checkout's real path, and exposes them under the names the project already reads. Two worktrees get different ports without either being configured; the same worktree gets the same ports tomorrow.

## Reading the values

**From `process.env`, with a dev dependency.** The default, and what to reach for first. `autoport-env.d.ts` augments `NodeJS.ProcessEnv` for this project, so `process.env.DATABASE_URL` is a typed `string` and a typo is a compile error — no import, nothing to resolve at runtime, and a deployed build that pruned autoport still starts.

Nothing imports that file: a `.d.ts` inside the program contributes globally, the way `next-env.d.ts` does. Every value is a `string`, ports included, because that is what an environment holds.

```ts
const url = process.env.DATABASE_URL;        // string
const port = Number(process.env.WEB_PORT);   // strings are strings
```

**From `resources`, with a real dependency.** Lazy and synchronous, so it works in a Next route, a test, or a bare script with no wrapper command.

```ts
import { resources, services, tryResource } from "@mr96/autoport";

resources.DATABASE_URL;      // throws if absent, so a typo fails loudly
tryResource("MAYBE");        // undefined instead
services.db.containerPort;   // 5432 — unchanged inside the container
```

It gives a number where the environment can only give a string, throws on a missing key rather than yielding `undefined`, and exposes `services`. That costs an import the production build must resolve, which is the reason to install autoport as a dependency rather than a dev dependency.

Server-only. Importing it in a client component or an edge function returns a sentence telling you to read the value on the server.

**Anywhere else.** Put `autoport` in front of the command; it injects the values as environment variables and execs.

```bash
autoport pnpm dev
autoport env --json          # inspect without running anything
```

Run `autoport --help` for the command surface rather than memorising it here.

## Precedence

Three sources, in order:

1. A value **exported in the environment wins**, and autoport says so. That is how CI and production override things.
2. A value from the project's own `.env` **loses**, with a warning naming the file and line. Every checkout carries the same `.env` naming the same fixed port, which is the collision autoport removes.
3. Otherwise the lease.

The consequence when adding autoport to a project: **delete the port lines from `.env`**, do not leave them as a fallback that silently disagrees with reality.

## What it infers

`docker-compose.yml` names the backing services — the image says which port it speaks and what a connection string looks like, the environment supplies credentials. `package.json` names the dev server, which is why a framework never appears in compose: it is a host process, not a container.

A service autoport cannot identify gets its `expose:` port and a plain `host:port` value, and says so.

## A host port in compose is a preference, not a pin

`"5432:5432"` means *try 5432*. The first checkout keeps it; the second moves. Nothing about the container changes — internally the service is still on 5432, so service-to-service links are untouched.

`autoport compose` rewrites the whole resolved model rather than layering an override file, because compose **concatenates** `ports` across files: an override would publish the leased port *in addition to* the one already written down, and the original is the one that collides.

Use `autoport compose up -d`, never bare `docker compose`, or the containers publish the hardcoded ports while the app reads the leased ones.

## Where the name comes from

The **directory**, as `docker compose` names a project — so worktrees differ without being told. It is what `COMPOSE_PROJECT_NAME`, the proxy hostname and `autoport status` all use. Override with `name` in the config when the directory is a poor label.

Renaming a project renames its containers and volumes, so bring the stack down before changing it and up after.

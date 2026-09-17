---
name: setup
description: Wiring autoport into an existing project's scripts, config and env layer. Read before editing package.json scripts or adding autoport.config.ts.
---

# Wiring autoport into a project

## Put the wrapper at the top, once

autoport exports the leased values into the **child** environment, so everything below one `autoport` shares one set. Wrap the outermost command, not each inner one:

```jsonc
// one set of ports, shared by both steps
"services:up": "autoport bun run services:up:inner",
"services:up:inner": "autoport compose up -d --wait && bun run db:migrate:inner",
"db:migrate:inner": "varlock run -- bun --filter @app/db db:migrate",
```

Commands joined by `&&` at the top level are **siblings**, not children: each would resolve separately. That is fine when they only touch container ports, and wrong the moment a host port matters.

A nested `autoport` inherits the outer run rather than starting a new one, so leaving `autoport compose` inside is correct and costs nothing.

## Task runners filter the environment

Turborepo 2 runs tasks in **strict env mode**: a variable autoport exports is invisible to the task unless declared. The symptom is a dev server binding the port you were trying to move off, because the env layer fell back to its default.

```jsonc
// turbo.json
{ "globalEnv": ["POSTGRES_PORT", "REDIS_PORT", "WEB_PORT", "AUTOPORT_RUN"] }
```

`globalEnv` rather than `globalPassThroughEnv`: the values change the build output and belong in the cache key. Nx `inputs` and any runner with an allowlist need the same.

## Let the env layer derive the URLs

A project that already centralises ports (varlock, dotenv-flow, a schema file) should keep deriving `DATABASE_URL` and friends from the port. autoport supplies the **numbers**; the existing layer keeps its single source of truth.

Check the layer prefers `process.env` over its own file before relying on this — most do, and the whole wiring depends on it.

Then delete the hardcoded port lines from `.env`. Leave the schema defaults: they are what a checkout running without autoport falls back to.

## Config, when inference is wrong

`autoport.config.ts` merges over what was inferred.

```ts
import { defineConfig } from "@mr96/autoport/config";

export default defineConfig({
  reserve: ["web", "realtime"],          // ports for host processes nothing infers -> WEB_PORT, REALTIME_PORT
  services: { db: { fixed: true } },     // never move this one
  name: "shop-pr-421",                   // when the directory is a poor label
});
```

`reserve` is the answer whenever a process binds a port that no compose file and no recognised dev script names — a worker, a second server, a task runner hiding the framework.

A TypeScript config cannot be imported synchronously, so the CLI applies it and caches the result for the library. `autoport.config.json` has no such restriction.

## Verify

```bash
autoport env --json      # every value, with nothing running
autoport why DATABASE_URL
autoport status          # every project on this machine
```

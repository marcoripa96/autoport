---
name: troubleshooting
description: Diagnosing a port, URL or container that is not what autoport said. Read when something binds the wrong port, a value disagrees, or a container cannot be found.
---

# When it is not what autoport said

Start with the three commands that answer where a value came from, before changing anything:

```bash
autoport status          # every project on this machine, read-only
autoport why DATABASE_URL
autoport doctor          # what might be making autoport wrong
```

## Signatures

**A dev server binds the old port anyway.** The value never reached it. Either the task runner filtered it out (turbo strict env — `autoport skills get setup`), or something exports that variable ahead of autoport, which autoport reports as `PORT is already set to … in the environment`.

**A value disagrees with `.env`.** Expected: an exported value wins, a `.env` value loses, and autoport warns naming the file and line. Delete the line rather than silencing the warning.

**A container publishes the hardcoded port.** Something ran bare `docker compose` instead of `autoport compose`. Compose concatenates `ports` across files, so an override file cannot fix it — the whole model has to be rewritten, which is what `autoport compose` does.

**A container cannot be found to bring down.** Its project name changed. The name comes from the directory, so a renamed or moved checkout renames the stack; `docker ps -a --format '{{.Names}}'` finds the old one and `docker compose -p <old-name> down` removes it.

**A second run of the same project fails to start** with a message about the first server: a build-directory lock, not a port. See `autoport skills get runs`.

**A leased port is in use.** `"db" holds 40001, which is currently in use` is expected when your own stack is already running, and a real conflict otherwise. `autoport compose down` then `autoport release` returns it.

**A port autoport allocated collides with something stopped.** autoport skips ports that are listening and ports other autoport projects hold on lease. A non-autoport project that is currently **stopped** is in neither, so its hardcoded port is invisible. Pin yours with `services: { db: { fixed: true } }` if it must not move.

## TS2717 on a file autoport did not write

```
env.d.ts(3,28): error TS2717: Subsequent property declarations must have the same type.
  Property 'PORT' must be of type 'string', but here has type 'number'.
```

Another file already augments `NodeJS.ProcessEnv` and types a key autoport also
types. Both declarations merge, so they have to agree.

autoport types every environment value `string`, because that is what an
environment holds. A hand-written `PORT: number` is the usual culprit and the
usual fix: change it to `string` and coerce at the point of use,
`Number(process.env.PORT)`. Keys autoport knows nothing about are untouched, and
a file that already types them as strings — varlock's generated `env.d.ts`, for
one — merges with no change at all.

`AUTOPORT_TYPEGEN=0` stops autoport generating types at all, if the other file
has to win.

## The library says the config was not applied

A TypeScript config cannot be imported synchronously, so a cold library-only start warns and names the missing keys until an autoport command runs. Run any `autoport` command, or use `autoport.config.json`.

## Turning it off

`AUTOPORT=0` makes `resources` a plain view over `process.env` and nothing else. Under `NODE_ENV=production` a value already in the environment is returned without touching the filesystem.

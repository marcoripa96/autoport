---
name: runs
description: Running one project more than once at a time. Read when a second dev server, test suite or agent must run against the same checkout.
---

# Running one project twice

Start a second run while the first is serving and it takes a set of its own, without being told:

```
$ autoport            # web on 3000
$ autoport            # autoport: 3000 already serving — this run has its own ports
```

The second run mints an id, leases its own **host** ports against it, and gives them back when it exits. `--fresh` asks for that deliberately.

## A run moves its own processes, not the stack

Containers outlive the command that started them, so they stay on the project's ports under the project's name and both runs talk to the one database that is actually up. A run whose containers were named after it would leave a stack behind that nothing could later name to tear down.

For a second stack too, name it: `AUTOPORT_INSTANCE=e2e` moves everything, persists across runs, and is yours to bring down.

## One run per process tree

Only the outermost `autoport` decides. The id is exported as `AUTOPORT_RUN`, so nested calls join the run instead of splitting again — which is why the wrapper belongs at the top of a script (`autoport skills get setup`).

## Ports are not the only thing that collides

A framework holding an exclusive lock on its build directory refuses to start twice in one checkout however free the port is, and the error names the first *server* rather than the lock. Next.js on `.next/lock` is the common case:

```jsonc
"dev": "sh -c 'exec env ${AUTOPORT_RUN:+NEXT_DIST_DIR=.next-$AUTOPORT_RUN} next dev'"
```

Anything else a run holds exclusively — a socket path, a pidfile, a SQLite file, a browser profile — wants the same treatment. autoport leases ports; `AUTOPORT_RUN` is there to key the rest.

## What a run does not survive

A lease is released when the run exits, including on Ctrl-C. A `SIGKILL` or a crash leaves it to the six-hour reclaim. `autoport release` returns a project's ports by hand; it does not stop containers, so run `autoport compose down` first.

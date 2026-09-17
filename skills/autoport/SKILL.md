---
name: autoport
description: Conflict-free host ports for a local dev stack. Use when a dev server, database or compose service fails to bind because a port is taken, when two checkouts or worktrees of one repo must run at once, when the same project must run twice, when wiring a project's dev/test/compose scripts so ports are not hardcoded, or when DATABASE_URL, PORT or APP_URL must be read without writing a port number anywhere.
allowed-tools: Bash(autoport:*), Bash(npx autoport:*), Bash(bunx autoport:*)
---

# autoport

Leases every host port a project binds, keyed by the checkout's real path, and hands them over under the environment variable names the project already reads.

This file is a discovery stub, not the guide. The guide ships with the installed version, so it cannot go stale against the behaviour:

```bash
autoport skills get core     # read this before changing anything
```

Then load the one that matches the task:

```bash
autoport skills get setup            # wiring autoport into a project's scripts and config
autoport skills get runs             # running one project more than once at a time
autoport skills get troubleshooting  # a port, URL or container is not what you expected
```

`autoport skills list` shows what this version has.

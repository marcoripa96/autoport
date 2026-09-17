import { randomBytes } from "node:crypto";

/**
 * Which set of ports this process belongs to.
 *
 * Three ways a process can be in one, in order of precedence:
 *
 * - `AUTOPORT_INSTANCE` is a *named* set the user asked for, and it is stable
 *   across runs: `AUTOPORT_INSTANCE=e2e` means the same ports every time, which
 *   is what a long-lived side stack wants.
 * - `AUTOPORT_RUN` is an *anonymous* set minted by an outer `autoport`, and it
 *   is exported into the child environment. That is what makes a whole process
 *   tree — turbo, then bun, then varlock, then autoport again — agree on one
 *   set without consulting anything shared.
 * - Neither, and the ports are keyed by the directory, as they always were.
 */
export const currentInstance = (): string | undefined =>
  process.env.AUTOPORT_INSTANCE || process.env.AUTOPORT_RUN || undefined;

/** True when this process is inside a run some outer autoport already minted. */
export const inRun = (): boolean =>
  Boolean(process.env.AUTOPORT_INSTANCE || process.env.AUTOPORT_RUN);

/**
 * A fresh run id.
 *
 * Short because it ends up in container and volume names, and random rather
 * than sequential because two runs starting in the same millisecond must not
 * collide — the whole point is that nothing coordinates them.
 */
export const mintRun = (): string => `run-${randomBytes(4).toString("hex")}`;

/**
 * Is this an anonymous run, as opposed to a named instance?
 *
 * The distinction decides what a run gets to move. An anonymous run lasts
 * exactly as long as one command, so it may only take ports it will give back:
 * its own processes. Containers outlive it — `compose up -d` is the whole point
 * of `-d` — so they stay on the project's set, and two runs share one stack.
 * A *named* instance is the opposite: the user asked for a second stack and
 * will tear it down themselves, so it moves everything.
 */
export const isAnonymousRun = (): boolean =>
  !process.env.AUTOPORT_INSTANCE && Boolean(process.env.AUTOPORT_RUN);

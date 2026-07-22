// Atomic per-sid state file for overnight supervisors.
//
// One run = one file in <stateDir>/<sid>.json. The supervisor process owns
// writes; command handlers (status/stop) only read. We do not use a fancy
// store because the supervisor runs in a detached child — keep the wire
// format dead simple and inspectable by hand.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type OvernightPhase =
  | "starting"
  | "running"
  | "rate-limited-sleeping"
  | "completed"
  | "stopped"
  | "failed";

export type OvernightState = {
  sid: string;
  pid: number | null;
  phase: OvernightPhase;
  prompt: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  iterations: number;
  maxIterations: number;
  /** ISO timestamp the supervisor expects to wake when phase=rate-limited-sleeping. */
  resumeAt: string | null;
  /** Short, last-known human-readable status; populated on each phase change. */
  lastEvent: string;
  /** Final transcript reply text (truncated) on completion, or last stderr on failure. */
  finalText: string | null;
};

export function resolveStateDir(projectCwd: string, override: string | undefined): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return path.join(projectCwd, ".openclaw", "overnight");
}

export function stateFilePath(stateDir: string, sid: string): string {
  return path.join(stateDir, `${sid}.json`);
}

export function ensureStateDir(stateDir: string): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

export function writeStateAtomic(stateDir: string, state: OvernightState): void {
  ensureStateDir(stateDir);
  const final = stateFilePath(stateDir, state.sid);
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, final);
}

export function readState(stateDir: string, sid: string): OvernightState | null {
  const file = stateFilePath(stateDir, sid);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const text = readFileSync(file, "utf8");
    return JSON.parse(text) as OvernightState;
  } catch {
    return null;
  }
}

export function listStates(stateDir: string): OvernightState[] {
  if (!existsSync(stateDir)) {
    return [];
  }
  const out: OvernightState[] = [];
  for (const name of readdirSync(stateDir)) {
    if (!name.endsWith(".json") || name.includes(".tmp.")) {
      continue;
    }
    const sid = name.slice(0, -5);
    const s = readState(stateDir, sid);
    if (s) {
      out.push(s);
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

export function isActivePhase(p: OvernightPhase): boolean {
  return p === "starting" || p === "running" || p === "rate-limited-sleeping";
}

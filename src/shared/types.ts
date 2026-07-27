/** Penalty applied to a solve. `plus2` adds 2000ms; `dnf` invalidates it. */
export type Penalty = "none" | "plus2" | "dnf";

/** WCA event IDs that cubing.js can scramble for. */
export type EventId = "222" | "333" | "444" | "555" | "666" | "777";

export interface Session {
  id: number;
  name: string;
  /** Scrambler to use. 3x3 and 3x3 OH both use "333" — OH is a session, not a scramble type. */
  eventId: EventId;
  position: number;
  createdAt: number;
}

export interface Solve {
  id: number;
  sessionId: number;
  /** Raw measured time in ms, *before* any penalty is applied. */
  ms: number;
  penalty: Penalty;
  scramble: string;
  comment: string;
  startedAt: number;
}

export interface NewSolve {
  sessionId: number;
  ms: number;
  penalty: Penalty;
  scramble: string;
  startedAt: number;
}

/**
 * Per-session scramble history.
 *
 * WCA random-state scrambles cannot be re-derived from a seed (cubing.js has
 * no seeding API), so "previous scramble" is implemented as a stored list plus
 * a cursor rather than by rewinding a PRNG.
 */
export interface ScrambleState {
  queue: string[];
  cursor: number;
}

/**
 * Backdrop for the timer area. Either a built-in preset id (`none`, `rainier`,
 * `colchuck`, `storm-king`) or `custom:<file name>` for a user-imported image.
 * Kept as a plain string because the custom set is open-ended.
 */
export type TimerBackgroundId = string;

/** Prefix distinguishing a user-imported background from a built-in preset. */
export const CUSTOM_BACKGROUND_PREFIX = "custom:";

/** An image the user imported, stored under userData/backgrounds/. */
export interface UserBackground {
  /** File name on disk, which is also its stable id. */
  id: string;
  /** File name without extension, shown in the dropdown. */
  label: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Settings {
  inspection: boolean;
  /** How long space must be held before the timer arms, in ms. */
  holdMs: number;
  /** Hide the running time while solving. */
  hideTimeWhileSolving: boolean;
  lastSessionId: number | null;
  timerBackground: TimerBackgroundId;
  /** Where the window was last placed; null until the window is first moved. */
  windowBounds: WindowBounds | null;
  windowMaximized: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  inspection: false,
  holdMs: 550,
  hideTimeWhileSolving: false,
  lastSessionId: null,
  timerBackground: "rainier",
  windowBounds: null,
  windowMaximized: false,
};

/**
 * A solve as it appears in an export: the stored fields, plus the rolling
 * averages *as computed at export time*.
 *
 * These are a snapshot, not a source of truth. The database deliberately does
 * not store averages — one retroactive +2 changes up to 100 of them at once,
 * so any persisted copy would immediately be wrong.
 *
 * `null` means the average is a DNF; `null`-vs-absent is distinguished by
 * `undefined` (omitted from JSON), which means there weren't enough solves yet.
 */
export interface ExportedSolve {
  index: number;
  scramble: string;
  /** Raw measured time in ms, before penalties. */
  ms: number;
  penalty: Penalty;
  /** Time with the penalty applied, or null for a DNF. */
  effectiveMs: number | null;
  ao5?: number | null;
  ao12?: number | null;
  ao100?: number | null;
  comment: string;
  startedAt: number;
}

export interface ExportBundle {
  format: "cubetimer";
  version: 1;
  exportedAt: number;
  sessions: Array<{
    name: string;
    eventId: EventId;
    createdAt: number;
    solveCount: number;
    solves: ExportedSolve[];
  }>;
}

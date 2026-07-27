import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  EventId,
  ExportBundle,
  NewSolve,
  Penalty,
  ScrambleState,
  Session,
  Settings,
  Solve,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { effective, trailingAverageAt } from "../shared/averages.js";
import { trimHistory } from "../shared/scramble-history.js";

let db: DatabaseSync;

const DEFAULT_SESSIONS: Array<{ name: string; eventId: EventId }> = [
  { name: "2x2", eventId: "222" },
  { name: "3x3", eventId: "333" },
  { name: "3x3 OH", eventId: "333" },
  { name: "4x4", eventId: "444" },
  { name: "5x5", eventId: "555" },
  { name: "6x6", eventId: "666" },
  { name: "7x7", eventId: "777" },
];

export function openDb(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "cubetimer.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      event_id   TEXT    NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS solve (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      ms         INTEGER NOT NULL,
      penalty    TEXT    NOT NULL DEFAULT 'none',
      scramble   TEXT    NOT NULL DEFAULT '',
      comment    TEXT    NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS solve_session_idx ON solve(session_id, id);

    CREATE TABLE IF NOT EXISTS scramble_state (
      session_id INTEGER PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
      queue      TEXT    NOT NULL DEFAULT '[]',
      cursor     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS setting (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  seedSessions();
}

function seedSessions(): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare(
    "INSERT INTO session (name, event_id, position, created_at) VALUES (?, ?, ?, ?)",
  );
  const now = Date.now();
  DEFAULT_SESSIONS.forEach((s, i) => insert.run(s.name, s.eventId, i, now));
}

interface SessionRow {
  id: number;
  name: string;
  event_id: string;
  position: number;
  created_at: number;
}

interface SolveRow {
  id: number;
  session_id: number;
  ms: number;
  penalty: string;
  scramble: string;
  comment: string;
  started_at: number;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  name: r.name,
  eventId: r.event_id as EventId,
  position: r.position,
  createdAt: r.created_at,
});

const toSolve = (r: SolveRow): Solve => ({
  id: r.id,
  sessionId: r.session_id,
  ms: r.ms,
  penalty: r.penalty as Penalty,
  scramble: r.scramble,
  comment: r.comment,
  startedAt: r.started_at,
});

/* ------------------------------- sessions ------------------------------- */

export function listSessions(): Session[] {
  const rows = db
    .prepare("SELECT * FROM session ORDER BY position, id")
    .all() as unknown as SessionRow[];
  return rows.map(toSession);
}

/** Solve count per session id, for the sidebar. */
export function sessionCounts(): Record<number, number> {
  const rows = db
    .prepare("SELECT session_id, COUNT(*) AS n FROM solve GROUP BY session_id")
    .all() as unknown as Array<{ session_id: number; n: number }>;
  const out: Record<number, number> = {};
  for (const r of rows) out[r.session_id] = r.n;
  return out;
}

export function createSession(name: string, eventId: EventId): Session {
  const { maxPos } = db.prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM session").get() as {
    maxPos: number;
  };
  const info = db
    .prepare("INSERT INTO session (name, event_id, position, created_at) VALUES (?, ?, ?, ?)")
    .run(name, eventId, maxPos + 1, Date.now());
  const row = db
    .prepare("SELECT * FROM session WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as SessionRow;
  return toSession(row);
}

/**
 * Only the label is mutable. A session's scrambler is fixed at creation — a
 * "4x4" session whose event could be flipped to 333 would silently invalidate
 * every average it has already accumulated.
 */
export function renameSession(id: number, name: string): void {
  db.prepare("UPDATE session SET name = ? WHERE id = ?").run(name, id);
}

export function deleteSession(id: number): void {
  db.prepare("DELETE FROM session WHERE id = ?").run(id);
}

export function clearSession(id: number): void {
  db.prepare("DELETE FROM solve WHERE session_id = ?").run(id);
}

/* -------------------------------- solves -------------------------------- */

export function listSolves(sessionId: number): Solve[] {
  const rows = db
    .prepare("SELECT * FROM solve WHERE session_id = ? ORDER BY id")
    .all(sessionId) as unknown as SolveRow[];
  return rows.map(toSolve);
}

export function addSolve(s: NewSolve): Solve {
  const info = db
    .prepare(
      `INSERT INTO solve (session_id, ms, penalty, scramble, comment, started_at)
       VALUES (?, ?, ?, ?, '', ?)`,
    )
    .run(s.sessionId, Math.round(s.ms), s.penalty, s.scramble, s.startedAt);
  const row = db
    .prepare("SELECT * FROM solve WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as SolveRow;
  return toSolve(row);
}

export function updateSolve(id: number, patch: { penalty?: Penalty; comment?: string }): void {
  if (patch.penalty !== undefined) {
    db.prepare("UPDATE solve SET penalty = ? WHERE id = ?").run(patch.penalty, id);
  }
  if (patch.comment !== undefined) {
    db.prepare("UPDATE solve SET comment = ? WHERE id = ?").run(patch.comment, id);
  }
}

export function deleteSolve(id: number): void {
  db.prepare("DELETE FROM solve WHERE id = ?").run(id);
}

/* ---------------------------- scramble state ---------------------------- */

export function getScrambleState(sessionId: number): ScrambleState {
  const row = db
    .prepare("SELECT queue, cursor FROM scramble_state WHERE session_id = ?")
    .get(sessionId) as { queue: string; cursor: number } | undefined;
  if (!row) return { queue: [], cursor: 0 };
  try {
    const queue = JSON.parse(row.queue) as string[];
    return { queue: Array.isArray(queue) ? queue : [], cursor: row.cursor };
  } catch {
    return { queue: [], cursor: 0 };
  }
}

export function setScrambleState(sessionId: number, state: ScrambleState): ScrambleState {
  // The renderer trims before sending; re-apply here so the stored bound holds
  // regardless of what arrives.
  const { queue, cursor } = trimHistory(state);
  db.prepare(
    `INSERT INTO scramble_state (session_id, queue, cursor) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET queue = excluded.queue, cursor = excluded.cursor`,
  ).run(sessionId, JSON.stringify(queue), cursor);
  return { queue, cursor };
}

/* ------------------------------- settings ------------------------------- */

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM setting").all() as unknown as Array<{
    key: string;
    value: string;
  }>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    try {
      if (key in DEFAULT_SETTINGS) {
        (out as unknown as Record<string, unknown>)[key] = JSON.parse(value);
      }
    } catch {
      /* ignore malformed rows */
    }
  }
  return out;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
  return getSettings();
}

/* -------------------------------- export -------------------------------- */

export function exportAll(): ExportBundle {
  return {
    format: "cubetimer",
    version: 1,
    exportedAt: Date.now(),
    sessions: listSessions().map((s) => {
      const solves = listSolves(s.id);
      const times = solves.map(effective);
      return {
        name: s.name,
        eventId: s.eventId,
        createdAt: s.createdAt,
        solveCount: solves.length,
        // Averages are computed here, at export time, from the current state of
        // the session — they are a snapshot, never stored back to the database.
        solves: solves.map((solve, i) => ({
          index: i + 1,
          scramble: solve.scramble,
          ms: solve.ms,
          penalty: solve.penalty,
          effectiveMs: times[i]!,
          ao5: trailingAverageAt(times, i, 5),
          ao12: trailingAverageAt(times, i, 12),
          ao100: trailingAverageAt(times, i, 100),
          comment: solve.comment,
          startedAt: solve.startedAt,
        })),
      };
    }),
  };
}

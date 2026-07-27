import { randomScrambleForEvent } from "cubing/scramble";
import { setSearchDebug } from "cubing/search";
import { trimHistory } from "../shared/scramble-history.js";
import type { EventId } from "../shared/types.js";

// We bundle with esbuild + code splitting, so go straight to the strategy that
// works instead of letting cubing.js fail an `import.meta.resolve` attempt
// first (which logs a spurious ERR_FILE_NOT_FOUND on every cold start).
setSearchDebug({
  prioritizeEsbuildWorkaroundForWorkerInstantiation: true,
  showWorkerInstantiationWarnings: false,
  // cubing.js otherwise logs a timing line per scramble, which buries anything
  // of ours in the devtools console.
  logPerf: false,
});

/** How many unseen scrambles to keep generated ahead of the cursor. */
const BUFFER_AHEAD = 2;

/**
 * A per-session scramble history with a cursor.
 *
 * cubing.js has no scramble seeding API, so past scrambles cannot be
 * re-derived — they are kept in a list and persisted. "Previous" moves the
 * cursor back; it never regenerates.
 */
export class ScrambleQueue {
  private queue: string[] = [];
  private cursor = 0;
  /** Bumped on every session switch so in-flight generations can be discarded. */
  private epoch = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private sessionId: number,
    private eventId: EventId,
    private onChange: () => void,
  ) {}

  current(): string | null {
    return this.queue[this.cursor] ?? null;
  }

  /** Position within the stored history, 1-indexed, for the "#3 / 7" readout. */
  position(): { index: number; total: number } {
    return { index: this.queue.length ? this.cursor + 1 : 0, total: this.queue.length };
  }

  hasPrev(): boolean {
    return this.cursor > 0;
  }

  /** Switch to a different session, reloading its stored history. */
  async load(sessionId: number, eventId: EventId): Promise<void> {
    this.epoch++;
    const epoch = this.epoch;
    this.sessionId = sessionId;
    this.eventId = eventId;

    // Blank immediately: showing the previous session's scramble while the new
    // one loads means displaying a 3x3 scramble on a 7x7 session.
    this.queue = [];
    this.cursor = 0;
    this.onChange();

    const state = await window.api.getScrambleState(sessionId);
    if (epoch !== this.epoch) return;

    this.queue = state.queue;
    this.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, this.queue.length - 1));
    this.onChange();

    if (this.queue.length === 0) await this.generateInto(epoch);
    this.onChange();
    void this.fillBuffer(epoch);
  }

  /** Advance to the next scramble, generating one if we've run off the end. */
  async next(): Promise<void> {
    const epoch = this.epoch;
    if (this.cursor + 1 >= this.queue.length) {
      await this.generateInto(epoch);
      if (epoch !== this.epoch) return;
    }
    if (this.cursor + 1 < this.queue.length) this.cursor++;
    this.onChange();
    this.persist();
    void this.fillBuffer(epoch);
  }

  /** Step back through already-seen scrambles. */
  prev(): void {
    if (this.cursor === 0) return;
    this.cursor--;
    this.onChange();
    this.persist();
  }

  /**
   * Replace the current scramble with a freshly generated one.
   * Useful when you want a different scramble without recording a solve.
   */
  async reroll(): Promise<void> {
    const epoch = this.epoch;
    const alg = await randomScrambleForEvent(this.eventId);
    if (epoch !== this.epoch) return;
    this.queue[this.cursor] = alg.toString();
    this.onChange();
    this.persist();
  }

  /**
   * Serialise generation so a burst of `next()` presses doesn't spawn a pile of
   * concurrent random-state searches (4x4 in particular is not cheap).
   */
  private generateInto(epoch: number): Promise<void> {
    const task = this.chain.then(async () => {
      if (epoch !== this.epoch) return;
      const alg = await randomScrambleForEvent(this.eventId);
      if (epoch !== this.epoch) return;
      this.queue.push(alg.toString());
    });
    this.chain = task.catch(() => {});
    return task;
  }

  private async fillBuffer(epoch: number): Promise<void> {
    while (epoch === this.epoch && this.queue.length - this.cursor - 1 < BUFFER_AHEAD) {
      await this.generateInto(epoch);
      if (epoch !== this.epoch) return;
      this.onChange();
    }
    this.persist();
  }

  /** Trim here rather than adopting the main process's reply, which would race with generation. */
  private persist(): void {
    const trimmed = trimHistory({ queue: this.queue, cursor: this.cursor });
    this.queue = trimmed.queue;
    this.cursor = trimmed.cursor;
    void window.api.setScrambleState(this.sessionId, trimmed);
  }
}

import type { ScrambleState } from "./types.js";

/**
 * How many already-seen scrambles to keep behind the cursor.
 *
 * This bounds how far `←` can rewind. It does not affect solve history: every
 * solve stores its own scramble string, so trimming here never loses the
 * scramble that a recorded solve was done on.
 */
export const MAX_HISTORY_BEHIND = 2;

/**
 * Drop scrambles that have fallen further than `MAX_HISTORY_BEHIND` behind the
 * cursor, keeping the cursor pointing at the same scramble.
 *
 * Entries *ahead* of the cursor are left alone — those are the prefetch buffer,
 * not history.
 */
export function trimHistory(state: ScrambleState): ScrambleState {
  const { queue, cursor } = state;
  if (cursor <= MAX_HISTORY_BEHIND) return state;
  return {
    queue: queue.slice(cursor - MAX_HISTORY_BEHIND),
    cursor: MAX_HISTORY_BEHIND,
  };
}

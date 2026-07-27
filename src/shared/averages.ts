import type { Solve } from "./types.js";

/**
 * Effective time of a solve in ms, or `null` for a DNF.
 * A +2 adds 2000ms on top of the raw measured time.
 */
export function effective(solve: Pick<Solve, "ms" | "penalty">): number | null {
  if (solve.penalty === "dnf") return null;
  return solve.ms + (solve.penalty === "plus2" ? 2000 : 0);
}

/** WCA 9f5: trim the best and worst 5%, rounded up, at least one from each end. */
function trimCount(n: number): number {
  return Math.max(1, Math.ceil(n * 0.05));
}

/**
 * WCA average of a window of times (`null` = DNF), or `null` if the average
 * itself is a DNF.
 *
 * Under 5 solves this is a plain mean with no trimming, so a single DNF spoils
 * it (mo3 behaviour). At 5 and above, one DNF is absorbed by the trim; a second
 * makes the whole average a DNF.
 */
export function wcaAverage(times: Array<number | null>): number | null {
  const n = times.length;
  if (n === 0) return null;
  if (n < 5) {
    if (times.some((t) => t === null)) return null;
    return (times as number[]).reduce((a, b) => a + b, 0) / n;
  }
  const trim = trimCount(n);
  if (times.filter((t) => t === null).length > trim) return null;
  const sorted = times.map((t) => t ?? Infinity).sort((a, b) => a - b);
  const kept = sorted.slice(trim, n - trim);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/**
 * The trailing average of `n` ending at index `i`, or `undefined` when there
 * aren't yet `n` solves to average.
 */
export function trailingAverageAt(
  times: Array<number | null>,
  i: number,
  n: number,
): number | null | undefined {
  if (i + 1 < n) return undefined;
  return wcaAverage(times.slice(i + 1 - n, i + 1));
}

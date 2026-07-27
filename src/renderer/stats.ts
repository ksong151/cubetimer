import { effective, trailingAverageAt, wcaAverage } from "../shared/averages.js";
import type { Solve } from "../shared/types.js";

export { wcaAverage };

/** Average over the most recent `n` solves, or `undefined` if there aren't enough yet. */
export function trailingAverage(solves: Solve[], n: number): number | null | undefined {
  return trailingAverageAt(solves.map(effective), solves.length - 1, n);
}

/** Best average of `n` over every window in the session. */
export function bestAverage(solves: Solve[], n: number): number | null | undefined {
  if (solves.length < n) return undefined;
  const times = solves.map(effective);
  let best: number | null = null;
  for (let i = 0; i + n <= times.length; i++) {
    const avg = wcaAverage(times.slice(i, i + n));
    if (avg !== null && (best === null || avg < best)) best = avg;
  }
  return best;
}

export interface SessionStats {
  count: number;
  solved: number;
  best: number | null;
  worst: number | null;
  mean: number | null;
  ao5: number | null | undefined;
  ao12: number | null | undefined;
  ao100: number | null | undefined;
  bestAo5: number | null | undefined;
  bestAo12: number | null | undefined;
  bestAo100: number | null | undefined;
}

export function sessionStats(solves: Solve[]): SessionStats {
  const valid = solves.map(effective).filter((t): t is number => t !== null);
  return {
    count: solves.length,
    solved: valid.length,
    best: valid.length ? Math.min(...valid) : null,
    worst: valid.length ? Math.max(...valid) : null,
    mean: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    ao5: trailingAverage(solves, 5),
    ao12: trailingAverage(solves, 12),
    ao100: trailingAverage(solves, 100),
    bestAo5: bestAverage(solves, 5),
    bestAo12: bestAverage(solves, 12),
    bestAo100: bestAverage(solves, 100),
  };
}

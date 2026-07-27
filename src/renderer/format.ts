import type { Penalty, Solve } from "../shared/types.js";

export { effective } from "../shared/averages.js";

/** WCA results are truncated (not rounded) to centiseconds. */
export function formatMs(ms: number | null): string {
  if (ms === null) return "DNF";
  const cs = Math.floor(ms / 10);
  const totalSeconds = Math.floor(cs / 100);
  const hundredths = cs % 100;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frac = String(hundredths).padStart(2, "0");
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}.${frac}`;
  return `${seconds}.${frac}`;
}

/** Formats an average, which is rounded rather than truncated. */
export function formatAvg(ms: number | null): string {
  if (ms === null) return "DNF";
  return formatMs(Math.round(ms / 10) * 10);
}

/** Solve time with its penalty marker, e.g. "12.34+" or "DNF(12.34)". */
export function formatSolve(solve: Solve): string {
  if (solve.penalty === "dnf") return `DNF(${formatMs(solve.ms)})`;
  if (solve.penalty === "plus2") return `${formatMs(solve.ms + 2000)}+`;
  return formatMs(solve.ms);
}

export const penaltyLabel: Record<Penalty, string> = {
  none: "OK",
  plus2: "+2",
  dnf: "DNF",
};

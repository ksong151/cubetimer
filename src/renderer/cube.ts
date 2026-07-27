import type { PuzzleID, TwistyPlayer } from "cubing/twisty";
import type { EventId } from "../shared/types.js";

/**
 * The standard scrambling view: white U on top, green F toward the viewer,
 * matching how a scramble is meant to be applied (WCA 4d1).
 *
 * Longitude 0 looks straight down the U/F edge, so only those two faces are
 * visible — the left and right faces sit exactly edge-on. A non-zero longitude
 * would swing round to expose R as well.
 */
const DEFAULT_LATITUDE = 35;
const DEFAULT_LONGITUDE = 0;

const PUZZLE_FOR_EVENT: Record<EventId, PuzzleID> = {
  "222": "2x2x2",
  "333": "3x3x3",
  "444": "4x4x4",
  "555": "5x5x5",
  "666": "6x6x6",
  "777": "7x7x7",
};

let host: HTMLElement | null = null;
let player: TwistyPlayer | null = null;
let loading = false;

/** Latest requested state; may arrive before the player has finished loading. */
let wanted: { puzzle: PuzzleID; scramble: string } | null = null;
/** What the player is currently showing, so we skip redundant writes. */
let appliedPuzzle: PuzzleID | null = null;
let appliedScramble: string | null = null;

export function mountCube(container: HTMLElement): void {
  host = container;
}

/**
 * Point the 3D view at a scramble. Safe to call on every render — redundant
 * calls are dropped, and the heavy `cubing/twisty` import happens once, lazily,
 * so app startup never pays for it.
 */
export function updateCube(eventId: EventId, scramble: string | null): void {
  wanted = { puzzle: PUZZLE_FOR_EVENT[eventId], scramble: scramble ?? "" };
  if (player) apply();
  else void load();
}

/**
 * Hide the view while a solve is running. The renderer is already
 * scheduler-driven and idles on a static cube, but taking it out of the layout
 * guarantees it cannot compete with the timer for frames.
 */
export function setCubeHidden(hidden: boolean): void {
  host?.classList.toggle("hidden", hidden);
}

async function load(): Promise<void> {
  if (loading || !host) return;
  loading = true;
  try {
    const { TwistyPlayer } = await import("cubing/twisty");
    if (!wanted || !host) return;
    player = new TwistyPlayer({
      puzzle: wanted.puzzle,
      experimentalSetupAlg: wanted.scramble,
      // The scramble is the *setup*; there is no move sequence to animate.
      alg: "",
      background: "none",
      controlPanel: "none",
      hintFacelets: "none",
      // 3x3x3 defaults to the bespoke "3D" renderer, which draws a translucent
      // body you can see through. PG3D — what every other size already uses —
      // renders solid, so forcing it here keeps all events looking the same.
      visualization: "PG3D",
      // Default vertical limit is 35°, which barely lets you tilt. 90° reaches
      // straight over the top and bottom, so every face is reachable.
      cameraLatitudeLimit: 90,
      // Pin the opening view explicitly: the "auto" default varies by renderer
      // strategy, and reusing one player across puzzle changes makes it vary in
      // practice too. apply() restores these on every scramble change.
      cameraLatitude: DEFAULT_LATITUDE,
      cameraLongitude: DEFAULT_LONGITUDE,
      // These two must be set together. TwistyOrbitControls is built *on top of*
      // the drag tracker, so `dragInput: "none"` would disable rotating as well
      // as twisting. Keep dragging on, and disable move-presses instead — that
      // leaves drag-to-rotate working while making it impossible to twist the
      // cube out of sync with the scramble text above it.
      experimentalDragInput: "auto",
      experimentalMovePressInput: "none",
    });
    appliedPuzzle = wanted.puzzle;
    appliedScramble = wanted.scramble;
    host.replaceChildren(player);
    apply();
  } catch (err) {
    // A missing 3D view should never take the timer down with it.
    console.error("3D cube failed to load", err);
    host?.replaceChildren();
  } finally {
    loading = false;
  }
}

function apply(): void {
  if (!player || !wanted) return;
  let changed = false;
  if (wanted.puzzle !== appliedPuzzle) {
    player.puzzle = wanted.puzzle;
    appliedPuzzle = wanted.puzzle;
    changed = true;
  }
  if (wanted.scramble !== appliedScramble) {
    player.experimentalSetupAlg = wanted.scramble;
    appliedScramble = wanted.scramble;
    changed = true;
  }
  // A new scramble is a fresh inspection, so start it from the orientation the
  // scramble assumes (white on top, green in front) rather than wherever the
  // previous scramble was left rotated to.
  if (changed) resetOrientation();
}

/** Return the camera to the standard scrambling view. */
export function resetOrientation(): void {
  if (!player) return;
  player.cameraLatitude = DEFAULT_LATITUDE;
  player.cameraLongitude = DEFAULT_LONGITUDE;
}

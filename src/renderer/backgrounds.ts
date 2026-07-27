import { CUSTOM_BACKGROUND_PREFIX } from "../shared/types.js";
import type { TimerBackgroundId, UserBackground } from "../shared/types.js";

export interface BackgroundOption {
  id: TimerBackgroundId;
  label: string;
  /** Path relative to the renderer root, or null for the plain cream panel. */
  url: string | null;
  /** Built-in presets can't be deleted; imported images can. */
  removable: boolean;
}

/**
 * Built-in presets.
 *
 * To add one: drop the file into `src/renderer/assets/` (the build copies that
 * directory automatically) and add an entry here. The dropdown is generated
 * from this list plus whatever the user has imported.
 */
const PRESETS: BackgroundOption[] = [
  { id: "none", label: "Plain — no image", url: null, removable: false },
  { id: "rainier", label: "Mount Rainier", url: "assets/rainier.jpeg", removable: false },
  { id: "colchuck", label: "Colchuck Lake", url: "assets/colchuck.jpeg", removable: false },
  { id: "storm-king", label: "Mount Storm King", url: "assets/storm-king.jpg", removable: false },
];

let custom: BackgroundOption[] = [];

/** User-imported images are served from userData via the app:// handler. */
function toOption(bg: UserBackground): BackgroundOption {
  return {
    id: CUSTOM_BACKGROUND_PREFIX + bg.id,
    label: bg.label,
    url: `user-backgrounds/${encodeURIComponent(bg.id)}`,
    removable: true,
  };
}

export function setUserBackgrounds(list: UserBackground[]): void {
  custom = list.map(toOption);
}

export function allBackgrounds(): BackgroundOption[] {
  return [...PRESETS, ...custom];
}

export function findBackground(id: TimerBackgroundId): BackgroundOption | undefined {
  return allBackgrounds().find((b) => b.id === id);
}

export function isCustom(id: TimerBackgroundId): boolean {
  return id.startsWith(CUSTOM_BACKGROUND_PREFIX);
}

/**
 * Apply a background. An unknown id falls back to the plain panel — which is
 * what happens if the image behind a saved custom background was deleted.
 */
export function applyTimerBackground(id: TimerBackgroundId): void {
  const preset = findBackground(id) ?? PRESETS[0]!;
  document.documentElement.style.setProperty(
    "--timer-bg",
    preset.url ? `url("${preset.url}")` : "none",
  );
}

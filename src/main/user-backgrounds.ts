import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { UserBackground } from "../shared/types.js";

const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

/**
 * User-imported backgrounds live in userData, not in the app bundle: the bundle
 * is read-only once packaged, and anything written there would be wiped by the
 * next build or update.
 */
export function userBackgroundsDir(): string {
  return path.join(app.getPath("userData"), "backgrounds");
}

/** Resolve a stored file name to an absolute path, refusing anything outside the directory. */
export function resolveUserBackground(name: string): string | null {
  const dir = userBackgroundsDir();
  const target = path.join(dir, path.basename(name));
  return target.startsWith(dir + path.sep) ? target : null;
}

const labelFor = (fileName: string) => path.basename(fileName, path.extname(fileName));

export function listUserBackgrounds(): UserBackground[] {
  const dir = userBackgroundsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ALLOWED_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ id: e.name, label: labelFor(e.name) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Pick a file name that doesn't collide with an existing import. */
function uniqueName(dir: string, original: string): string {
  const ext = path.extname(original).toLowerCase();
  // Strip anything that could confuse a URL or escape the directory.
  const base = path.basename(original, path.extname(original)).replace(/[^\w -]+/g, "").trim() || "image";
  let candidate = base + ext;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base}-${i}${ext}`;
  return candidate;
}

/** Prompt for an image and copy it into the backgrounds directory. */
export async function addUserBackground(): Promise<UserBackground | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Add a timer background",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "avif"] }],
  });
  const source = filePaths[0];
  if (canceled || !source) return null;
  if (!ALLOWED_EXTENSIONS.has(path.extname(source).toLowerCase())) return null;

  const dir = userBackgroundsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = uniqueName(dir, path.basename(source));
  fs.copyFileSync(source, path.join(dir, name));
  return { id: name, label: labelFor(name) };
}

/** Delete an imported background. Presets are not stored here, so they can't be hit. */
export function deleteUserBackground(id: string): boolean {
  const target = resolveUserBackground(id);
  if (!target || !fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}

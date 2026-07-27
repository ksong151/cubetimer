/**
 * Dev supervisor: rebuild on save, and get the change on screen without
 * relaunching by hand.
 *
 *   src/renderer/styles.css  → hot-swapped into the live window (state kept)
 *   src/renderer/*.ts|.html  → window reloads
 *   src/main/*.ts            → Electron restarts (it's a new process)
 *
 * Run with `npm run dev`.
 */
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import electronPath from "electron";
import { copyStatic, mainOptions, rendererOptions, root } from "../build.mjs";

const MAIN_OUT = path.join(root, "dist/main");
const RENDERER_SRC = path.join(root, "src/renderer");

let electron = null;
let restarting = false;

/** Extra flags after `npm run dev --` are passed through to Electron. */
const passthrough = process.argv.slice(2);

function launch() {
  electron = spawn(electronPath, [root, "--dev", ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, CUBETIMER_DEV: "1" },
  });
  electron.on("exit", (code) => {
    // A restart we asked for; anything else means the user quit the app.
    if (restarting) return;
    console.log(`\nelectron exited (${code}) — stopping dev server`);
    process.exit(code ?? 0);
  });
}

function restart() {
  if (!electron || restarting) return;
  restarting = true;
  console.log("\x1b[36m[dev]\x1b[0m main process changed — restarting electron");
  electron.once("exit", () => {
    restarting = false;
    launch();
  });
  electron.kill();
}

// Debounce: one save triggers many file writes across esbuild's output chunks.
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const onMainChange = debounce(restart, 150);

async function main() {
  await fs.promises.rm(path.join(root, "dist"), { recursive: true, force: true });

  const [mainCtx, rendererCtx] = await Promise.all([
    esbuild.context({ ...mainOptions, logLevel: "warning" }),
    esbuild.context({ ...rendererOptions, logLevel: "warning" }),
  ]);
  await Promise.all([mainCtx.rebuild(), rendererCtx.rebuild()]);
  await Promise.all([mainCtx.watch(), rendererCtx.watch()]);

  // styles.css and index.html are copied, not bundled, so esbuild's watcher
  // never sees them change. Watch the sources directly.
  fs.watch(RENDERER_SRC, { recursive: true }, (_event, filename) => {
    if (filename && /\.(css|html|png|jpe?g|svg|webp|gif)$/i.test(filename)) copyStatic();
  });

  // Electron itself watches dist/renderer and reloads; we only need to catch
  // main/preload rebuilds here, which require a fresh process.
  fs.watch(MAIN_OUT, (_event, filename) => {
    if (filename?.endsWith(".js")) onMainChange();
  });

  console.log("\x1b[36m[dev]\x1b[0m watching src/ — edit and save to see changes");
  launch();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restarting = true;
    electron?.kill();
    process.exit(0);
  });
}

main();

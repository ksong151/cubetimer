import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.dirname(fileURLToPath(import.meta.url));

/** Static renderer assets that are copied rather than bundled. */
export const STATIC_FILES = ["index.html", "styles.css"];

/**
 * Copy a file only if the contents differ.
 *
 * Skipping no-op writes matters for more than speed: a redundant write to
 * index.html (or anything under assets/) makes the dev watcher classify a
 * CSS-only edit as "not CSS" and do a full page reload, throwing away the state
 * a CSS hot-swap would have preserved.
 */
function copyIfChanged(src, dest) {
  const next = fs.readFileSync(src);
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(next)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next);
}

export function copyStatic() {
  const outDir = path.join(root, "dist/renderer");
  const srcDir = path.join(root, "src/renderer");
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of STATIC_FILES) {
    copyIfChanged(path.join(srcDir, f), path.join(outDir, f));
  }
  // Images and anything else dropped into src/renderer/assets/.
  const assetsSrc = path.join(srcDir, "assets");
  const assetsOut = path.join(outDir, "assets");
  const wanted = new Set();
  if (fs.existsSync(assetsSrc)) {
    for (const entry of fs.readdirSync(assetsSrc, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      wanted.add(entry.name);
      copyIfChanged(path.join(assetsSrc, entry.name), path.join(assetsOut, entry.name));
    }
  }
  // Prune assets that were renamed or deleted upstream, so a removed image
  // doesn't linger in the build (and ship inside the packaged app).
  if (fs.existsSync(assetsOut)) {
    for (const name of fs.readdirSync(assetsOut)) {
      if (!wanted.has(name)) fs.rmSync(path.join(assetsOut, name), { force: true });
    }
  }
}

const staticPlugin = {
  name: "copy-static",
  setup(build) {
    build.onEnd(() => copyStatic());
  },
};

// Main + preload: CommonJS for Electron's node side.
export const mainOptions = {
  entryPoints: ["src/main/main.ts", "src/main/preload.ts"],
  outdir: "dist/main",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  // Electron and node builtins must stay external.
  external: ["electron", "node:sqlite"],
};

// Renderer: ESM for Chromium.
//
// `splitting` is REQUIRED, not a preference. cubing.js loads its search worker
// via `await import("./search-worker-entry.js")` and reads that module's
// `import.meta.url` to get the worker URL. Without splitting, esbuild inlines
// that import into the main bundle, so the "worker URL" becomes the app bundle
// itself — the worker then boots the whole UI and dies with `window is not
// defined`. With splitting, the entry lands in its own chunk with a real URL.
export const rendererOptions = {
  entryPoints: ["src/renderer/index.ts"],
  outdir: "dist/renderer",
  bundle: true,
  splitting: true,
  platform: "browser",
  format: "esm",
  target: "esnext",
  sourcemap: true,
  logLevel: "info",
  plugins: [staticPlugin],
};

// Only run a build when invoked directly (`node build.mjs`); importing this
// module from scripts/dev.mjs should just hand over the options.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--watch")) {
    const ctxs = await Promise.all([
      esbuild.context(mainOptions),
      esbuild.context(rendererOptions),
    ]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("watching...");
  } else {
    await Promise.all([esbuild.build(mainOptions), esbuild.build(rendererOptions)]);
    console.log("build complete");
  }
}

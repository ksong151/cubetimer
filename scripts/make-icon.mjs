/**
 * Render the app icon: a solved 3x3 drawn by the same cubing.js engine the app
 * uses, sitting on a rounded cream square in the alpine palette.
 *
 *   npm run icon
 *
 * Writes build/icon.png (1024x1024, transparent outside the rounded square).
 * electron-builder picks that up automatically and derives .icns / .ico from it.
 *
 * Layout follows Apple's macOS icon grid: an 824x824 rounded square centred in
 * a 1024x1024 canvas, corner radius 185. Icons that bleed to the edges look
 * oversized next to native ones.
 */
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { root } from "../build.mjs";

const SIZE = 1024;
const OUT = path.join(root, "build", "icon.png");

const ENTRY = `
import { TwistyPlayer } from "cubing/twisty";
const player = new TwistyPlayer({
  puzzle: "3x3x3",
  alg: "",
  background: "none",
  controlPanel: "none",
  hintFacelets: "none",
  visualization: "PG3D",
  // Three-quarter view: reads as a cube at a glance, unlike the edge-on view
  // the app uses for checking a scramble.
  cameraLatitude: 30,
  cameraLongitude: 35,
  experimentalDragInput: "none",
  experimentalMovePressInput: "none",
});
document.getElementById("cube").append(player);
// Give the renderer a moment to draw before the screenshot is taken.
setTimeout(() => { document.title = "ready"; }, 2500);
`;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:;
               worker-src 'self' blob:; style-src 'self' 'unsafe-inline';
               img-src 'self' data: blob:; connect-src 'self' blob: data:;">
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  #plate {
    position: absolute; inset: 100px;              /* 824x824 inside 1024 */
    border-radius: 185px;
    background: linear-gradient(160deg, #fbf8f0 0%, #f5f0e6 55%, #eee7d6 100%);
    box-shadow: inset 0 -14px 40px rgba(32,38,50,.07), inset 0 6px 0 rgba(255,255,255,.7);
    display: flex; align-items: center; justify-content: center;
  }
  twisty-player { width: 620px; height: 620px; }
</style></head>
<body><div id="plate"><div id="cube"></div></div>
<script type="module" src="entry.js"></script></body></html>`;

const MAIN = `
const { app, BrowserWindow, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const DIR = __dirname;
const OUT = process.argv.find((a) => a.startsWith("--out=")).slice(6);

protocol.registerSchemesAsPrivileged([
  { scheme: "icon", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.whenReady().then(async () => {
  // cubing.js spawns a worker, and Chromium refuses to load workers from
  // file:// — so the generator needs a real scheme just like the app does.
  protocol.handle("icon", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\\/+/, "") || "index.html";
    const target = path.join(DIR, rel);
    if (!target.startsWith(DIR + path.sep)) return new Response("no", { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });

  const win = new BrowserWindow({
    width: ${SIZE}, height: ${SIZE}, show: false, frame: false,
    transparent: true, backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadURL("icon://index.html");
  for (let i = 0; i < 120 && win.webContents.getTitle() !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 600));
  const captured = await win.webContents.capturePage();
  // On a Retina display capturePage returns 2x pixels; normalise so the output
  // is 1024x1024 regardless of which machine generated it.
  const image = captured.getSize().width === ${SIZE}
    ? captured
    : captured.resize({ width: ${SIZE}, height: ${SIZE}, quality: "best" });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  const s = image.getSize();
  console.log("ICON " + s.width + "x" + s.height + " -> " + OUT);
  app.exit(0);
});
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubetimer-icon-"));
try {
  fs.writeFileSync(path.join(tmp, "entry.ts"), ENTRY);
  await esbuild.build({
    entryPoints: [path.join(tmp, "entry.ts")],
    outdir: tmp,
    bundle: true,
    splitting: true, // required for cubing.js's worker, same as the app build
    format: "esm",
    platform: "browser",
    target: "esnext",
    absWorkingDir: root,
    // The entry lives in a temp dir, so normal resolution can't walk up to the
    // project's dependencies.
    nodePaths: [path.join(root, "node_modules")],
    logLevel: "warning",
  });
  fs.writeFileSync(path.join(tmp, "index.html"), HTML);
  fs.writeFileSync(path.join(tmp, "main.cjs"), MAIN);
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "icon-gen", main: "main.cjs" }),
  );

  const code = await new Promise((resolve) => {
    spawn(electronPath, [tmp, `--out=${OUT}`], { stdio: "inherit" }).on("exit", resolve);
  });
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

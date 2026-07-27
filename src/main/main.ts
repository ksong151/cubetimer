import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as db from "./db.js";
import * as userBackgrounds from "./user-backgrounds.js";
import type { EventId, NewSolve, Penalty, ScrambleState, Settings, WindowBounds } from "../shared/types.js";

const RENDERER_DIR = path.join(__dirname, "../renderer");

/** URL path prefix under which user-imported backgrounds are served. */
const USER_BACKGROUND_PREFIX = "user-backgrounds/";

// cubing.js generates scrambles in a web worker, and Chromium refuses to load
// workers over file://. Serving the renderer from a privileged custom scheme
// avoids that entirely.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";

    // User-imported backgrounds live in userData, not in the bundle.
    if (rel.startsWith(USER_BACKGROUND_PREFIX)) {
      const file = userBackgrounds.resolveUserBackground(rel.slice(USER_BACKGROUND_PREFIX.length));
      if (!file || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    }

    const target = path.join(RENDERER_DIR, rel);
    // Refuse to serve anything outside the renderer directory.
    if (!target.startsWith(RENDERER_DIR + path.sep) && target !== RENDERER_DIR) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

/**
 * Last known window geometry, ignored if it would place the window off-screen
 * — otherwise unplugging the monitor it was on would make the app open into
 * nowhere with no way to get it back.
 */
function restorableBounds(): WindowBounds | null {
  const bounds = db.getSettings().windowBounds;
  if (!bounds) return null;
  const onSomeDisplay = screen.getAllDisplays().some(({ workArea: a }) => {
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    );
  });
  return onSomeDisplay ? bounds : null;
}

/** Save geometry on move/resize, debounced so dragging isn't a write storm. */
function persistBoundsOf(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    db.setSettings({
      windowMaximized: win.isMaximized(),
      // getNormalBounds() is the un-maximized geometry, which is what we want
      // to restore to when the window is later un-maximized.
      windowBounds: win.getNormalBounds(),
    });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", save);
  win.on("unmaximize", save);
  win.on("close", () => {
    clearTimeout(timer);
    save();
  });
}

function createWindow(): void {
  const saved = restorableBounds();
  const win = new BrowserWindow({
    width: saved?.width ?? 1180,
    height: saved?.height ?? 780,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    // Matches --paper so there's no dark flash before the first paint.
    backgroundColor: "#f5f0e6",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (db.getSettings().windowMaximized) win.maximize();
  persistBoundsOf(win);

  win.loadURL("app://index.html");
  if (process.argv.includes("--dev")) {
    win.webContents.openDevTools({ mode: "detach" });
    watchRendererForDev(win);
  }
}

/**
 * Live reload for `npm run dev`.
 *
 * CSS is swapped in place rather than triggering a reload, so the session,
 * solve list and current scramble survive a style tweak — which is most of what
 * you want while working on the UI. Anything else reloads the window.
 */
function watchRendererForDev(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  let cssOnly = true;

  const flush = () => {
    if (win.isDestroyed()) return;
    if (cssOnly) {
      // Re-request the stylesheet with a cache-busting query, then drop the old
      // <link> only once the new one has loaded — avoids an unstyled flash.
      void win.webContents.executeJavaScript(`(() => {
        const link = document.querySelector('link[rel="stylesheet"]');
        if (!link) return;
        const next = link.cloneNode();
        const url = new URL(link.href);
        url.searchParams.set('v', String(Date.now()));
        next.href = url.toString();
        next.addEventListener('load', () => link.remove(), { once: true });
        link.after(next);
      })()`);
    } else {
      win.webContents.reloadIgnoringCache();
    }
    cssOnly = true;
  };

  fs.watch(RENDERER_DIR, (_event, filename) => {
    if (!filename) return;
    if (!filename.endsWith(".css")) cssOnly = false;
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  });
}

/** Every renderer-callable operation, in one place. */
const handlers = {
  listSessions: () => db.listSessions(),
  sessionCounts: () => db.sessionCounts(),
  createSession: (name: string, eventId: EventId) => db.createSession(name, eventId),
  renameSession: (id: number, name: string) => db.renameSession(id, name),
  deleteSession: (id: number) => db.deleteSession(id),
  clearSession: (id: number) => db.clearSession(id),

  listSolves: (sessionId: number) => db.listSolves(sessionId),
  addSolve: (s: NewSolve) => db.addSolve(s),
  updateSolve: (id: number, patch: { penalty?: Penalty; comment?: string }) =>
    db.updateSolve(id, patch),
  deleteSolve: (id: number) => db.deleteSolve(id),

  getScrambleState: (sessionId: number) => db.getScrambleState(sessionId),
  setScrambleState: (sessionId: number, state: ScrambleState) =>
    db.setScrambleState(sessionId, state),

  getSettings: () => db.getSettings(),
  setSettings: (patch: Partial<Settings>) => db.setSettings(patch),

  listUserBackgrounds: () => userBackgrounds.listUserBackgrounds(),
  addUserBackground: () => userBackgrounds.addUserBackground(),
  deleteUserBackground: (id: string) => userBackgrounds.deleteUserBackground(id),

  exportToFile: async (): Promise<string | null> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export solves",
      defaultPath: "cubetimer-export.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, JSON.stringify(db.exportAll(), null, 2), "utf8");
    return filePath;
  },
} as const;

app.whenReady().then(() => {
  registerAppProtocol();
  db.openDb(app.getPath("userData"));

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args),
    );
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

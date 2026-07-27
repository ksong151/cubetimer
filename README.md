# cubetimer

A standalone speedcubing timer for the desktop, with official WCA scrambles.

```bash
npm install
npm start        # build + launch
```

Other scripts: `npm run build`, `npm run watch`, `npm run typecheck`.
Launch with `npx electron . --dev` to open devtools.

## What it does

- **WCA scrambles for 2x2 through 7x7** via [`cubing.js`](https://js.cubing.net/cubing/scramble/) —
  the same official scrambler logic TNoodle uses, compiled to WASM. Random-state
  where the WCA requires it (2x2, 3x3, 4x4), random-move for 5x5–7x7.
- **Next / previous scramble** with a persistent per-session history.
- **Seven sessions out of the box**: 2x2, 3x3, 3x3 OH, 4x4, 5x5, 6x6, 7x7. Add
  your own or rename them. A session's scramble type is chosen once, at
  creation, and locked thereafter — a 4x4 session can only ever hand you 4x4
  scrambles.
- **WCA 15s inspection** (optional), with 8s/12s audio calls and automatic
  +2 / DNF past 15s / 17s.
- **Stats**: best, mean, ao5, ao12, ao100, best ao5, best ao12 — WCA trimming
  rules, correct DNF handling.
- Per-solve penalties and comments, JSON export.

## Controls

| Key | Action |
| --- | --- |
| `space` | hold to arm (turns green), release to start, any key to stop |
| `←` / `→` | previous / next scramble |
| `R` | reroll the current scramble |
| `Esc` | abort the current inspection or solve without recording |
| double-click a session | rename / change scrambler / clear / delete |

## How scramble history works

WCA random-state scrambles are drawn from a CSPRNG and **cannot be re-derived
from a seed** — `cubing.js` has no seeding API. So "previous scramble" is not a
rewind; it's a cursor over a stored list:

```
queue:  [ s0, s1, s2, s3, s4 ]
cursor:            ^
```

`→` advances the cursor, generating and appending if it runs off the end. `←`
just steps back. Two scrambles are always generated ahead of the cursor so that
4x4 (the one genuinely slow event, ~1.5s of random-state search) is ready before
you ask for it. The queue and cursor are persisted per session, so quitting and
relaunching puts you back on the scramble you were looking at.

**Only two scrambles are kept behind the cursor** (`MAX_HISTORY_BEHIND` in
`src/shared/scramble-history.ts`). Once you're two back, `←` greys out. The
bound is expressed relative to the cursor rather than as a total queue length,
so it holds no matter where you are in the queue and the prefetch buffer ahead
is never trimmed.

This does not affect solve history. Each solve stores its own scramble string at
the moment it's recorded, so a recorded solve always knows what it was solving —
trimming the queue can never orphan one.

## How solves are stored

Everything lives in one SQLite file at
`~/Library/Application Support/cubetimer/cubetimer.db`, written through Node
24's built-in `node:sqlite` (no native modules, so no rebuild step).

```sql
session(id, name, event_id, position, created_at)
solve(id, session_id → session.id, ms, penalty, scramble, comment, started_at)
scramble_state(session_id → session.id, queue, cursor)
setting(key, value)
```

One row per solve, keyed to its session. `ms` is the **raw measured time**; the
penalty is stored separately rather than baked in, so a +2 stays reversible and
a DNF never loses the underlying time. Each row carries its own scramble, so
history stays accurate no matter what happens to the live scramble queue.

### There is no database server

`node:sqlite` is a **library compiled into Electron's Node runtime**, not a
service. There's no daemon, no port, no separate process to install or start —
opening the database is just opening a file. This is why the app has no setup
step and works offline.

Inside `cubetimer.app` the split is:

```
cubetimer.app/Contents/
  MacOS/cubetimer                  ← Electron binary; SQLite is compiled in here
  Resources/app.asar               ← our bundled code (read-only)

~/Library/Application Support/cubetimer/
  cubetimer.db                     ← your solves (read-write, outside the .app)
  cubetimer.db-wal, -shm           ← SQLite write-ahead log
```

The **code** ships inside the `.app`; the **data** deliberately does not. An
application bundle is read-only in practice — it may live in a directory you
can't write to, writing into it would invalidate the code signature, and an
update replaces the whole bundle. So the database goes in `userData`, which is
what `app.getPath("userData")` in `main.ts` resolves to.

The practical consequence: **rebuilding, reinstalling, or deleting the app does
not touch your solves.** Running from source and running the packaged `.app`
share the same database, since both resolve the same `userData` path. To back up
or move to another machine, copy that folder (or use `Export`); to genuinely
start over, delete it.

Only the main process ever opens the database. The renderer has no filesystem
access at all — it calls through `contextBridge` in `preload.ts` to IPC handlers
in `main.ts`. That's why `window.api` exists rather than the UI importing `db.ts`
directly.

### What survives a relaunch

Everything, without a save step:

| | where |
|---|---|
| solves, with penalties and comments | `solve` |
| sessions and their scramble types | `session` |
| which session you had open | `setting.lastSessionId` |
| the scramble you were looking at, and its history cursor | `scramble_state` |
| inspection / hold time / hide-time | `setting` |
| window size, position, maximized state | `setting.windowBounds` |

Window geometry is saved debounced on move and resize, and again on close. It's
discarded on restore if it would land off-screen — otherwise unplugging an
external monitor would reopen the app into nowhere.

Every solve is committed to disk the instant the timer stops. Quitting the app,
force-quitting it, or losing power does not lose solves; there is no save step.
The only things that remove solves are the explicit **Clear solves** and
**Delete session** actions in the session dialog, both of which require a
second confirming click.

### Why ao5 / ao12 / ao100 are not columns

They're derived from a *window* of solves, so they aren't facts about a solve —
they're facts about a solve **and its neighbours**. Marking solve #47 as +2
changes every average whose window covers it: up to 100 rows at once. A stored
copy would be silently wrong from that moment on.

So they're computed on read instead, always from the current state of that
session alone — sessions never pool their averages. That's cheap: a full ao100
over a thousand-solve session is a slice and a sort.

### The solve list is windowed; the stats are not

Only the most recent **200** solves are put in the DOM (`SOLVE_WINDOW` in
`src/renderer/index.ts`), with a *Load 200 older* button beneath them. Each row
costs ~25µs to build and the list is rebuilt after every solve, so rendering a
whole large session would freeze the timer between solves — measured at 2.4s for
a 100k-solve session, versus about 5ms windowed.

Nothing else is windowed. Every row's `ao5`/`ao12` is computed from that solve's
**absolute** position in the session, so a windowed row shows exactly the
average it would in a full list — including averages whose window reaches back
into solves that aren't currently rendered. Session stats (best, mean, ao100,
best ao5, best ao12) and `Export` always scan every solve.

You still see them everywhere you'd want them:

- **per solve** — the `ao5` and `ao12` columns in the solve list
- **for the session** — `ao5`, `ao12`, `ao100`, `best ao5`, `best ao12` in the
  stats bar
- **frozen in exports** — `Export` writes each solve with the averages as they
  stood at export time:

```json
{
  "name": "3x3", "eventId": "333", "solveCount": 120,
  "solves": [
    { "index": 5, "scramble": "R U R' …", "ms": 18000, "penalty": "none",
      "effectiveMs": 18000, "ao5": 14000, "ao12": null, "comment": "", "startedAt": 1700000000000 }
  ]
}
```

`ao12: null` means the average was a DNF; an omitted key means there weren't
enough solves yet to form it.

## Architecture

```
src/
  shared/types.ts     types shared across the process boundary
  shared/averages.ts  WCA average rules (used by both processes)
  main/
    main.ts           Electron main: window, app:// protocol, IPC dispatch
    preload.ts        contextBridge surface (window.api)
    db.ts             SQLite schema and queries
  renderer/
    index.ts          UI, timer state machine, keyboard handling
    scrambler.ts      ScrambleQueue — generation, buffering, history cursor
    stats.ts          WCA averages
    format.ts         time formatting and penalty arithmetic
    ui.ts             minimal DOM helpers
```

### Two things that will bite you if you change the build

1. **`splitting: true` in `build.mjs` is required, not a preference.**
   `cubing.js` locates its search worker by `await import(...)`-ing a module and
   reading that module's `import.meta.url`. Without code splitting, esbuild
   inlines the import into the main bundle, so the "worker URL" becomes the app
   bundle itself — the worker then tries to boot the whole UI and dies with
   `window is not defined`.

2. **The renderer is served over `app://`, not `file://`.** Chromium refuses to
   load workers from `file://`, which would break scrambling entirely. The
   custom scheme is registered in `main.ts`.

## Running it on other devices

```bash
npm run dist:mac      # .dmg for arm64 + x64
npm run dist:win      # NSIS installer for x64 + arm64
npm run dist:linux    # AppImage + .deb for x64 + arm64
npm run dist          # all three
npm run dist:dir      # unpacked app, fastest, for testing packaging
```

Output lands in `release/`. Because there are no native modules, nothing needs
rebuilding per platform, and nothing from `node_modules` ships — esbuild has
already inlined cubing.js and its WASM into `dist/`, so `app.asar` is about 4MB.

**macOS builds are unsigned.** Gatekeeper will refuse the first launch; either
right-click → Open, or run
`xattr -dr com.apple.quarantine /Applications/cubetimer.app`. Signing needs an
Apple Developer ID, which is a paid account.

Cross-building has the usual caveats: Windows installers built from macOS need
Wine, and Linux targets build most reliably on Linux. The tidy answer is CI —
one GitHub Actions job per runner OS, each running its own `npm run dist:*`.

### Why this isn't a Docker container

Containerizing was considered and is the wrong tool here. A container shares the
host kernel and ships no display stack, so a GUI app inside one has to reach a
screen via X11 forwarding or VNC. On macOS and Windows that also means going
through a Linux VM first. For a **speedcubing timer** that's disqualifying: it
puts a network protocol and a virtualisation layer between your spacebar and
`performance.now()`, and inspection/solve timing is the entire product. It also
wouldn't help distribution, since nobody wants to install Docker to time solves.

Native installers are what actually make an Electron app run on other people's
machines, which is what `electron-builder` above produces.

Where a container *is* genuinely useful is **building**: `electron-builder` ships
[official Docker images](https://www.electron.build/multi-platform-build) for
producing Linux and Windows artifacts from a macOS host without installing Wine
locally. That's a build-time tool, not a runtime one.

If you want the timer on a device you can't install to — a locked-down machine,
a phone, a Chromebook — the answer isn't a container either; it's serving the
renderer as a web page. The renderer has no Node dependencies, so the only work
is swapping the `window.api` implementation in `preload.ts` for one backed by
IndexedDB instead of SQLite. That's a real option if you ever want it.

## Timer backgrounds

The timer area sits on a photo washed over with cream so the digits keep their
contrast. Pick one under **Settings → Timer background**; the choice previews
live as you change the dropdown, rolls back if you dismiss the dialog, and
persists across launches like every other setting.

Presets ship as: plain (no image), Mount Rainier, Colchuck Lake, Mount Storm
King.

### Importing your own

Pick **＋ Add image…** at the bottom of the dropdown to choose a file. It's
copied into `~/Library/Application Support/cubetimer/backgrounds/` and appears
in the list from then on. **Remove image** deletes it; the button is disabled
whenever a built-in preset is selected, so the four shipped ones can't be
removed.

Imported images deliberately live in userData rather than the app bundle: the
bundle is read-only once packaged, and anything written there would be lost on
the next build or update. They're served over `app://user-backgrounds/…`, with
the resolver refusing any path that escapes that directory.

If the file behind a saved custom background disappears, the timer falls back to
the plain panel rather than showing a broken image.

### Adding a built-in preset

1. Drop the image into `src/renderer/assets/`.
2. Add an entry to `PRESETS` in `src/renderer/backgrounds.ts`.

The dropdown is generated from that list, so nothing else needs touching. To
remove one, delete its entry and its file — the build prunes assets that no
longer exist in source, so a deleted image won't linger in the packaged app.

Everything in `src/renderer/assets/` is copied into the build automatically and
served over `app://`, so it works offline and inside the packaged `.app`. Files
are only rewritten when their contents change — that matters, because a
redundant write would make the dev watcher treat a CSS-only edit as a full
reload instead of a state-preserving hot-swap.

How strong the cream wash is lives in `src/renderer/styles.css`:

```css
--timer-bg-scrim: 74%;   /* higher = more cream, subtler photo, more legible timer */
```

## Possible next steps

- Import from cstimer's JSON export.
- Scramble preview images via [`scramble-display`](https://github.com/cubing/scramble-display).
- Reproducible scrambles: `cubing.js` exposes
  `experimentalDeriveScrambleForEvent(seedHex, saltHierarchy, eventID)`, which
  derives a scramble deterministically from a seed. Useful for replaying a
  session or sharing a scramble set with someone else.
- Stackmat / Bluetooth cube input, session graphs, algorithm trainers.

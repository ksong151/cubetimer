import { CUSTOM_BACKGROUND_PREFIX } from "../shared/types.js";
import type { EventId, Penalty, Session, Settings, Solve, TimerBackgroundId } from "../shared/types.js";
import { effective, formatAvg, formatMs, formatSolve } from "./format.js";
import { ScrambleQueue } from "./scrambler.js";
import { trailingAverageAt } from "../shared/averages.js";
import {
  allBackgrounds,
  applyTimerBackground,
  findBackground,
  isCustom,
  setUserBackgrounds,
} from "./backgrounds.js";
import { mountCube, setCubeHidden, updateCube } from "./cube.js";
import { sessionStats } from "./stats.js";
import { $, closeModal, el, isModalOpen, openModal } from "./ui.js";

const EVENTS: Array<{ id: EventId; label: string }> = [
  { id: "222", label: "2x2x2" },
  { id: "333", label: "3x3x3" },
  { id: "444", label: "4x4x4" },
  { id: "555", label: "5x5x5" },
  { id: "666", label: "6x6x6" },
  { id: "777", label: "7x7x7" },
];

/* -------------------------------- state -------------------------------- */

let sessions: Session[] = [];
let counts: Record<number, number> = {};
let current: Session;
let solves: Solve[] = [];
let settings: Settings;
let queue: ScrambleQueue;

/** Text shown on the timer when nothing is running — usually the last result. */
let restingText = "0.00";

/* ------------------------------ timer state ----------------------------- */

type Phase = "idle" | "inspecting" | "holding" | "ready" | "running";

let phase: Phase = "idle";
/** Whether the hold began during inspection, so releasing returns to the right state. */
let holdFrom: "idle" | "inspecting" = "idle";
let holdTimer: number | undefined;
let rafId = 0;

let startPerf = 0;
let startedAtWall = 0;
let inspectStartPerf = 0;
let inspectionPenalty: Penalty = "none";
let calledEight = false;
let calledTwelve = false;
/**
 * Timestamp until which space is ignored, so the second half of an accidental
 * double-tap on the stop key can't immediately start the next inspection.
 */
let cooldownUntil = 0;

const inspectionActive = () =>
  phase === "inspecting" || ((phase === "holding" || phase === "ready") && holdFrom === "inspecting");

/* --------------------------------- init --------------------------------- */

async function init(): Promise<void> {
  settings = await window.api.getSettings();
  setUserBackgrounds(await window.api.listUserBackgrounds());
  applyTimerBackground(settings.timerBackground);
  sessions = await window.api.listSessions();
  counts = await window.api.sessionCounts();

  const remembered = sessions.find((s) => s.id === settings.lastSessionId);
  current = remembered ?? sessions[0]!;

  queue = new ScrambleQueue(current.id, current.eventId, renderScramble);
  wireControls();
  wireKeys();

  await selectSession(current);
}

async function selectSession(session: Session): Promise<void> {
  current = session;
  resetTimerState();
  restingText = "0.00";
  visibleSolves = SOLVE_WINDOW;
  solves = await window.api.listSolves(session.id);
  renderAll();
  void window.api.setSettings({ lastSessionId: session.id });
  await queue.load(session.id, session.eventId);
}

async function refreshSessions(): Promise<void> {
  sessions = await window.api.listSessions();
  counts = await window.api.sessionCounts();
  renderSessions();
}

/* -------------------------------- render -------------------------------- */

function renderAll(): void {
  renderSessions();
  renderScramble();
  renderStats();
  renderSolves();
  paint();
}

function renderSessions(): void {
  counts[current.id] = solves.length;
  const list = $("session-list");
  list.replaceChildren(
    ...sessions.map((s) =>
      el(
        "button",
        {
          class: `session-item${s.id === current.id ? " active" : ""}`,
          onclick: () => void selectSession(s),
          ondblclick: () => openSessionModal(s),
        },
        el("span", { text: s.name }),
        el("span", { class: "count", text: String(counts[s.id] ?? 0) }),
      ),
    ),
  );
}

function renderScramble(): void {
  const text = queue.current();
  const node = $("scramble");
  node.textContent = text ?? "generating scramble…";
  node.classList.toggle("pending", text === null);

  const { index, total } = queue.position();
  $("scramble-meta").textContent = total
    ? `${current.name} · ${index} of ${total} in history`
    : current.name;

  ($("prev-scramble") as HTMLButtonElement).disabled = !queue.hasPrev();
  updateCube(current.eventId, text);
}

function renderStats(): void {
  const s = sessionStats(solves);
  // An empty session has no best/mean at all — that's "–", not a DNF. Once
  // there are solves, a null best genuinely does mean every solve was a DNF.
  const orDash = (text: string) => (s.count === 0 ? "–" : text);
  // Three rows of three: totals, current averages, best averages.
  const cells: Array<[string, string]> = [
    ["solves", `${s.solved}/${s.count}`],
    ["best", orDash(formatMs(s.best))],
    ["mean", orDash(formatAvg(s.mean))],
    ["ao5", fmtAvg(s.ao5)],
    ["ao12", fmtAvg(s.ao12)],
    ["ao100", fmtAvg(s.ao100)],
    ["best ao5", fmtAvg(s.bestAo5)],
    ["best ao12", fmtAvg(s.bestAo12)],
    ["best ao100", fmtAvg(s.bestAo100)],
  ];
  $("stats").replaceChildren(
    ...cells.map(([k, v]) =>
      el("div", { class: "stat" }, el("span", { class: "k", text: k }), el("span", { class: "v", text: v })),
    ),
  );
}

/** Averages that don't have enough solves yet read as "–" rather than DNF. */
function fmtAvg(v: number | null | undefined): string {
  return v === undefined ? "–" : formatAvg(v);
}

/**
 * How many solve rows to put in the DOM at once.
 *
 * Each row costs roughly 25µs to build, and the list is rebuilt after every
 * solve — so rendering an entire large session would freeze the timer for
 * seconds between solves (measured: ~2.4s at 100k solves). Windowing keeps that
 * cost flat. Stats, averages and export always read the full session.
 */
const SOLVE_WINDOW = 200;

/** How many of the most recent solves are currently in the DOM. */
let visibleSolves = SOLVE_WINDOW;

/** The top-right reset control, created once in wireControls(). */
let resetBtn: HTMLButtonElement | undefined;

function renderSolves(): void {
  $("solves-title").textContent = current.name;
  if (resetBtn) resetBtn.disabled = solves.length === 0;

  const list = $("solve-list");
  if (solves.length === 0) {
    list.replaceChildren(el("div", { class: "empty", text: "No solves yet." }));
    return;
  }

  // Averages are computed against the whole session using each solve's absolute
  // index, so a windowed row shows the same ao5/ao12 it would in a full list.
  const times = solves.map(effective);
  const start = Math.max(0, solves.length - visibleSolves);

  const nodes: Node[] = [];
  for (let i = solves.length - 1; i >= start; i--) {
    const solve = solves[i]!;
    nodes.push(
      el(
        "button",
        {
          class: `solve-row ${solve.penalty === "dnf" ? "dnf" : solve.penalty === "plus2" ? "plus2" : ""}`,
          onclick: () => openSolveModal(solve),
        },
        el("span", { class: "n", text: String(i + 1) }),
        el("span", { class: "t", text: formatSolve(solve) }),
        el("span", { class: "a", text: fmtAvg(trailingAverageAt(times, i, 5)) }),
        el("span", { class: "a", text: fmtAvg(trailingAverageAt(times, i, 12)) }),
      ),
    );
  }

  if (start > 0) {
    const remaining = start;
    nodes.push(
      el("button", {
        class: "load-more",
        text: `Load ${Math.min(SOLVE_WINDOW, remaining)} older — ${remaining.toLocaleString()} not shown`,
        onclick: () => {
          visibleSolves += SOLVE_WINDOW;
          renderSolves();
        },
      }),
    );
  }

  list.replaceChildren(...nodes);
}

/* --------------------------------- timer -------------------------------- */

function paint(): void {
  const timer = $("timer");
  const hint = $("timer-hint");
  let text = restingText;
  let cls = "timer";

  if (phase === "running") {
    text = settings.hideTimeWhileSolving ? "solving" : formatMs(performance.now() - startPerf);
  } else if (inspectionActive()) {
    const elapsed = (performance.now() - inspectStartPerf) / 1000;
    if (elapsed > 17) text = "DNF";
    else if (elapsed > 15) text = "+2";
    else text = String(Math.max(0, Math.ceil(15 - elapsed)));
    cls += elapsed > 15 ? " warn" : " inspecting";
  }

  if (phase === "holding") cls = "timer holding";
  if (phase === "ready") cls = "timer ready";

  timer.textContent = text;
  timer.className = cls;

  hint.innerHTML = "";
  const hints: Record<Phase, string> = {
    idle: settings.inspection ? "press space for inspection" : "hold space to start",
    inspecting: "hold space when ready",
    holding: "keep holding…",
    ready: "release to start",
    running: "press any key to stop",
  };
  hint.textContent = hints[phase];
}

function loop(): void {
  cancelAnimationFrame(rafId);
  const step = () => {
    if (inspectionActive()) checkInspectionCalls();
    paint();
    if (phase !== "idle") rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function checkInspectionCalls(): void {
  const elapsed = (performance.now() - inspectStartPerf) / 1000;
  if (!calledEight && elapsed >= 8) {
    calledEight = true;
    beep(660, 90);
  }
  if (!calledTwelve && elapsed >= 12) {
    calledTwelve = true;
    beep(880, 140);
  }
}

let audioCtx: AudioContext | undefined;
function beep(freq: number, ms: number): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch {
    /* audio is a nicety, never a failure */
  }
}

function startInspection(): void {
  phase = "inspecting";
  inspectStartPerf = performance.now();
  inspectionPenalty = "none";
  calledEight = false;
  calledTwelve = false;
  loop();
}

function beginHold(): void {
  holdFrom = phase === "inspecting" ? "inspecting" : "idle";
  phase = "holding";
  clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    if (phase === "holding") {
      phase = "ready";
      paint();
    }
  }, settings.holdMs);
  loop();
}

function releaseHold(): void {
  clearTimeout(holdTimer);
  if (phase === "ready") startSolve();
  else {
    phase = holdFrom;
    if (phase === "idle") cancelAnimationFrame(rafId);
    paint();
  }
}

function startSolve(): void {
  // The inspection clock runs until the solve actually begins.
  if (holdFrom === "inspecting") {
    const elapsed = (performance.now() - inspectStartPerf) / 1000;
    inspectionPenalty = elapsed > 17 ? "dnf" : elapsed > 15 ? "plus2" : "none";
  } else {
    inspectionPenalty = "none";
  }
  phase = "running";
  setCubeHidden(true);
  startPerf = performance.now();
  startedAtWall = Date.now();
  loop();
}

async function stopSolve(): Promise<void> {
  const ms = performance.now() - startPerf;
  phase = "idle";
  cooldownUntil = performance.now() + settings.postSolveCooldownMs;
  setCubeHidden(false);
  cancelAnimationFrame(rafId);

  const solve = await window.api.addSolve({
    sessionId: current.id,
    ms,
    penalty: inspectionPenalty,
    scramble: queue.current() ?? "",
    startedAt: startedAtWall,
  });
  solves.push(solve);
  restingText = formatSolve(solve);

  renderSolves();
  renderStats();
  renderSessions();
  paint();

  await queue.next();
}

/** Escape: abandon whatever is in progress without recording anything. */
function abort(): void {
  if (phase === "idle") return;
  clearTimeout(holdTimer);
  cancelAnimationFrame(rafId);
  phase = "idle";
  setCubeHidden(false);
  paint();
}

function resetTimerState(): void {
  clearTimeout(holdTimer);
  cancelAnimationFrame(rafId);
  phase = "idle";
  inspectionPenalty = "none";
}

/* ------------------------------- controls ------------------------------- */

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

function wireKeys(): void {
  window.addEventListener("keydown", (e) => {
    if (isModalOpen()) {
      if (e.code === "Escape") closeModal();
      return;
    }
    // Let system/browser shortcuts through untouched.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (phase === "running") {
      if (MODIFIER_CODES.has(e.code)) return;
      e.preventDefault();
      void stopSolve();
      return;
    }

    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      // Only gate a fresh start; a hold already in progress must still release.
      if (phase === "idle" && performance.now() < cooldownUntil) return;
      if (phase === "idle" && settings.inspection) startInspection();
      else if (phase === "idle" || phase === "inspecting") beginHold();
      return;
    }

    if (e.code === "Escape") {
      abort();
      return;
    }

    if (phase !== "idle") return;

    if (e.code === "ArrowLeft") {
      e.preventDefault();
      queue.prev();
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      void queue.next();
    } else if (e.code === "KeyR") {
      void queue.reroll();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (isModalOpen() || e.code !== "Space") return;
    if (phase === "holding" || phase === "ready") {
      e.preventDefault();
      releaseHold();
    }
  });
}

/** Clear every solve in the current session, keeping the session itself. */
async function resetCurrentSession(): Promise<void> {
  await window.api.clearSession(current.id);
  solves = [];
  restingText = "0.00";
  visibleSolves = SOLVE_WINDOW;
  resetTimerState();
  await refreshSessions();
  renderAll();
}

function wireControls(): void {
  mountCube($("cube-panel"));
  resetBtn = confirmButton("Reset", "Confirm?", () => void resetCurrentSession(), "reset-btn");
  resetBtn.title = "Clear every solve in this session";
  $("reset-slot").replaceChildren(resetBtn);

  $("prev-scramble").addEventListener("click", () => queue.prev());
  $("next-scramble").addEventListener("click", () => void queue.next());
  $("add-session").addEventListener("click", () => openSessionModal(null));
  $("settings-btn").addEventListener("click", openSettingsModal);
  $("export-btn").addEventListener("click", async () => {
    const path = await window.api.exportToFile();
    if (path) openModal(() => el("div", {}, el("h2", { text: "Exported" }), el("div", { class: "scramble-readout", text: path }), el("div", { class: "row" }, el("button", { class: "btn primary", text: "OK", onclick: closeModal }))));
  });
}

/* -------------------------------- modals -------------------------------- */

function openSolveModal(solve: Solve): void {
  openModal(() => {
    const comment = el("textarea", { placeholder: "Comment" }) as HTMLTextAreaElement;
    comment.value = solve.comment;

    const applyPenalty = async (penalty: Penalty) => {
      await window.api.updateSolve(solve.id, { penalty });
      solve.penalty = penalty;
      const idx = solves.findIndex((s) => s.id === solve.id);
      if (idx >= 0) solves[idx] = { ...solve };
      if (idx === solves.length - 1) restingText = formatSolve(solve);
      renderSolves();
      renderStats();
      paint();
      closeModal();
    };

    const save = async () => {
      if (comment.value !== solve.comment) {
        await window.api.updateSolve(solve.id, { comment: comment.value });
        const idx = solves.findIndex((s) => s.id === solve.id);
        if (idx >= 0) solves[idx] = { ...solve, comment: comment.value };
      }
      closeModal();
    };

    const remove = async () => {
      await window.api.deleteSolve(solve.id);
      solves = solves.filter((s) => s.id !== solve.id);
      restingText = solves.length ? formatSolve(solves[solves.length - 1]!) : "0.00";
      renderSolves();
      renderStats();
      renderSessions();
      paint();
      closeModal();
    };

    return el(
      "div",
      {},
      el("div", { class: "big-time", text: formatSolve(solve) }),
      el("div", { class: "field" }, el("label", { text: "Scramble" }), el("div", { class: "scramble-readout", text: solve.scramble || "—" })),
      el(
        "div",
        { class: "row" },
        ...(["none", "plus2", "dnf"] as Penalty[]).map((p) =>
          el("button", {
            class: `btn${solve.penalty === p ? " selected" : ""}`,
            text: p === "none" ? "OK" : p === "plus2" ? "+2" : "DNF",
            onclick: () => void applyPenalty(p),
          }),
        ),
      ),
      el("div", { class: "field", style: "margin-top:16px" }, el("label", { text: "Comment" }), comment),
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn danger", text: "Delete", onclick: () => void remove() }),
        el("button", { class: "btn primary", text: "Save", onclick: () => void save() }),
      ),
    );
  });
}

const eventLabel = (id: EventId) => EVENTS.find((e) => e.id === id)?.label ?? id;

/**
 * Turns a destructive button into a two-click confirm, so wiping a session is
 * never a single misclick away.
 */
function confirmButton(
  label: string,
  confirmLabel: string,
  action: () => void,
  className = "btn danger",
): HTMLButtonElement {
  let armed = false;
  const btn = el("button", {
    class: className,
    text: label,
    onclick: () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        btn.classList.add("selected");
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          btn.textContent = label;
          btn.classList.remove("selected");
        }, 4000);
        return;
      }
      action();
    },
  });
  return btn;
}

function openSessionModal(session: Session | null): void {
  openModal(() => {
    const name = el("input", { type: "text", placeholder: "Session name" }) as HTMLInputElement;
    name.value = session?.name ?? "";

    // Scramble type is chosen once, at creation, and fixed thereafter.
    const select = el("select") as HTMLSelectElement;
    for (const ev of EVENTS) select.append(el("option", { value: ev.id, text: ev.label }));
    select.value = "333";
    // Keep the name in step with the puzzle until the user types their own.
    let nameTouched = false;
    name.addEventListener("input", () => (nameTouched = true));
    select.addEventListener("change", () => {
      if (!nameTouched) name.value = eventLabel(select.value as EventId);
    });
    if (!session) name.value = eventLabel("333");

    const save = async () => {
      const label = name.value.trim();
      if (!label) return;
      if (session) {
        await window.api.renameSession(session.id, label);
        session.name = label;
        await refreshSessions();
        if (session.id === current.id) renderScramble();
      } else {
        const created = await window.api.createSession(label, select.value as EventId);
        await refreshSessions();
        closeModal();
        await selectSession(created);
        return;
      }
      closeModal();
    };

    const clear = async () => {
      if (!session) return;
      await window.api.clearSession(session.id);
      if (session.id === current.id) {
        solves = [];
        restingText = "0.00";
        visibleSolves = SOLVE_WINDOW;
        renderAll();
      }
      await refreshSessions();
      closeModal();
    };

    const remove = async () => {
      if (!session || sessions.length <= 1) return;
      await window.api.deleteSession(session.id);
      await refreshSessions();
      closeModal();
      if (session.id === current.id) await selectSession(sessions[0]!);
    };

    return el(
      "div",
      {},
      el("h2", { text: session ? "Edit session" : "New session" }),
      el("div", { class: "field" }, el("label", { text: "Name" }), name),
      el(
        "div",
        { class: "field" },
        el("label", { text: "Scramble type" }),
        session
          ? el("div", { class: "locked-field" }, el("span", { text: eventLabel(session.eventId) }), el("span", { class: "lock", text: "fixed at creation" }))
          : select,
      ),
      session &&
        el(
          "div",
          { class: "row" },
          confirmButton(`Clear ${counts[session.id] ?? 0} solves`, "Really clear?", () => void clear()),
          sessions.length > 1 && confirmButton("Delete session", "Really delete?", () => void remove()),
        ),
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", text: "Save", onclick: () => void save() }),
      ),
    );
  });
}

function openSettingsModal(): void {
  openModal(
    () => {
    const inspection = el("input", { type: "checkbox", id: "opt-inspection" }) as HTMLInputElement;
    inspection.checked = settings.inspection;

    const hide = el("input", { type: "checkbox", id: "opt-hide" }) as HTMLInputElement;
    hide.checked = settings.hideTimeWhileSolving;

    const hold = el("input", { type: "number", min: "0", max: "2000", step: "50" }) as HTMLInputElement;
    hold.value = String(settings.holdMs);

    const cooldown = el("input", { type: "number", min: "0", max: "3000", step: "50" }) as HTMLInputElement;
    cooldown.value = String(settings.postSolveCooldownMs);

    // Sentinel option that opens a file picker rather than selecting anything.
    const ADD = "\u0000add";
    const background = el("select") as HTMLSelectElement;
    const remove = el("button", { class: "btn danger", text: "Remove image" }) as HTMLButtonElement;

    let chosen: TimerBackgroundId = settings.timerBackground;

    const rebuild = () => {
      background.replaceChildren();
      for (const b of allBackgrounds()) {
        background.append(el("option", { value: b.id, text: b.label }));
      }
      background.append(el("option", { value: ADD, text: "＋ Add image…" }));
      // A saved custom background whose file has since been deleted resolves to
      // nothing; fall back rather than showing a blank selection.
      if (!findBackground(chosen)) chosen = "none";
      background.value = chosen;
      remove.disabled = !findBackground(chosen)?.removable;
      applyTimerBackground(chosen);
    };

    background.addEventListener("change", () => {
      if (background.value !== ADD) {
        chosen = background.value;
        rebuild();
        return;
      }
      // Restore the visible selection immediately; the dialog is async.
      background.value = chosen;
      void (async () => {
        const added = await window.api.addUserBackground();
        if (!added) return;
        setUserBackgrounds(await window.api.listUserBackgrounds());
        chosen = CUSTOM_BACKGROUND_PREFIX + added.id;
        rebuild();
      })();
    });

    remove.addEventListener("click", () => {
      const target = findBackground(chosen);
      if (!target?.removable) return;
      void (async () => {
        await window.api.deleteUserBackground(chosen.slice(CUSTOM_BACKGROUND_PREFIX.length));
        setUserBackgrounds(await window.api.listUserBackgrounds());
        chosen = "none";
        rebuild();
      })();
    });

    rebuild();

    const save = async () => {
      settings = await window.api.setSettings({
        inspection: inspection.checked,
        hideTimeWhileSolving: hide.checked,
        holdMs: Math.max(0, Math.min(2000, Number(hold.value) || 0)),
        postSolveCooldownMs: Math.max(0, Math.min(3000, Number(cooldown.value) || 0)),
        timerBackground: chosen,
      });
      applyTimerBackground(settings.timerBackground);
      paint();
      closeModal();
    };

    return el(
      "div",
      {},
      el("h2", { text: "Settings" }),
      el(
        "div",
        { class: "field checkbox" },
        inspection,
        el("label", { for: "opt-inspection", text: "WCA 15s inspection" }),
      ),
      el(
        "div",
        { class: "field checkbox" },
        hide,
        el("label", { for: "opt-hide", text: "Hide time while solving" }),
      ),
      el("div", { class: "field" }, el("label", { text: "Hold time before ready (ms)" }), hold),
      el(
        "div",
        { class: "field" },
        el("label", { text: "Dead time after a solve (ms)" }),
        cooldown,
        el("div", {
          class: "field-hint",
          text: "Ignores space for this long after a solve stops, so a double-tap can't start the next one.",
        }),
      ),
      el(
        "div",
        { class: "field" },
        el("label", { text: "Timer background" }),
        background,
        el("div", { class: "field-actions" }, remove),
      ),
      el(
        "div",
        { class: "field" },
        el("label", { text: "Shortcuts" }),
        el("div", {
          class: "scramble-readout",
          text: "space — hold to arm, release to start, any key to stop\n← / → — previous / next scramble\nR — reroll current scramble\nEsc — abort\ndouble-click a session to rename",
          style: "white-space:pre-line",
        }),
      ),
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", text: "Done", onclick: () => void save() }),
      ),
    );
    },
    // However the dialog is dismissed, snap the background back to what is
    // actually saved — the dropdown previews live.
    () => applyTimerBackground(settings.timerBackground),
  );
}

void init();

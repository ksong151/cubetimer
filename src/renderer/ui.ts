/** Tiny DOM helpers — enough structure to keep the UI code readable without a framework. */

type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") node.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (v === false || v === undefined) continue;
    else if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

export function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const modalRoot = () => $("modal-root");

export interface ModalHandle {
  close(): void;
}

/** Runs when the current modal closes, however it was dismissed. */
let onCloseHandler: (() => void) | null = null;

/**
 * Opens a modal. While one is open, `isModalOpen()` is true so the timer's
 * global key handling stands down.
 *
 * `onClose` fires for every dismissal route — Cancel, Escape, backdrop click,
 * or being replaced by another modal — which is what makes it safe to preview
 * a setting live and roll it back.
 */
export function openModal(build: (handle: ModalHandle) => Node, onClose?: () => void): ModalHandle {
  closeModal();
  onCloseHandler = onClose ?? null;
  const handle: ModalHandle = { close: closeModal };
  const backdrop = el("div", {
    class: "modal-backdrop",
    onclick: (e: Event) => {
      if (e.target === backdrop) closeModal();
    },
  });
  const modal = el("div", { class: "modal" }, build(handle));
  backdrop.append(modal);
  modalRoot().append(backdrop);
  // Focus the first sensible control so Enter/Escape behave.
  const focusable = modal.querySelector<HTMLElement>("input, textarea, select, button");
  focusable?.focus();
  return handle;
}

export function closeModal(): void {
  // Clear the handler before invoking it, so a handler that itself closes a
  // modal can't loop.
  const handler = onCloseHandler;
  onCloseHandler = null;
  modalRoot().replaceChildren();
  handler?.();
}

export function isModalOpen(): boolean {
  return modalRoot().childElementCount > 0;
}

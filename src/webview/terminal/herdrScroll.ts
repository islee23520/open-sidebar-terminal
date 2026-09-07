import type { HerdrScrollGesture, HostMessage } from "../../types";

type SourceState = Extract<HostMessage, { type: "sourceState" }>;

const WHEEL_OPTIONS: AddEventListenerOptions = { capture: true, passive: false };
const KEY_OPTIONS: AddEventListenerOptions = { capture: true };

export interface HerdrMouseCell {
  readonly column: number;
  readonly row: number;
}

export interface HerdrPointerSize {
  readonly cols: number;
  readonly rows: number;
}

export function shouldInterceptHerdrScroll(
  source: SourceState["source"] | undefined,
  phase: SourceState["phase"] | undefined,
): boolean {
  return source === "herdr" && (phase === "attaching" || phase === "attached");
}

export function herdrScrollback(attached: boolean, configured: number): number {
  return attached ? 0 : configured;
}

export function wheelStepCount(deltaY: number): number {
  if (deltaY === 0 || !Number.isFinite(deltaY)) {
    return 0;
  }
  return Math.max(1, Math.min(15, Math.round(Math.abs(deltaY) / 40)));
}

export function buildHerdrWheelScroll(
  deltaY: number,
  cell: HerdrMouseCell,
): HerdrScrollGesture | undefined {
  const lines = wheelStepCount(deltaY);
  if (lines === 0) {
    return undefined;
  }
  return {
    direction: deltaY < 0 ? "up" : "down",
    lines,
    source: "wheel",
    column: cell.column,
    row: cell.row,
    modifiers: 0,
  };
}

export function buildHerdrPageScroll(
  key: "PageUp" | "PageDown",
  rows: number,
): HerdrScrollGesture {
  return {
    direction: key === "PageUp" ? "up" : "down",
    lines: Math.max(1, rows),
    source: "page_key",
    column: 0,
    row: 0,
    modifiers: 0,
  };
}

export function cellFromPointer(
  event: { readonly clientX: number; readonly clientY: number },
  target: HTMLElement,
  cols: number,
  rows: number,
): HerdrMouseCell {
  const bounds = target.getBoundingClientRect();
  const width = bounds.width || 1;
  const height = bounds.height || 1;
  const x = Math.min(Math.max(event.clientX - bounds.left, 0), width - 1);
  const y = Math.min(Math.max(event.clientY - bounds.top, 0), height - 1);
  return {
    column: Math.min(cols, Math.max(1, Math.floor((x / width) * cols) + 1)),
    row: Math.min(rows, Math.max(1, Math.floor((y / height) * rows) + 1)),
  };
}

export function isPointerInsideTarget(
  event: Event,
  target: HTMLElement,
): boolean {
  if (!(event.target instanceof Node)) {
    return false;
  }
  return target.contains(event.target);
}

export function bindHerdrRemoteScroll(
  target: HTMLElement,
  isAttached: () => boolean,
  sendScroll: (gesture: HerdrScrollGesture) => void,
  size: () => HerdrPointerSize,
): () => void {
  const onWheel = (event: Event): void => {
    if (
      !(event instanceof WheelEvent) ||
      !isAttached() ||
      !isPointerInsideTarget(event, target) ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const { cols, rows } = size();
    const gesture = buildHerdrWheelScroll(
      event.deltaY,
      cellFromPointer(event, target, cols, rows),
    );
    if (!gesture) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    sendScroll(gesture);
  };
  const onKeyDown = (event: Event): void => {
    if (
      !(event instanceof KeyboardEvent) ||
      !isAttached() ||
      !isPointerInsideTarget(event, target) ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    if (event.key !== "PageUp" && event.key !== "PageDown") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    sendScroll(buildHerdrPageScroll(event.key, size().rows));
  };
  window.addEventListener("wheel", onWheel, WHEEL_OPTIONS);
  window.addEventListener("keydown", onKeyDown, KEY_OPTIONS);
  return () => {
    window.removeEventListener("wheel", onWheel, WHEEL_OPTIONS);
    window.removeEventListener("keydown", onKeyDown, KEY_OPTIONS);
  };
}

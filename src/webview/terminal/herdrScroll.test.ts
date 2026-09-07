// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  bindHerdrRemoteScroll,
  buildHerdrPageScroll,
  buildHerdrWheelScroll,
  cellFromPointer,
  herdrScrollback,
  isPointerInsideTarget,
  shouldInterceptHerdrScroll,
  wheelStepCount,
} from "./herdrScroll";

function stubBounds(target: HTMLElement): void {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 80,
    bottom: 24,
    width: 80,
    height: 24,
    toJSON() {
      return {};
    },
  });
}

describe("shouldInterceptHerdrScroll", () => {
  it("is true only while a Herdr session is attaching or attached", () => {
    expect(shouldInterceptHerdrScroll("herdr", "attached")).toBe(true);
    expect(shouldInterceptHerdrScroll("herdr", "attaching")).toBe(true);
    expect(shouldInterceptHerdrScroll("herdr", "detaching")).toBe(false);
    expect(shouldInterceptHerdrScroll("shell", "shell")).toBe(false);
  });
});

describe("herdrScrollback", () => {
  it("disables local xterm history while attached", () => {
    expect(herdrScrollback(true, 10000)).toBe(0);
    expect(herdrScrollback(false, 10000)).toBe(10000);
  });
});

describe("wheelStepCount", () => {
  it("maps deltaY into 1-15 wheel lines", () => {
    expect(wheelStepCount(0)).toBe(0);
    expect(wheelStepCount(-10)).toBe(1);
    expect(wheelStepCount(120)).toBe(3);
    expect(wheelStepCount(1000)).toBe(15);
  });
});

describe("buildHerdrWheelScroll", () => {
  it("builds a Herdr wheel scroll gesture", () => {
    expect(buildHerdrWheelScroll(-120, { column: 4, row: 7 })).toEqual({
      direction: "up",
      lines: 3,
      source: "wheel",
      column: 4,
      row: 7,
      modifiers: 0,
    });
    expect(buildHerdrWheelScroll(120, { column: 8, row: 9 })).toEqual({
      direction: "down",
      lines: 3,
      source: "wheel",
      column: 8,
      row: 9,
      modifiers: 0,
    });
  });
});

describe("buildHerdrPageScroll", () => {
  it("builds page-key scroll gestures sized to the viewport", () => {
    expect(buildHerdrPageScroll("PageUp", 24)).toEqual({
      direction: "up",
      lines: 24,
      source: "page_key",
      column: 0,
      row: 0,
      modifiers: 0,
    });
  });
});

describe("cellFromPointer", () => {
  it("maps pointer position onto 1-based terminal cells", () => {
    const target = document.createElement("div");
    stubBounds(target);
    expect(cellFromPointer({ clientX: 0, clientY: 0 }, target, 80, 24)).toEqual({
      column: 1,
      row: 1,
    });
  });
});

describe("bindHerdrRemoteScroll", () => {
  it("captures wheel on window and posts Herdr scroll gestures", () => {
    let attached = false;
    const sendScroll = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    stubBounds(target);
    const unbind = bindHerdrRemoteScroll(
      target,
      () => attached,
      sendScroll,
      () => ({ cols: 80, rows: 24 }),
    );
    const wheel = new WheelEvent("wheel", {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
    });
    Object.defineProperty(wheel, "target", { value: target });

    window.dispatchEvent(wheel);
    expect(sendScroll).not.toHaveBeenCalled();

    attached = true;
    window.dispatchEvent(wheel);
    expect(sendScroll).toHaveBeenCalledWith({
      direction: "up",
      lines: 3,
      source: "wheel",
      column: 1,
      row: 1,
      modifiers: 0,
    });

    unbind();
    target.remove();
  });

  it("ignores wheel events outside the terminal surface", () => {
    const sendScroll = vi.fn();
    const target = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(target, outside);
    stubBounds(target);
    const unbind = bindHerdrRemoteScroll(
      target,
      () => true,
      sendScroll,
      () => ({ cols: 80, rows: 24 }),
    );
    const wheel = new WheelEvent("wheel", {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(wheel, "target", { value: outside });
    window.dispatchEvent(wheel);
    expect(sendScroll).not.toHaveBeenCalled();
    unbind();
    target.remove();
    outside.remove();
  });
});

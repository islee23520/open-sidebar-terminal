// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createKeyboardHandler } from "./keyboard";

const createKeyboardEvent = (
  init: KeyboardEventInit & { code: string },
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });

  Object.defineProperty(event, "code", {
    value: init.code,
  });

  return event;
};

describe("createKeyboardHandler", () => {
  describe("on macOS", () => {
    const makeKeyboard = () => createKeyboardHandler({ isMac: true });

    it("passes Cmd+letter chords through to VS Code", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        metaKey: true,
        key: "b",
        code: "KeyB",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("passes Cmd+Shift+letter chords through to VS Code", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        metaKey: true,
        shiftKey: true,
        key: "P",
        code: "KeyP",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("passes Cmd+digit chords through to VS Code", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        metaKey: true,
        key: "1",
        code: "Digit1",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("keeps Ctrl+letter chords with xterm for terminal control characters", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        ctrlKey: true,
        key: "c",
        code: "KeyC",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe("on Windows/Linux", () => {
    const makeKeyboard = () => createKeyboardHandler({ isMac: false });

    it("passes Ctrl+letter chords through to VS Code", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        ctrlKey: true,
        key: "b",
        code: "KeyB",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("passes Ctrl+Shift+letter chords through to VS Code", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        ctrlKey: true,
        shiftKey: true,
        key: "P",
        code: "KeyP",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("passes Ctrl+digit chords through to VS Code", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        ctrlKey: true,
        key: "1",
        code: "Digit1",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("keeps stray Cmd+letter chords with xterm", () => {
      const keyboard = makeKeyboard();
      const event = createKeyboardEvent({
        metaKey: true,
        key: "b",
        code: "KeyB",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe("platform agnostic", () => {
    it("does not intercept plain letter keys", () => {
      const keyboard = createKeyboardHandler({ isMac: true });
      const event = createKeyboardEvent({
        key: "l",
        code: "KeyL",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it("does not intercept Alt-modified chords", () => {
      const keyboard = createKeyboardHandler({ isMac: true });
      const event = createKeyboardEvent({
        ctrlKey: true,
        altKey: true,
        key: "m",
        code: "KeyM",
      });

      const allowed = keyboard.handler(event);

      expect(allowed).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });

    it("keeps Cmd+Ctrl combos with xterm on either platform", () => {
      const makeEvent = () =>
        createKeyboardEvent({
          metaKey: true,
          ctrlKey: true,
          key: "p",
          code: "KeyP",
        });

      const macKeyboard = createKeyboardHandler({ isMac: true });
      const macEvent = makeEvent();
      expect(macKeyboard.handler(macEvent)).toBe(true);
      expect(macEvent.defaultPrevented).toBe(true);

      const winKeyboard = createKeyboardHandler({ isMac: false });
      const winEvent = makeEvent();
      expect(winKeyboard.handler(winEvent)).toBe(true);
      expect(winEvent.defaultPrevented).toBe(true);
    });
  });
});

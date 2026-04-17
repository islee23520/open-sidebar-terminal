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

const expectKeyboardHandling = (
  keyboard: ReturnType<typeof createKeyboardHandler>,
  init: KeyboardEventInit & { code: string },
  expectedAllowed: boolean,
  expectedDefaultPrevented: boolean,
) => {
  const event = createKeyboardEvent(init);

  expect(keyboard.handler(event)).toBe(expectedAllowed);
  expect(event.defaultPrevented).toBe(expectedDefaultPrevented);
};

describe("createKeyboardHandler", () => {
  describe("on macOS", () => {
    const makeKeyboard = () => createKeyboardHandler({ isMac: true });

    it("passes Cmd+letter chords through to VS Code", () => {
      expectKeyboardHandling(makeKeyboard(), {
        metaKey: true,
        key: "b",
        code: "KeyB",
      }, false, false);
    });

    it("passes Cmd+Shift+letter chords through to VS Code", () => {
      expectKeyboardHandling(makeKeyboard(), {
        metaKey: true,
        shiftKey: true,
        key: "P",
        code: "KeyP",
      }, false, false);
    });

    it("passes Cmd+digit chords through to VS Code", () => {
      expectKeyboardHandling(makeKeyboard(), {
        metaKey: true,
        key: "1",
        code: "Digit1",
      }, false, false);
    });

    it("keeps Ctrl+letter chords with xterm for terminal control characters", () => {
      expectKeyboardHandling(makeKeyboard(), {
        ctrlKey: true,
        key: "c",
        code: "KeyC",
      }, true, true);
    });
  });

  describe("on Windows/Linux", () => {
    const makeKeyboard = () => createKeyboardHandler({ isMac: false });

    it("passes Ctrl+letter chords through to VS Code", () => {
      expectKeyboardHandling(makeKeyboard(), {
        ctrlKey: true,
        key: "b",
        code: "KeyB",
      }, false, false);
    });

    it("passes Ctrl+Shift+letter chords through to VS Code", () => {
      expectKeyboardHandling(makeKeyboard(), {
        ctrlKey: true,
        shiftKey: true,
        key: "P",
        code: "KeyP",
      }, false, false);
    });

    it("passes Ctrl+digit chords through to VS Code", () => {
      expectKeyboardHandling(makeKeyboard(), {
        ctrlKey: true,
        key: "1",
        code: "Digit1",
      }, false, false);
    });

    it("keeps stray Cmd+letter chords with xterm", () => {
      expectKeyboardHandling(makeKeyboard(), {
        metaKey: true,
        key: "b",
        code: "KeyB",
      }, true, true);
    });
  });

  describe("platform agnostic", () => {
    it("does not intercept plain letter keys", () => {
      const keyboard = createKeyboardHandler({ isMac: true });
      expectKeyboardHandling(keyboard, {
        key: "l",
        code: "KeyL",
      }, true, false);
    });

    it("does not intercept Alt-modified chords", () => {
      const keyboard = createKeyboardHandler({ isMac: true });
      expectKeyboardHandling(keyboard, {
        ctrlKey: true,
        altKey: true,
        key: "m",
        code: "KeyM",
      }, true, false);
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

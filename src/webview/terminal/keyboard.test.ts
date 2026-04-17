// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createKeyboardHandler } from "./keyboard";

vi.mock("../ai-tool-selector", () => ({
  isVisible: vi.fn(() => false),
}));

vi.mock("../clipboard", () => ({
  copySelectionToClipboard: vi.fn(),
  handlePasteWithImageSupport: vi.fn(),
}));

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
}));

import {
  copySelectionToClipboard,
  handlePasteWithImageSupport,
} from "../clipboard";
import { postMessage } from "../shared/vscode-api";

describe("createKeyboardHandler", () => {
  const createTerminal = (selection = "") =>
    ({
      getSelection: vi.fn(() => selection),
    }) as unknown as Terminal;

  const createKeyboardEvent = (
    type: string,
    init: KeyboardEventInit & { code: string },
  ): KeyboardEvent => {
    const event = new KeyboardEvent(type, init);
    Object.defineProperty(event, "code", {
      value: init.code,
    });
    return event;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies the selection for Ctrl+C even with a Korean-layout key", () => {
    const terminal = createTerminal("selected text");
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });
    const event = createKeyboardEvent("keydown", {
      ctrlKey: true,
      key: "ㅊ",
      code: "KeyC",
      bubbles: true,
      cancelable: true,
    });

    const allowed = keyboard.handler(event);

    expect(allowed).toBe(false);
    expect(copySelectionToClipboard).toHaveBeenCalledWith("selected text");
    expect(onTerminalInput).not.toHaveBeenCalled();
  });

  it("sends the English control character for Ctrl shortcuts typed on a Korean layout", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });
    const event = createKeyboardEvent("keydown", {
      ctrlKey: true,
      key: "ㅠ",
      code: "KeyB",
      bubbles: true,
      cancelable: true,
    });

    const allowed = keyboard.handler(event);

    expect(allowed).toBe(false);
    expect(onTerminalInput).toHaveBeenCalledWith("\u0002");
  });

  it("treats following letter keys as English during a pending shortcut sequence", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });

    const leader = createKeyboardEvent("keydown", {
      ctrlKey: true,
      key: "ㅠ",
      code: "KeyB",
      bubbles: true,
      cancelable: true,
    });
    const followup = createKeyboardEvent("keydown", {
      key: "ㅌ",
      code: "KeyX",
      bubbles: true,
      cancelable: true,
    });

    keyboard.handler(leader);
    const allowed = keyboard.handler(followup);

    expect(allowed).toBe(false);
    expect(onTerminalInput).toHaveBeenNthCalledWith(1, "\u0002");
    expect(onTerminalInput).toHaveBeenNthCalledWith(2, "x");
  });

  it("maps Ctrl+ㅠ followed by ㄴ to b then s during the sequence", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });

    const leader = createKeyboardEvent("keydown", {
      ctrlKey: true,
      key: "ㅠ",
      code: "KeyB",
      bubbles: true,
      cancelable: true,
    });
    const followup = createKeyboardEvent("keydown", {
      key: "ㄴ",
      code: "KeyS",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(followup, "isComposing", {
      value: true,
    });

    keyboard.handler(leader);
    const allowed = keyboard.handler(followup);

    expect(allowed).toBe(false);
    expect(onTerminalInput).toHaveBeenNthCalledWith(1, "\u0002");
    expect(onTerminalInput).toHaveBeenNthCalledWith(2, "s");
  });

  it("falls back to Korean key mapping when the follow-up key code is unavailable", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });

    keyboard.handler(
      createKeyboardEvent("keydown", {
        ctrlKey: true,
        key: "ㅠ",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
      }),
    );

    const followup = createKeyboardEvent("keydown", {
      key: "ㄴ",
      code: "Unidentified",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(followup, "isComposing", {
      value: true,
    });

    const allowed = keyboard.handler(followup);

    expect(allowed).toBe(false);
    expect(onTerminalInput).toHaveBeenNthCalledWith(1, "\u0002");
    expect(onTerminalInput).toHaveBeenNthCalledWith(2, "s");
  });

  it("keeps translating consecutive letter keys during the 5 second shortcut window", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });

    keyboard.handler(
      createKeyboardEvent("keydown", {
        ctrlKey: true,
        key: "ㅠ",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
      }),
    );

    vi.advanceTimersByTime(3000);

    keyboard.handler(
      createKeyboardEvent("keydown", {
        key: "ㅌ",
        code: "KeyX",
        bubbles: true,
        cancelable: true,
      }),
    );

    keyboard.handler(
      createKeyboardEvent("keydown", {
        key: "ㅊ",
        code: "KeyC",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onTerminalInput).toHaveBeenNthCalledWith(2, "x");
    expect(onTerminalInput).toHaveBeenNthCalledWith(3, "c");
  });

  it("stops the shortcut sequence after 5 seconds", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });

    keyboard.handler(
      createKeyboardEvent("keydown", {
        ctrlKey: true,
        key: "ㅠ",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
      }),
    );

    vi.advanceTimersByTime(5001);

    const allowed = keyboard.handler(
      createKeyboardEvent("keydown", {
        key: "ㅌ",
        code: "KeyX",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(allowed).toBe(true);
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
  });

  it("ends the shortcut sequence on Escape", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });

    keyboard.handler(
      createKeyboardEvent("keydown", {
        ctrlKey: true,
        key: "ㅠ",
        code: "KeyB",
        bubbles: true,
        cancelable: true,
      }),
    );

    const escapeAllowed = keyboard.handler(
      createKeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    const followupAllowed = keyboard.handler(
      createKeyboardEvent("keydown", {
        key: "ㅌ",
        code: "KeyX",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(escapeAllowed).toBe(true);
    expect(followupAllowed).toBe(true);
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
  });

  it("keeps Ctrl+V paste working on a Korean layout", () => {
    const terminal = createTerminal();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput: vi.fn(),
      onToggleTmuxCommands: vi.fn(),
    });
    const event = createKeyboardEvent("keydown", {
      ctrlKey: true,
      key: "ㅍ",
      code: "KeyV",
      bubbles: true,
      cancelable: true,
    });

    const allowed = keyboard.handler(event);

    expect(allowed).toBe(false);
    expect(handlePasteWithImageSupport).toHaveBeenCalledTimes(1);
  });

  it("still treats Ctrl+Korean-key as a shortcut during composition", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });
    const event = createKeyboardEvent("keydown", {
      ctrlKey: true,
      key: "ㅠ",
      code: "KeyB",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", {
      value: true,
    });

    const allowed = keyboard.handler(event);

    expect(allowed).toBe(false);
    expect(onTerminalInput).toHaveBeenCalledWith("\u0002");
  });

  it("passes through composing input when no shortcut modifier is held", () => {
    const terminal = createTerminal();
    const onTerminalInput = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput,
      onToggleTmuxCommands: vi.fn(),
    });
    const event = createKeyboardEvent("keydown", {
      key: "ㅠ",
      code: "KeyB",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", {
      value: true,
    });

    const allowed = keyboard.handler(event);

    expect(allowed).toBe(true);
    expect(onTerminalInput).not.toHaveBeenCalled();
  });

  it("uses the physical key for the tmux command shortcut", () => {
    const terminal = createTerminal();
    const onToggleTmuxCommands = vi.fn();
    const keyboard = createKeyboardHandler(terminal, {
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onTerminalInput: vi.fn(),
      onToggleTmuxCommands,
    });
    const event = createKeyboardEvent("keydown", {
      ctrlKey: true,
      altKey: true,
      key: "ㅡ",
      code: "KeyM",
      bubbles: true,
      cancelable: true,
    });

    const allowed = keyboard.handler(event);

    expect(allowed).toBe(false);
    expect(onToggleTmuxCommands).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

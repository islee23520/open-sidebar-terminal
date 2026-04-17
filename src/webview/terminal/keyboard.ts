import type { Terminal } from "@xterm/xterm";
import * as AiSelector from "../ai-tool-selector";
import { postMessage } from "../shared/vscode-api";
import {
  copySelectionToClipboard,
  handlePasteWithImageSupport,
} from "../clipboard";

export function createKeyboardHandler(
  terminal: Terminal,
  options: {
    onCopy: (text: string) => void;
    onPaste: () => void;
    onTerminalInput: (data: string) => void;
    onToggleTmuxCommands: () => void;
  },
) {
  let justHandledCtrlC = false;
  let lastPasteTime = 0;
  let shortcutSequencePendingUntil = 0;

  const SHORTCUT_SEQUENCE_WINDOW_MS = 5000;

  const KOREAN_LETTER_TO_QWERTY: Record<string, string> = {
    ㅂ: "q",
    ㅈ: "w",
    ㄷ: "e",
    ㄱ: "r",
    ㅅ: "t",
    ㅛ: "y",
    ㅕ: "u",
    ㅑ: "i",
    ㅐ: "o",
    ㅔ: "p",
    ㅁ: "a",
    ㄴ: "s",
    ㅇ: "d",
    ㄹ: "f",
    ㅎ: "g",
    ㅗ: "h",
    ㅓ: "j",
    ㅏ: "k",
    ㅣ: "l",
    ㅋ: "z",
    ㅌ: "x",
    ㅊ: "c",
    ㅍ: "v",
    ㅠ: "b",
    ㅜ: "n",
    ㅡ: "m",
  };

  const getShortcutLetter = (event: KeyboardEvent): string | null => {
    if (event.code.startsWith("Key") && event.code.length === 4) {
      return event.code.slice(3).toLowerCase();
    }

    const mapped = KOREAN_LETTER_TO_QWERTY[event.key];
    if (mapped) {
      return mapped;
    }

    if (/^[a-z]$/i.test(event.key)) {
      return event.key.toLowerCase();
    }

    return null;
  };

  const getShortcutDigit = (event: KeyboardEvent): string | null => {
    if (event.code.startsWith("Digit") && event.code.length === 6) {
      return event.code.slice(5);
    }

    if (/^[0-9]$/.test(event.key)) {
      return event.key;
    }

    return null;
  };

  const toControlCharacter = (letter: string): string => {
    const upper = letter.toUpperCase();
    return String.fromCharCode(upper.charCodeAt(0) - 64);
  };

  const toPrintable = (letter: string, shiftKey: boolean): string =>
    shiftKey ? letter.toUpperCase() : letter;

  const activateShortcutSequence = (): void => {
    shortcutSequencePendingUntil = Date.now() + SHORTCUT_SEQUENCE_WINDOW_MS;
  };

  const clearShortcutSequence = (): void => {
    shortcutSequencePendingUntil = 0;
  };

  const hasPendingShortcutSequence = (): boolean =>
    shortcutSequencePendingUntil > Date.now();

  const isSequenceTerminator = (event: KeyboardEvent): boolean =>
    event.key === "Enter" || event.key === "Escape";

  const handler = (event: KeyboardEvent): boolean => {
    if (AiSelector.isVisible()) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    if (!hasPendingShortcutSequence()) {
      clearShortcutSequence();
    }

    const isMetaOrCtrl = event.metaKey || event.ctrlKey;
    const shortcutLetter = getShortcutLetter(event);
    const shortcutDigit = getShortcutDigit(event);

    // Shortcut-first dispatch:
    //   If the current keystroke is a valid shortcut candidate, treat it as a
    //   shortcut regardless of IME composition state or Korean layout.

    // 1. Alt+Ctrl/Cmd+letter — tmux helpers.
    if (event.altKey && isMetaOrCtrl) {
      if (shortcutLetter === "m") {
        activateShortcutSequence();
        event.preventDefault();
        event.stopPropagation();
        options.onToggleTmuxCommands();
        return false;
      }
      if (shortcutLetter === "t") {
        activateShortcutSequence();
        event.preventDefault();
        event.stopPropagation();
        postMessage({
          type: "executeTmuxCommand",
          commandId: "opencodeTui.browseTmuxSessions",
        });
        return false;
      }
    }

    // 2. Ctrl+C — copy selection when available.
    if (
      event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      shortcutLetter === "c"
    ) {
      const selection = terminal.getSelection();
      if (selection && selection.length > 0) {
        copySelectionToClipboard(selection);
        justHandledCtrlC = true;
        setTimeout(() => {
          justHandledCtrlC = false;
        }, 100);
        activateShortcutSequence();
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      // No selection — still honor the shortcut on non-Latin layouts so the
      // terminal receives ^C instead of a stray Hangul character.
      if (!/^[a-z]$/i.test(event.key)) {
        activateShortcutSequence();
        options.onTerminalInput(toControlCharacter("c"));
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      activateShortcutSequence();
      return true;
    }

    // 3. Ctrl+V — paste.
    if (
      event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      shortcutLetter === "v"
    ) {
      const now = Date.now();
      if (now - lastPasteTime < 500) {
        return false;
      }
      lastPasteTime = now;
      activateShortcutSequence();
      event.preventDefault();
      event.stopPropagation();
      handlePasteWithImageSupport();
      return false;
    }

    // 4. Ctrl+letter — translate to ^X on non-Latin layouts so tmux-style
    //    leader keys and readline bindings work regardless of IME state.
    if (
      event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      shortcutLetter &&
      !/^[a-z]$/i.test(event.key)
    ) {
      activateShortcutSequence();
      options.onTerminalInput(toControlCharacter(shortcutLetter));
      event.preventDefault();
      event.stopPropagation();
      return false;
    }

    // 5. Any other modifier-carrying shortcut candidate just starts/refreshes
    //    the pending sequence window and falls through for the terminal to
    //    handle natively.
    if (isMetaOrCtrl && !event.altKey && (shortcutLetter || shortcutDigit)) {
      activateShortcutSequence();
      return true;
    }

    // 6. Pending sequence follow-up:
    //    If the leader already armed the window, treat subsequent keystrokes
    //    as English shortcut candidates (letters + digits). All other keys
    //    end the sequence and fall through as normal input.
    if (hasPendingShortcutSequence() && !isMetaOrCtrl && !event.altKey) {
      if (isSequenceTerminator(event)) {
        clearShortcutSequence();
        return true;
      }

      if (shortcutLetter) {
        options.onTerminalInput(toPrintable(shortcutLetter, event.shiftKey));
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      if (shortcutDigit) {
        options.onTerminalInput(shortcutDigit);
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
    }

    // 7. Outside of a shortcut sequence, leave IME / Hangul composition alone.
    if (event.isComposing) {
      return true;
    }

    return true;
  };

  return {
    handler,
    get justHandledCtrlC() {
      return justHandledCtrlC;
    },
    setJustHandledCtrlC(value: boolean) {
      justHandledCtrlC = value;
    },
    clearShortcutSequence,
  };
}

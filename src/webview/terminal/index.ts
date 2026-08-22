import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { HostMessage } from "../../types";
import { postMessage } from "../shared/vscode-api";
import { readTerminalTheme, watchTerminalTheme } from "./theme";
import "./terminal.css";

export interface TerminalView {
  readonly terminal: Terminal;
  dispose(): void;
}

export const DEFAULT_FONT_FAMILY =
  "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', Menlo, Monaco, 'Apple SD Gothic Neo', 'Malgun Gothic', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans', 'Noto Sans CJK KR', 'Noto Sans CJK JP', 'Noto Sans CJK SC', monospace";

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

type RendererPreference = "webgl" | "dom";

export function isSourceStateMessage(
  msg: unknown,
): msg is Extract<HostMessage, { type: "sourceState" }> {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const candidate = msg as Record<string, unknown>;
  if (candidate.type !== "sourceState") {
    return false;
  }
  if (candidate.source !== "shell" && candidate.source !== "herdr") {
    return false;
  }
  if (
    candidate.phase !== "shell" &&
    candidate.phase !== "attaching" &&
    candidate.phase !== "attached" &&
    candidate.phase !== "detaching" &&
    candidate.phase !== "error"
  ) {
    return false;
  }
  if (candidate.label !== undefined && typeof candidate.label !== "string") {
    return false;
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    return false;
  }
  return true;
}

function readRendererPreference(): RendererPreference {
  return (globalThis as { __ulwRenderer?: unknown }).__ulwRenderer === "dom"
    ? "dom"
    : "webgl";
}

export function createTerminalView(container: HTMLElement): TerminalView {
  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: 14,
    scrollback: 10000,
    theme: readTerminalTheme(),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  if (readRendererPreference() !== "dom") {
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch (error) {
      console.warn("WebGL renderer unavailable, using DOM renderer:", error);
    }
  }

  let imeComposing = false;
  const textarea = terminal.textarea;
  const detachImeListeners: Array<() => void> = [];
  if (textarea) {
    textarea.setAttribute("inputmode", "text");
    textarea.setAttribute("enterkeyhint", "enter");
    const markImeComposing = (): void => {
      imeComposing = true;
    };
    const clearImeComposing = (): void => {
      imeComposing = false;
    };
    textarea.addEventListener("compositionstart", markImeComposing);
    textarea.addEventListener("compositionupdate", markImeComposing);
    textarea.addEventListener("compositionend", clearImeComposing);
    detachImeListeners.push(() => {
      textarea.removeEventListener("compositionstart", markImeComposing);
      textarea.removeEventListener("compositionupdate", markImeComposing);
      textarea.removeEventListener("compositionend", clearImeComposing);
    });
  }

  const inputDisposable = terminal.onData((data) => {
    postMessage({ type: "input", data });
  });
  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    postMessage({ type: "resize", cols, rows });
  });
  const repaint = (): void => {
    terminal.refresh(0, terminal.rows - 1);
  };
  const fitAndRepaintUnlessImeComposing = (): void => {
    if (imeComposing) {
      return;
    }
    fitAddon.fit();
    repaint();
  };
  const resizeObserver = new ResizeObserver(() => {
    fitAndRepaintUnlessImeComposing();
  });
  resizeObserver.observe(container);
  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          fitAndRepaintUnlessImeComposing();
        }
      }
    },
    { threshold: 0.1 },
  );
  visibilityObserver.observe(container);
  const copySelection = () => {
    const text = terminal.getSelection();
    if (text) {
      postMessage({ type: "copy", text });
    }
  };
  container.addEventListener("mouseup", copySelection);
  const focusTerminal = (): void => {
    terminal.focus();
  };
  container.addEventListener("mousedown", focusTerminal);
  const disposeThemeWatcher = watchTerminalTheme(() => {
    terminal.options.theme = readTerminalTheme();
  });

  const handlePasteEvent = (event: ClipboardEvent): void => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) =>
      ALLOWED_IMAGE_TYPES.includes(item.type as (typeof ALLOWED_IMAGE_TYPES)[number]),
    );
    if (!imageItem) {
      return;
    }

    const blob = imageItem.getAsFile();
    if (!blob || blob.size > MAX_IMAGE_SIZE) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        postMessage({ type: "imagePasted", data: reader.result });
      }
    };
    reader.readAsDataURL(blob);
  };
  container.addEventListener("paste", handlePasteEvent);

  let badgeElement: HTMLDivElement | undefined;
  const updateBadge = (message: Extract<HostMessage, { type: "sourceState" }>) => {
    if (message.phase === "shell") {
      if (badgeElement) {
        badgeElement.remove();
        badgeElement = undefined;
      }
      return;
    }

    if (!badgeElement) {
      badgeElement = document.createElement("div");
      badgeElement.className = "ulw-status-badge";
      badgeElement.setAttribute("role", "status");
      badgeElement.setAttribute("aria-live", "polite");
      container.appendChild(badgeElement);
    }

    if (message.phase === "error") {
      badgeElement.classList.add("error");
      badgeElement.textContent = message.message ? `Error: ${message.message}` : "Error attaching";
    } else {
      badgeElement.classList.remove("error");
      const phaseText = message.phase.charAt(0).toUpperCase() + message.phase.slice(1);
      badgeElement.textContent = message.label ? `${phaseText}: ${message.label}` : phaseText;
    }
  };

  const messageHandler = (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "output":
        terminal.write(message.data);
        break;
      case "exit":
        terminal.write(
          `\r\n\x1b[31mShell exited with code ${message.code}. Reopen the view to start a new shell.\x1b[0m\r\n`,
        );
        break;
      case "config":
        terminal.options.fontSize = message.fontSize;
        terminal.options.fontFamily = message.fontFamily;
        terminal.options.cursorBlink = message.cursorBlink;
        terminal.options.cursorStyle = message.cursorStyle;
        terminal.options.scrollback = message.scrollback;
        fitAndRepaintUnlessImeComposing();
        break;
      case "focus":
        terminal.focus();
        break;
      case "clipboardImage":
        terminal.paste(message.filePath);
        break;
      case "reset":
        terminal.reset();
        break;
      case "sourceState":
        if (isSourceStateMessage(message)) {
          updateBadge(message);
        }
        break;
      default: {
        const _exhaustiveCheck: never = message;
        break;
      }
    }
  };
  window.addEventListener("message", messageHandler);

  requestAnimationFrame(() => {
    fitAndRepaintUnlessImeComposing();
    postMessage({ type: "ready", cols: terminal.cols, rows: terminal.rows });
    terminal.focus();
  });

  return {
    terminal,
    dispose() {
      window.removeEventListener("message", messageHandler);
      container.removeEventListener("mouseup", copySelection);
      container.removeEventListener("mousedown", focusTerminal);
      container.removeEventListener("paste", handlePasteEvent);
      for (const detach of detachImeListeners) {
        detach();
      }
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      disposeThemeWatcher();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
    },
  };
}

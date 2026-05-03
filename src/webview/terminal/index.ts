import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { readTerminalConfig } from "./config";
import { createKeyboardHandler } from "./keyboard";
import {
  setupResizeHandling,
  setupVisibilityHandling,
  performInitialFit,
} from "./resize";
import { createLinkProvider } from "../links";
import { handleDrop } from "../dragdrop";
import { postMessage } from "../shared/vscode-api";

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  dispose: () => void;
}

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export function initTerminal(
  container: HTMLElement,
  options: {
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onToggleTmuxCommands: () => void;
  },
): TerminalInstance | null {
  const config = readTerminalConfig(container);

  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  const terminal = new Terminal({
    cursorBlink: config.cursorBlink,
    cursorStyle: config.cursorStyle,
    fontSize: config.fontSize,
    fontFamily: config.fontFamily,
    theme: {
      background: "#1e1e1e",
      foreground: "#cccccc",
    },
    scrollback: config.scrollback,
  });

  const keyboardHandler = createKeyboardHandler({
    sendInput: (data) => options.onData(data),
  });
  terminal.attachCustomKeyEventHandler(keyboardHandler.handler);

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(
    new WebLinksAddon((_, url) => {
      postMessage({
        type: "openUrl",
        url: url,
      });
    }),
  );

  terminal.registerLinkProvider(createLinkProvider(terminal));

  terminal.open(container);
  terminal.focus();
  terminal.write(MOUSE_ENABLE);

  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    terminal.loadAddon(webglAddon);
  } catch (error) {
    console.warn(
      "WebGL renderer not available, falling back to canvas:",
      error,
    );
  }

  const refreshTerminal = () => terminal.refresh(0, terminal.rows - 1);
  container.addEventListener("focusin", refreshTerminal);
  container.addEventListener("click", refreshTerminal);

  const cleanupVisibility = setupVisibilityHandling(
    terminal,
    fitAddon,
    container,
  );
  performInitialFit(terminal, fitAddon);
  const cleanupResize = setupResizeHandling(terminal, fitAddon, container);

  terminal.onData((data) => {
    if (data) {
      options.onData(data);
    }
  });

  terminal.onResize(({ cols, rows }) => {
    options.onResize(cols, rows);
  });

  const dragOverHandler = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const hasFiles = e.dataTransfer.types.some(
      (t) =>
        t === "Files" ||
        t === "text/uri-list" ||
        t.startsWith("application/vnd.code."),
    );
    if (!hasFiles) return;
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = "0.7";
  };

  const dragLeaveHandler = (e: DragEvent) => {
    if (!e.relatedTarget) {
      container.style.opacity = "1";
    }
  };

  const dropHandler = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = "1";

    await handleDrop(e, {
      getTerminalCols: () => terminal.cols,
      getTerminalRows: () => terminal.rows,
      getScreenElement: () =>
        terminal.element?.querySelector(".xterm-screen") ?? null,
    });
  };

  // Attach at window level so Finder/OS drags are caught even when
  // xterm's WebGL canvas layers are under the cursor.
  window.addEventListener("dragover", dragOverHandler);
  window.addEventListener("dragleave", dragLeaveHandler);
  window.addEventListener("drop", dropHandler);

  const dispose = () => {
    cleanupResize();
    cleanupVisibility();
    container.removeEventListener("focusin", refreshTerminal);
    container.removeEventListener("click", refreshTerminal);
    window.removeEventListener("dragover", dragOverHandler);
    window.removeEventListener("dragleave", dragLeaveHandler);
    window.removeEventListener("drop", dropHandler);
    terminal.write(MOUSE_DISABLE);
    terminal.dispose();
  };

  return {
    terminal,
    fitAddon,
    dispose,
  };
}

export function setMouseTracking(
  terminal: Terminal | null,
  enabled: boolean,
): void {
  if (!terminal) return;
  terminal.write(enabled ? MOUSE_ENABLE : MOUSE_DISABLE);
}

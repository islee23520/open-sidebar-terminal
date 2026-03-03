import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  WebviewMessage,
  HostMessage,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_SIZE,
} from "../types";

declare function acquireVsCodeApi(): {
  postMessage: (message: WebviewMessage) => void;
  getState: () => any;
  setState: (state: any) => void;
};

const vscode = acquireVsCodeApi();

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let currentPlatform: string = "";
let justHandledCtrlC = false;
let lastPasteTime = 0;
let needsRefresh = false;
let animationFrameId: number | null = null;

function scheduleRefresh() {
  needsRefresh = true;
  if (animationFrameId !== null) return;

  animationFrameId = requestAnimationFrame(() => {
    animationFrameId = null;
    if (terminal && needsRefresh) {
      terminal.refresh(0, terminal.rows - 1);
      needsRefresh = false;
    }
  });
}

function copySelectionToClipboard(selection: string): void {
  navigator.clipboard.writeText(selection).catch(() => {
    vscode.postMessage({
      type: "setClipboard",
      text: selection,
    });
  });
}

async function handlePasteWithImageSupport(): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => ALLOWED_IMAGE_TYPES.includes(t));
      if (imageType) {
        const blob = await item.getType(imageType);
        if (blob.size > MAX_IMAGE_SIZE) {
          console.warn("Image too large, falling back to text paste");
          break;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            vscode.postMessage({
              type: "imagePasted",
              data: reader.result,
            });
          }
        };
        reader.onerror = () => {
          console.error("FileReader failed to read image");
          vscode.postMessage({ type: "triggerPaste" });
        };
        reader.onabort = () => {
          vscode.postMessage({ type: "triggerPaste" });
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  } catch (err) {
    console.warn(
      "Could not read image from clipboard, falling back to text paste:",
      err,
    );
  }
  vscode.postMessage({ type: "triggerPaste" });
}

function initTerminal(): void {
  const container = document.getElementById("terminal-container");
  if (!container) return;

  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  container.addEventListener("mousedown", (event) => {
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "monospace",
    theme: {
      background: "#1e1e1e",
      foreground: "#cccccc",
    },
    scrollback: 10000,
  });

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
    const isCtrlC =
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "c" || event.key === "C");

    if (isCtrlC) {
      const selection = terminal?.getSelection();
      if (selection && selection.length > 0) {
        copySelectionToClipboard(selection);
        justHandledCtrlC = true;
        setTimeout(() => {
          justHandledCtrlC = false;
        }, 100);
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      return true;
    }

    if (event.ctrlKey && (event.key === "v" || event.key === "V")) {
      const now = Date.now();
      if (now - lastPasteTime < 500) {
        return false;
      }
      lastPasteTime = now;
      event.preventDefault();
      event.stopPropagation();
      handlePasteWithImageSupport();
      return false;
    }

    return true;
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(
    new WebLinksAddon((_, url) => {
      vscode.postMessage({
        type: "openUrl",
        url: url,
      });
    }),
  );

  // Register file path link provider
  terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      if (!terminal) {
        callback(undefined);
        return;
      }

      const line = terminal.buffer.active.getLine(bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);

      // Security: Limit line length to prevent ReDoS attacks
      const MAX_LINE_LENGTH = 10000;
      if (lineText.length > MAX_LINE_LENGTH) {
        callback(undefined);
        return;
      }

      const links: any[] = [];

      // Match OpenCode @file format: @path/to/file or @path/to/file#L10 or @path/to/file#L10-L20
      // Also match standard file paths: file://, /absolute, ./relative, ../relative, path:line:col
      const pathRegex =
        /(?:^[\s"'])(@?((?:file:\/\/|\/|[A-Za-z]:\\|\.?\.?\/)[^\s"'#]+|[^\s"':\/]+(?:\/[^\s"':\/]+)+)(?:#L(\d+)(?:-L?(\d+))?)?)(?=[\s"']|$)/gi;

      let match: RegExpExecArray | null = pathRegex.exec(lineText);
      let lastIndex = -1;
      while (match) {
        // Prevent infinite loop on zero-width matches
        if (match.index === lastIndex) {
          pathRegex.lastIndex++;
          match = pathRegex.exec(lineText);
          continue;
        }
        lastIndex = match.index;

        const fullMatch = match[1];
        const hasAtPrefix = fullMatch.startsWith("@");
        let path = match[2];
        const lineNumStr = match[3];
        const endLineStr = match[4];

        if (!path) continue;

        let lineNumber: number | undefined;
        let columnNumber: number | undefined;
        let endLineNumber: number | undefined;

        // Handle file:// URLs
        if (path.startsWith("file://")) {
          try {
            const url = new URL(path);
            path = decodeURIComponent(url.pathname);
            if (url.hostname && !url.pathname.startsWith("/")) {
              path = `${url.hostname}:${path}`;
            }
          } catch {
            continue;
          }
        }

        // Parse line numbers from @file#L10 or @file#L10-L20 format
        if (lineNumStr) {
          lineNumber = parseInt(lineNumStr, 10);
        }
        if (endLineStr) {
          endLineNumber = parseInt(endLineStr, 10);
        }

        // Also try to parse :line:col format for standard paths
        if (!hasAtPrefix && !lineNumStr) {
          const posRegex = /^(.*?):(\d+)(?::(\d+))?$/;
          const posMatch = path.match(posRegex);
          if (posMatch) {
            path = posMatch[1];
            lineNumber = parseInt(posMatch[2], 10);
            if (posMatch[3]) {
              columnNumber = parseInt(posMatch[3], 10);
            }
          }
        }

        // Calculate the actual start index of the clickable portion
        const index = match.index + (match[0].length - fullMatch.length);

        links.push({
          text: fullMatch,
          range: {
            start: { x: index + 1, y: bufferLineNumber },
            end: { x: index + fullMatch.length, y: bufferLineNumber },
          },
          activate: () => {
            vscode.postMessage({
              type: "openFile",
              path: path,
              line: lineNumber,
              endLine: endLineNumber,
              column: columnNumber,
            });
          },
        });

        match = pathRegex.exec(lineText);
      }

      callback(links);
    },
  });

  terminal.open(container);

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

  const refreshTerminal = () => terminal?.refresh(0, terminal.rows - 1);
  container.addEventListener("focusin", refreshTerminal);
  container.addEventListener("click", refreshTerminal);

  // Fit terminal when container becomes visible using IntersectionObserver
  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && fitAddon && terminal) {
          fitAddon.fit();
          scheduleRefresh();
        }
      });
    },
    { threshold: 0.1 },
  );
  visibilityObserver.observe(container);

  // Use requestAnimationFrame for initial fit (waits for browser paint)
  requestAnimationFrame(() => {
    if (fitAddon && terminal) {
      fitAddon.fit();
      vscode.postMessage({
        type: "ready",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }
  });

  // Backup setTimeout to ensure sizing even if RAF fires too early
  setTimeout(() => {
    if (fitAddon && terminal) {
      fitAddon.fit();
      scheduleRefresh();
      vscode.postMessage({
        type: "terminalResize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }
  }, 100);

  // Additional fit after a longer delay to handle slow rendering
  setTimeout(() => {
    if (fitAddon && terminal) {
      fitAddon.fit();
      scheduleRefresh();
    }
  }, 500);

  terminal.onData((data) => {
    if (justHandledCtrlC) {
      justHandledCtrlC = false;
      const filteredData = data.split("\u0003").join("");
      if (filteredData) {
        vscode.postMessage({
          type: "terminalInput",
          data: filteredData,
        });
      }
      return;
    }

    if (data) {
      vscode.postMessage({
        type: "terminalInput",
        data,
      });
    }
  });

  terminal.onResize(({ cols, rows }) => {
    vscode.postMessage({
      type: "terminalResize",
      cols,
      rows,
    });
  });

  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

  const handleResize = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      if (fitAddon && terminal) {
        fitAddon.fit();
        scheduleRefresh();
      }
    }, 50);
  };

  window.addEventListener("resize", handleResize);

  const resizeObserver = new ResizeObserver(() => {
    handleResize();
  });

  resizeObserver.observe(container);

  // Setup drag and drop for file references
  setupDragAndDrop(vscode);

  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = "0.7";
  });

  container.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = "1";
  });

  container.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = "1";

    if (e.dataTransfer) {
      const transferTypes = Array.from(e.dataTransfer.types ?? []);
      const transferItems = Array.from(e.dataTransfer.items ?? []);

      console.log("Drop event dataTransfer.types:", transferTypes);
      console.log("Drop event dataTransfer.items:", transferItems.length);
      console.log(
        "Drop event dataTransfer.itemTypes:",
        transferItems.map((item) => `${item.kind}:${item.type}`),
      );

      const files: string[] = [];
      const seen = new Set<string>();

      const canonicalizeForDedup = (p: string): string => {
        let s = p.trim();
        // Unify separators so C:\x and C:/x dedup
        s = s.replace(/\\/g, "/");
        // Normalize Windows drive letter to lowercase
        if (/^[A-Za-z]:\//.test(s)) {
          s = s[0].toLowerCase() + s.slice(1);
        }
        // Remove trailing slash (except root)
        if (s.length > 1) {
          s = s.replace(/\/$/, "");
        }
        return s;
      };

      const addFile = (filePath: string | null | undefined) => {
        const trimmed = filePath?.trim();
        if (!trimmed) {
          return;
        }

        const canonical = canonicalizeForDedup(trimmed);
        if (!canonical || seen.has(canonical)) {
          return;
        }

        seen.add(canonical);
        files.push(canonical);
      };

      const extractFilePathFromValue = (value: string): string | null => {
        const candidate = value.trim();

        if (!candidate || candidate.startsWith("#")) {
          return null;
        }

        try {
          const url = new URL(candidate);

          if (url.protocol === "file:") {
            const decodedPath = decodeURIComponent(url.pathname);
            const hasWindowsDrivePrefix =
              decodedPath.length >= 3 &&
              decodedPath[0] === "/" &&
              /[A-Za-z]/.test(decodedPath[1] ?? "") &&
              decodedPath[2] === ":";

            return hasWindowsDrivePrefix ? decodedPath.slice(1) : decodedPath;
          }
        } catch {
          const hasWindowsDrivePath =
            candidate.length >= 3 &&
            /[A-Za-z]/.test(candidate[0] ?? "") &&
            candidate[1] === ":" &&
            (candidate[2] === "\\" || candidate[2] === "/");

          if (candidate.startsWith("/") || hasWindowsDrivePath) {
            return candidate;
          }
        }

        return null;
      };

      const parseDroppedText = (payload: string): string[] => {
        const paths: string[] = [];
        const lines = payload
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        for (const line of lines) {
          const filePath = extractFilePathFromValue(line);
          if (filePath) {
            paths.push(filePath);
          }
        }

        if (paths.length > 0) {
          return paths;
        }

        try {
          const parsed = JSON.parse(payload) as unknown;
          const stack: unknown[] = [parsed];

          while (stack.length > 0) {
            const current = stack.pop();

            if (typeof current === "string") {
              const filePath = extractFilePathFromValue(current);
              if (filePath) {
                paths.push(filePath);
              }
              continue;
            }

            if (Array.isArray(current)) {
              stack.push(...current);
              continue;
            }

            if (current && typeof current === "object") {
              stack.push(...Object.values(current as Record<string, unknown>));
            }
          }
        } catch {}

        return paths;
      };

      const readItemString = (item: DataTransferItem): Promise<string> =>
        new Promise((resolve) => {
          item.getAsString((value) => resolve(value ?? ""));
        });

      const uriList = e.dataTransfer.getData("text/uri-list");

      if (uriList) {
        const uriListPaths = parseDroppedText(uriList);
        for (const uriListPath of uriListPaths) {
          addFile(uriListPath);
        }
      }

      const hasVsCodeInternalType = transferTypes.some((type) =>
        type.startsWith("application/vnd.code."),
      );

      if (hasVsCodeInternalType || files.length === 0) {
        for (const item of transferItems) {
          if (item.kind !== "string") {
            continue;
          }

          if (
            item.type === "text/uri-list" ||
            item.type === "text/plain" ||
            item.type.startsWith("application/vnd.code.")
          ) {
            const payload = await readItemString(item);
            const payloadPaths = parseDroppedText(payload);

            for (const payloadPath of payloadPaths) {
              addFile(payloadPath);
            }
          }
        }
      }

      if (e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          const filePath = (file as File & { path?: string }).path || file.name;
          addFile(filePath);
        }
      }

      if (files.length === 0) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
          const item = e.dataTransfer.items[i];
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) {
              const filePath =
                (file as File & { path?: string }).path || file.name;
              addFile(filePath);
            }
          }
        }
      }

      if (files.length > 0) {
        console.log(`[WEBVIEW] Sending ${files.length} files:`, files);
        vscode.postMessage({
          type: "filesDropped",
          files: files,
          shiftKey: e.shiftKey,
        });
      } else {
        console.log("[WEBVIEW] No files collected from drop event");
      }
    }
  });
}

function setupDragAndDrop(_vscode: any): void {
  const terminalElement = document.getElementById("terminal-container");
  if (!terminalElement) return;

  terminalElement.addEventListener("dragover", (e) => {
    e.preventDefault();
    terminalElement.style.border = "2px dashed var(--vscode-focusBorder)";
  });

  terminalElement.addEventListener("dragleave", (e) => {
    e.preventDefault();
    terminalElement.style.border = "";
  });

  // NOTE: Drop handler is intentionally omitted here.
  // The robust drop handler in initTerminal() handles file URI normalization
  // and covers all drop scenarios (text/uri-list, vscode internal, File objects).
}

window.addEventListener("message", (event) => {
  const message = event.data as HostMessage;

  switch (message.type) {
    case "terminalOutput":
      if (terminal) {
        terminal.write(message.data);
      }
      break;
    case "terminalExited":
      if (terminal) {
        terminal.write("\r\n\x1b[31mOpenCode exited\x1b[0m\r\n");
      }
      break;
    case "clearTerminal":
      if (terminal) {
        terminal.clear();
        terminal.reset();
        if (fitAddon) {
          fitAddon.fit();
          vscode.postMessage({
            type: "terminalResize",
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
      }
      break;
    case "focusTerminal":
      if (terminal) {
        terminal.focus();
      }
      break;
    case "webviewVisible":
      setTimeout(() => {
        if (terminal && fitAddon) {
          fitAddon.fit();
          scheduleRefresh();
          vscode.postMessage({
            type: "terminalResize",
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
      }, 50);
      break;
    case "platformInfo":
      currentPlatform = message.platform;
      break;
    case "clipboardContent":
      if (message.text && terminal) {
        terminal.paste(message.text);
      }
      break;
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTerminal);
} else {
  initTerminal();
}

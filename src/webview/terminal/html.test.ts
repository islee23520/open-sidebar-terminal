import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderTerminalHtml } from "./html";

describe("renderTerminalHtml", () => {
  it("renders one CSP-protected terminal container", () => {
    const html = renderTerminalHtml({
      cspSource: "vscode-webview:",
      nonce: "nonce",
      scriptUri: "webview.js",
    });

    expect(html.match(/id="terminal-container"/g)).toHaveLength(1);
    expect(html).toContain("script-src 'nonce-nonce'");
    expect(html).toContain('src="webview.js"');
    expect(html).not.toMatch(/tmux|zellij|pane|toolbar|dashboard/i);
  });

  it("injects the renderer preference for the webview", () => {
    const html = renderTerminalHtml({
      cspSource: "vscode-webview:",
      nonce: "nonce",
      scriptUri: "webview.js",
    });

    expect(html).toContain('window.__ulwRenderer="webgl"');
  });

  it("uses VS Code theme variables for the xterm viewport", () => {
    const css = readFileSync(
      join(process.cwd(), "src/webview/terminal.css"),
      "utf8",
    );

    expect(css).toContain("#terminal-container .xterm-viewport");
    expect(css).toContain("overflow-y: hidden");
    expect(css).toContain("--vscode-terminal-background");
    expect(css).toContain("--vscode-panel-background");
    expect(css).not.toContain("background: #1e1e1e");
  });
});

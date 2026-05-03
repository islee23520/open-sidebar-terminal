import { describe, expect, it } from "vitest";
import { renderTerminalHtml } from "./html";

describe("renderTerminalHtml", () => {
  it("assembles the terminal webview HTML with all major sections", () => {
    const html = renderTerminalHtml({
      cspSource: "vscode-resource:",
      nonce: "nonce-123",
      cssUri: "terminal.css",
      scriptUri: "webview.js",
      fontSize: "14",
      fontFamily: "monospace",
      cursorBlink: "true",
      cursorStyle: "block",
      scrollback: "10000",
    });

    expect(html).toContain('id="tmux-toolbar"');
    expect(html).toContain('id="btn-toggle-backend"');
    expect(html).toContain('id="btn-toggle-editor-attachment"');
    expect(html).toContain('id="terminal-container"');
    expect(html).toContain('id="ai-selector"');
    expect(html).toContain('id="tmux-prompt"');
  });

  it("injects runtime values into CSP, asset URLs, and terminal data attributes", () => {
    const html = renderTerminalHtml({
      cspSource: "vscode-webview-resource:",
      nonce: "abc123",
      cssUri: "style-uri",
      scriptUri: "script-uri",
      fontSize: "16",
      fontFamily: "JetBrains Mono",
      cursorBlink: "false",
      cursorStyle: "underline",
      scrollback: "5000",
    });

    expect(html).toContain(
      "style-src vscode-webview-resource: 'unsafe-inline'",
    );
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain('href="style-uri"');
    expect(html).toContain('src="script-uri"');
    expect(html).toContain('data-font-size="16"');
    expect(html).toContain('data-font-family="JetBrains Mono"');
    expect(html).toContain('data-cursor-blink="false"');
    expect(html).toContain('data-cursor-style="underline"');
    expect(html).toContain('data-scrollback="5000"');
    expect(html).not.toContain("{{");
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupBackendToggleButton,
  updateBackendToggleButtonState,
} from "./index";
import { resetVsCodeApi } from "../shared/vscode-api";

const postMessageMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  resetVsCodeApi();
  document.body.innerHTML = `<button id="btn-toggle-backend"></button>`;
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage: postMessageMock,
    getState: vi.fn(),
    setState: vi.fn(),
  }));
});

describe("toolbar backend toggle", () => {
  it("requests backend cycle on click", () => {
    setupBackendToggleButton(() => "tmux");

    document.getElementById("btn-toggle-backend")?.click();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: "cycleTerminalBackend",
    });
  });

  it("skips unavailable backends in button title", () => {
    const button = document.getElementById(
      "btn-toggle-backend",
    ) as HTMLButtonElement;

    updateBackendToggleButtonState("native", {
      native: true,
      tmux: false,
      zellij: true,
    });

    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Switch to Zellij");
    expect(button.textContent).toBe("N");

    updateBackendToggleButtonState("zellij", {
      native: true,
      tmux: false,
      zellij: true,
    });

    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Switch to Native Shell");
    expect(button.textContent).toBe("Z");
  });
});

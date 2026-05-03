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
  it("requests native shell when currently in tmux mode", () => {
    setupBackendToggleButton(() => true);

    document.getElementById("btn-toggle-backend")?.click();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: "sendTmuxPromptChoice",
      choice: "shell",
    });
  });

  it("requests tmux when currently in native mode", () => {
    setupBackendToggleButton(() => false);

    document.getElementById("btn-toggle-backend")?.click();

    expect(postMessageMock).toHaveBeenCalledWith({
      type: "sendTmuxPromptChoice",
      choice: "tmux",
    });
  });

  it("disables native-to-tmux switching when tmux is unavailable", () => {
    const button = document.getElementById(
      "btn-toggle-backend",
    ) as HTMLButtonElement;

    updateBackendToggleButtonState(false, false);

    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Tmux is not available");

    updateBackendToggleButtonState(true, false);

    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Switch to Native Shell");
  });
});

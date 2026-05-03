import { describe, expect, it } from "vitest";
import { StaticTerminalBackend, TerminalBackendRegistry } from "./terminalBackends";

describe("TerminalBackendRegistry", () => {
  it("resolves unavailable backends to native", () => {
    const registry = new TerminalBackendRegistry([
      new StaticTerminalBackend("native", "Native", true),
      new StaticTerminalBackend("tmux", "Tmux", false),
      new StaticTerminalBackend("zellij", "Zellij", false),
    ]);

    expect(registry.resolveAvailable("tmux")).toBe("native");
    expect(registry.getAvailability()).toEqual({
      native: true,
      tmux: false,
      zellij: false,
    });
  });

  it("cycles native to the next available backend", () => {
    const registry = new TerminalBackendRegistry([
      new StaticTerminalBackend("native", "Native", true),
      new StaticTerminalBackend("tmux", "Tmux", false),
      new StaticTerminalBackend("zellij", "Zellij", true),
    ]);

    expect(registry.nextAvailable("native")).toBe("zellij");
    expect(registry.nextAvailable("zellij")).toBe("native");
  });
});

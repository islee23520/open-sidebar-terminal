import { describe, expect, it } from "vitest";
import { AiToolOperatorRegistry } from "./AiToolOperatorRegistry";
import { DEFAULT_AI_TOOLS } from "../../types";

describe("AiToolOperatorRegistry", () => {
  it("resolves aliased tools by name", () => {
    const registry = new AiToolOperatorRegistry();

    const resolved = registry.resolveTool(DEFAULT_AI_TOOLS, "claude");

    expect(resolved?.name).toBe("claude-code");
  });

  it("formats file references through the matching operator", () => {
    const registry = new AiToolOperatorRegistry();
    const tool = registry.resolveTool(DEFAULT_AI_TOOLS, "opencode");

    expect(tool).toBeDefined();

    const operator = registry.getForConfig(tool!);
    expect(
      operator.formatFileReference({
        path: "src/file.ts",
        selectionStart: 10,
        selectionEnd: 12,
      }),
    ).toBe("@src/file.ts#L10-L12");
  });

  it("uses operator aliases when matching a config", () => {
    const registry = new AiToolOperatorRegistry();
    const tool = {
      name: "claude-code",
      label: "Claude Code",
      path: "",
      args: [],
      aliases: ["claude"],
      operator: "claude-code",
    };

    expect(registry.getForConfig(tool).id).toBe("claude-code");
    expect(registry.matchesName(tool, "claude")).toBe(true);
  });
});

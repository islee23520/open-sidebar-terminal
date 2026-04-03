import {
  AiToolConfig,
  DEFAULT_AI_TOOLS,
  resolveAiToolConfigs,
} from "../../types";
import { AiToolOperator } from "./AiToolOperator";
import { OpenCodeToolOperator } from "./operators/OpenCodeToolOperator";
import { ClaudeCodeToolOperator } from "./operators/ClaudeCodeToolOperator";
import { CodexToolOperator } from "./operators/CodexToolOperator";

export class AiToolOperatorRegistry {
  private readonly operators: AiToolOperator[];

  public constructor(operators?: AiToolOperator[]) {
    this.operators = operators ?? [
      new OpenCodeToolOperator(),
      new ClaudeCodeToolOperator(),
      new CodexToolOperator(),
    ];
  }

  public getByToolName(name: string): AiToolOperator | undefined {
    return this.operators.find((operator) =>
      [operator.id, ...operator.aliases].includes(name),
    );
  }

  public getForConfig(tool: AiToolConfig): AiToolOperator {
    const matched = this.operators.find((operator) => operator.matches(tool));
    if (matched) {
      return matched;
    }

    return new CodexToolOperator();
  }

  public resolveTool(
    userTools: readonly unknown[],
    preferredToolName?: string,
  ): AiToolConfig | undefined {
    const tools = resolveAiToolConfigs(userTools);
    if (!preferredToolName) {
      return tools[0] ?? DEFAULT_AI_TOOLS[0];
    }

    return tools.find((tool) => this.matchesName(tool, preferredToolName));
  }

  public matchesName(tool: AiToolConfig, name: string): boolean {
    if (tool.name === name || tool.operator === name) {
      return true;
    }

    return (tool.aliases ?? []).includes(name);
  }
}

import { AiToolFileReference, AiToolOperator } from "../AiToolOperator";
import { AiToolConfig, getToolLaunchCommand } from "../../../types";

export class OpenCodeToolOperator implements AiToolOperator {
  public readonly id = "opencode";
  public readonly aliases = ["open-code"] as const;

  public matches(tool: AiToolConfig): boolean {
    const names = new Set([
      tool.name,
      tool.operator,
      ...(tool.aliases ?? []),
    ]);
    return names.has(this.id) || this.aliases.some((alias) => names.has(alias));
  }

  public getLaunchCommand(tool: AiToolConfig): string {
    return getToolLaunchCommand(tool);
  }

  public supportsHttpApi(): boolean {
    return true;
  }

  public supportsAutoContext(): boolean {
    return true;
  }

  public formatFileReference(reference: AiToolFileReference): string {
    let formatted = `@${reference.path}`;
    if (reference.selectionStart !== undefined) {
      if (reference.selectionStart === reference.selectionEnd) {
        formatted += `#L${reference.selectionStart}`;
      } else {
        formatted += `#L${reference.selectionStart}-L${reference.selectionEnd}`;
      }
    }

    return formatted;
  }

  public formatDroppedFiles(
    paths: string[],
    options: { useAtSyntax: boolean },
  ): string {
    if (options.useAtSyntax) {
      return paths
        .map((file) => this.formatFileReference({ path: file }))
        .join(" ");
    }

    return paths.join(" ");
  }

  public formatPastedImage(tempPath: string): string | undefined {
    return tempPath;
  }
}

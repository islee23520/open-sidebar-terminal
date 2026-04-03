import { AiToolConfig } from "../../types";

export interface AiToolFileReference {
  path: string;
  selectionStart?: number;
  selectionEnd?: number;
}

export interface AiToolOperator {
  readonly id: string;
  readonly aliases: readonly string[];
  matches(tool: AiToolConfig): boolean;
  getLaunchCommand(tool: AiToolConfig): string;
  supportsHttpApi(tool: AiToolConfig): boolean;
  supportsAutoContext(tool: AiToolConfig): boolean;
  formatFileReference(reference: AiToolFileReference): string;
  formatDroppedFiles(
    paths: string[],
    options: { useAtSyntax: boolean },
  ): string;
  formatPastedImage(tempPath: string): string | undefined;
}

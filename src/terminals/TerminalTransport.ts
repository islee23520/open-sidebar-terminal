import type * as vscode from "vscode";
import type { HerdrScrollGesture } from "../types";

export type TerminalTransportExitReason =
  | "released"
  | "takeover"
  | "pane-exited"
  | "server-stopped"
  | "protocol-error"
  | "spawn-error"
  | "timeout"
  | "process-exit";

export interface TerminalTransport {
  readonly kind: "local-shell" | "herdr-control";
  readonly onOutput: vscode.Event<{
    data: string;
    replay: "append" | "replace";
  }>;
  readonly onExit: vscode.Event<{
    reason: TerminalTransportExitReason;
    message?: string;
  }>;
  write(data: string): void;
  scroll(gesture: HerdrScrollGesture): void;
  resize(cols: number, rows: number): void;
  close(reason: "release" | "shutdown"): Promise<void>;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface TerminalConfig {
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly cursorBlink: boolean;
  readonly cursorStyle: CursorStyle;
  readonly scrollback: number;
}

export interface HerdrScrollGesture {
  readonly direction: "up" | "down";
  readonly lines: number;
  readonly source: "wheel" | "page_key";
  readonly column: number;
  readonly row: number;
  readonly modifiers: number;
}

export type WebviewMessage =
  | { readonly type: "ready"; readonly cols: number; readonly rows: number }
  | { readonly type: "input"; readonly data: string }
  | ({ readonly type: "scroll" } & HerdrScrollGesture)
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "copy"; readonly text: string }
  | { readonly type: "imagePasted"; readonly data: string };

export type HostMessage =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "exit"; readonly code: number; readonly signal?: number }
  | ({ readonly type: "config" } & TerminalConfig)
  | { readonly type: "focus" }
  | { readonly type: "clipboardImage"; readonly filePath: string }
  | { readonly type: "reset" }
  | {
      readonly type: "sourceState";
      readonly source: "shell" | "herdr";
      readonly phase: "shell" | "attaching" | "attached" | "detaching" | "error";
      readonly label?: string;
      readonly message?: string;
    };

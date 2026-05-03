const detectMacPlatform = (): boolean =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? "");

const isLetterOrDigitCode = (code: string): boolean =>
  /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code);

export interface KeyboardHandlerOptions {
  isMac?: boolean;
  sendInput?: (data: string) => void;
}

export function createKeyboardHandler(options: KeyboardHandlerOptions = {}) {
  const isMac = options.isMac ?? detectMacPlatform();

  const isWorkbenchPrimaryModifier = (event: KeyboardEvent): boolean =>
    isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;

  const isLetterOrDigitChord = (event: KeyboardEvent): boolean =>
    !event.altKey &&
    (event.ctrlKey || event.metaKey) &&
    isLetterOrDigitCode(event.code);

  const isShiftEnter = (event: KeyboardEvent): boolean =>
    event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey;

  const handler = (event: KeyboardEvent): boolean => {
    if (isShiftEnter(event) && event.type === "keydown" && options.sendInput) {
      event.preventDefault();
      event.stopPropagation();
      options.sendInput("\r\n");
      return false;
    }

    if (!isLetterOrDigitChord(event)) {
      return true;
    }

    if (isWorkbenchPrimaryModifier(event)) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  return {
    handler,
  };
}

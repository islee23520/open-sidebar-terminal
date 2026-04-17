const detectMacPlatform = (): boolean =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? "");

const isLetterOrDigitCode = (code: string): boolean =>
  /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code);

const isLetterOrDigitChord = (event: KeyboardEvent): boolean => {
  if (event.altKey) {
    return false;
  }

  if (!event.ctrlKey && !event.metaKey) {
    return false;
  }

  return isLetterOrDigitCode(event.code);
};

export interface KeyboardHandlerOptions {
  isMac?: boolean;
}

export function createKeyboardHandler(options: KeyboardHandlerOptions = {}) {
  const isMac = options.isMac ?? detectMacPlatform();

  const isWorkbenchShortcut = (event: KeyboardEvent): boolean => {
    if (event.altKey) {
      return false;
    }

    const hasPrimaryModifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;

    return hasPrimaryModifier && isLetterOrDigitCode(event.code);
  };

  const handler = (event: KeyboardEvent): boolean => {
    if (isWorkbenchShortcut(event)) {
      return false;
    }

    if (isLetterOrDigitChord(event)) {
      event.preventDefault();
      event.stopPropagation();
    }

    return true;
  };

  return {
    handler,
  };
}

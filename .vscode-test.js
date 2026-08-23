const fs = require("fs");
const path = require("path");
const { defineConfig } = require("@vscode/test-cli");

function resolveLocalVsCodeExecutable() {
  if (process.env.VSCODE_EXECUTABLE_PATH) {
    return process.env.VSCODE_EXECUTABLE_PATH;
  }

  if (process.platform === "darwin") {
    const candidate =
      "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
    return fs.existsSync(candidate) ? candidate : undefined;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const candidate = path.join(
        localAppData,
        "Programs",
        "Microsoft VS Code",
        "Code.exe",
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  const linuxCandidates = [
    "/usr/bin/code",
    "/snap/bin/code",
    "/var/lib/flatpak/exports/bin/com.visualstudio.code",
  ];
  return linuxCandidates.find((candidate) => fs.existsSync(candidate));
}

const localVsCodeExecutable = resolveLocalVsCodeExecutable();

const packagedExtensionPath = process.env.ULW_E2E_EXTENSION_PATH;

const shared = {
  version: "stable",
  workspaceFolder: "src/test/e2e/fixtures/workspace",
  ...(packagedExtensionPath
    ? { extensionDevelopmentPath: packagedExtensionPath }
    : {}),
  ...(localVsCodeExecutable
    ? {
        useInstallation: {
          fromPath: localVsCodeExecutable,
        },
      }
    : {}),
  mocha: {
    ui: "tdd",
    timeout: 20000,
  },
};

const herdrRequested = process.argv.some(
  (argument, index, argv) =>
    argument === "--label=herdr" ||
    (argument === "--label" && argv[index + 1] === "herdr"),
);

module.exports = defineConfig(
  herdrRequested
    ? {
        ...shared,
        label: "herdr",
        files: "out/test/e2e/suite/herdr-attach.e2e.js",
      }
    : {
        ...shared,
        files: "out/test/e2e/suite/activation.e2e.js",
      },
);

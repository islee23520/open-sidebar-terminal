import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

type Manifest = {
  readonly activationEvents?: readonly string[];
  readonly contributes: {
    readonly commands?: readonly unknown[];
    readonly keybindings?: readonly unknown[];
    readonly menus?: Readonly<Record<string, readonly unknown[]>>;
    readonly viewsContainers: Readonly<
      Record<string, readonly { readonly id: string }[]>
    >;
    readonly views: Readonly<
      Record<string, readonly { readonly id: string; readonly type: string }[]>
    >;
    readonly configuration: {
      readonly properties: Readonly<Record<string, unknown>>;
    };
  };
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
};

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  ) as Manifest;
}

describe("minimal sidebar terminal topology", () => {
  it("keeps the secondary-sidebar view and activation hooks for both locations", () => {
    const manifest = readManifest();

    expect(manifest.activationEvents).toEqual([
      "onView:ulw",
      "onCommand:ulw.toggleEditorLocation",
      "onCommand:ulw.sendSelectionToTerminal",
      "onCommand:ulw.sendFileToTerminal",
      "onCommand:ulw.attachHerdrSession",
      "onCommand:ulw.detachHerdrSession",
      "onStartupFinished",
    ]);
    expect(Object.keys(manifest.contributes.viewsContainers)).toEqual([
      "secondarySidebar",
    ]);
    expect(manifest.contributes.viewsContainers.secondarySidebar).toEqual([
      expect.objectContaining({ id: "ulwContainer" }),
    ]);
    expect(manifest.contributes.views.ulwContainer).toEqual([
      expect.objectContaining({ id: "ulw", type: "webview" }),
    ]);
  });

  it("exposes only terminal-related commands", () => {
    const contributes = readManifest().contributes;
    const commands = (contributes.commands ?? []) as readonly {
      command: string;
      icon?: string;
      shortTitle?: string;
    }[];
    const commandIds = commands.map((c) => c.command).sort();

    expect(commandIds).toEqual([
      "ulw.attachHerdrSession",
      "ulw.detachHerdrSession",
      "ulw.sendFileToTerminal",
      "ulw.sendSelectionToTerminal",
      "ulw.toggleEditorLocation",
    ]);
    expect(contributes.keybindings).toBeUndefined();

    const toggle = commands.find((c) => c.command === "ulw.toggleEditorLocation");
    expect(toggle?.icon).toBe("$(layout-sidebar-right)");
    expect(toggle?.shortTitle).toBe("Toggle Location");
  });

  it("surfaces the location toggle on sidebar and editor title bars", () => {
    const menus = readManifest().contributes.menus ?? {};

    expect(menus["view/title"]).toEqual([
      expect.objectContaining({
        command: "ulw.toggleEditorLocation",
        when: "view == ulw",
        group: "navigation",
      }),
    ]);
    expect(menus["editor/title"]).toEqual([
      expect.objectContaining({
        command: "ulw.toggleEditorLocation",
        when: "activeWebviewPanelId == 'ulw.terminalEditor'",
        group: "navigation",
      }),
    ]);
  });

  it("keeps only terminal and shell settings", () => {
    const propertyNames = Object.keys(
      readManifest().contributes.configuration.properties,
    ).sort();

    expect(propertyNames).toEqual([
      "ulw.cursorBlink",
      "ulw.cursorStyle",
      "ulw.defaultLocation",
      "ulw.fontFamily",
      "ulw.fontSize",
      "ulw.herdr.executablePath",
      "ulw.herdr.session",
      "ulw.herdr.socketPath",
      "ulw.renderer",
      "ulw.scrollback",
      "ulw.shellArgs",
      "ulw.shellPath",
    ]);
  });

  it("ships only node-pty and bundles xterm at build time", () => {
    const manifest = readManifest();
    expect(Object.keys(manifest.dependencies)).toEqual(["node-pty"]);
    expect(Object.keys(manifest.devDependencies)).toEqual(
      expect.arrayContaining([
      "@xterm/addon-fit",
      "@xterm/xterm",
      ]),
    );
  });
});

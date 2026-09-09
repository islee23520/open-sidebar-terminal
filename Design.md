# Existing terminal surface

Reuse the existing xterm bootstrap, VS Code theme, configured terminal font, font size and cursor. No new visual framework, palette, animation or DAG renderer.

The ULW secondary-sidebar container contains the shell view when Herdr is off and the DAG view when Herdr is on, subject to ulw.sidebar.enabled. Agent terminals remain editor tabs. The DAG uses a separate terminal slot and bridge; input, resize and scroll never target an agent editor.

Empty, unavailable and closed states are readable terminal messages with input disabled. Only complete Herdr viewport frames replace the visible terminal. Scroll continues through the existing Herdr scroll protocol. The sidebar owns its dimensions; narrowing it must resize the remote viewport without affecting agent tabs.

Accessibility follows existing xterm keyboard support and VS Code colors. The renderer remains the plugin's terminal UI; its typography and graph layout are not redesigned here.

The Herdr status-bar entry opens a native VS Code QuickPick with live agents and attachment actions. It inherits VS Code keyboard navigation and theme. Agent selection uses separate editor tabs; Open DAG enables a disabled sidebar before revealing it. The entry is hidden when Herdr is off, and selections from a stale or disposed integration are ignored.

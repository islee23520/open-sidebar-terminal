# ULW Sidebar Terminal

An existing VS Code extension built with TypeScript, webpack, xterm.js and node-pty. With Herdr disabled, one persistent local shell moves between the secondary sidebar and an editor tab. With Herdr enabled, agents use independent editor tabs connected through official Herdr control bridges.

The current module displays the existing omo-herdr-dag plugin terminal in the secondary sidebar. It does not render DAGs itself or create Herdr panes.

The same module adds a Herdr-only status-bar entry and native QuickPick for switching agents, attaching, detaching, refreshing, and opening the DAG. Management is non-destructive: remote agents keep running after detach.

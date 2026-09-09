# Current module

- [ ] Show the existing parent-associated omo-herdr-dag pane in the secondary sidebar and provide a Herdr-only status-bar management QuickPick. Support attach, switch, detach, refresh and Open DAG (including a disabled sidebar), preserve shell/agent isolation, and verify actual VS Code screenshots.

Implementation has regression coverage and the actual VS Code Herdr attach/input/resize/detach E2E passes. Module acceptance remains open: native status-bar and DAG screenshots require CuaDriver Screen Recording permission. A live parent-associated plugin DAG is available; lack of a pane is no longer the blocker. Automated tests do not substitute for native visual acceptance.

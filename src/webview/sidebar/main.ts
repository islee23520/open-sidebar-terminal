import { SessionTree } from "./SessionTree";
import { SessionTreeRenderer } from "./SessionTreeRenderer";
import { TreeSnapshot } from "./types";

export function initSidebar(vscode: any) {
  const sidebarContainer = document.getElementById("sidebar-container");
  if (!sidebarContainer) return;

  const tree = new SessionTree();
  const renderer = new SessionTreeRenderer(
    sidebarContainer,
    (sessionId) => {
      vscode.postMessage({ type: "switchSession", sessionId });
    },
    (sessionId) => {
      vscode.postMessage({ type: "killSession", sessionId });
    },
    () => {
      vscode.postMessage({ type: "createTmuxSession" });
    },
    () => {
      vscode.postMessage({ type: "switchNativeShell" });
    },
    (groupName) => {
      tree.toggleGroup(groupName);
    },
  );

  tree.subscribe((state) => {
    renderer.render(state);
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "treeSnapshot") {
      tree.updateFromSnapshot(message as TreeSnapshot);
    }
  });
}

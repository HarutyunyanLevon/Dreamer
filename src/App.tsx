import { CanvasArea } from "./components/CanvasArea";
import { ChatPanel } from "./components/ChatPanel";
import { HandoffHost } from "./components/Handoff";
import { MemoryHost } from "./components/Memory";
import { PanelTabs } from "./components/PanelTabs";
import { usePanels } from "./state/usePanels";
import { SearchPalette } from "./components/SearchPalette";
import { ShaderBackground } from "./components/ShaderBackground";
import { Sidebar } from "./components/Sidebar";
import { ImportHost } from "./components/Import";
import { useEffect, useState } from "react";
import { useWorkspace } from "./state/useWorkspace";
import { ThemeProvider } from "./theme/ThemeContext";
import { api } from "./api";

export default function App() {
  const ws = useWorkspace();
  const panels = usePanels();
  const [searchOpen, setSearchOpen] = useState(false);
  /** A failed layout migration: the workspace is read-only until it is fixed. */
  const [readOnly, setReadOnly] = useState<string | null>(null);
  useEffect(() => void api.migrationStatus().then(setReadOnly, () => {}), []);

  // Anything asking Claude (chips, card menus) brings the chat panel into view.
  const { showRight } = panels;
  useEffect(() => {
    if (ws.chatRequest) showRight();
  }, [ws.chatRequest, showRight]);

  // Ctrl+K (Cmd+K) opens card search from anywhere, even while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ThemeProvider projectTheme={ws.data?.meta.theme ?? null}>
      <ShaderBackground />
      <CanvasArea ws={ws} />
      <Sidebar
        projects={ws.projects}
        active={ws.active}
        onSelect={(s) => void ws.select(s)}
        onCreate={ws.createProject}
        onDelete={(s) => void ws.deleteProject(s)}
        memoryOpen={ws.memoryOpen}
        onOpenMemory={() => ws.setMemoryOpen(true)}
        resize={panels.resize.left}
        ws={ws}
      />
      <ChatPanel ws={ws} panels={panels} />
      <HandoffHost ws={ws} />
      <MemoryHost ws={ws} />
      <ImportHost ws={ws} />
      <PanelTabs left={panels.left} right={panels.right} onLeft={panels.toggleLeft} onRight={panels.toggleRight} />
      {searchOpen && <SearchPalette ws={ws} onClose={() => setSearchOpen(false)} />}
      {ws.notice && !ws.error && (
        <div className="toast" role="status">
          <span>{ws.notice}</span>
          {ws.noticeUndo && (
            <button type="button" className="btn primary" onClick={() => { ws.clearNotice(); void ws.undo(); }}>Undo</button>
          )}
          <button type="button" className="btn" onClick={ws.clearNotice}>Close</button>
        </div>
      )}
      {readOnly && (
        <div className="toast read-only-banner" role="alert">
          <span>Read-only. {readOnly}</span>
        </div>
      )}
      {ws.error && (
        <div className="toast" role="alert">
          <span>{ws.error}</span>
          <button type="button" className="btn" onClick={ws.clearError}>Close</button>
        </div>
      )}
    </ThemeProvider>
  );
}

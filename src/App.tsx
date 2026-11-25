import { CanvasArea } from "./components/CanvasArea";
import { CaptureWindow } from "./components/CaptureWindow";
import { ChatPanel } from "./components/ChatPanel";
import { HandoffHost } from "./components/Handoff";
import { TaskHost } from "./components/TaskPrompt";
import { BuildStartHost } from "./components/BuildPanel";
import { useBuildRuns } from "./state/buildRuns";
import { MemoryHost } from "./components/Memory";
import { PanelTabs } from "./components/PanelTabs";
import { TrayNotice } from "./components/TrayNotice";
import { usePanels } from "./state/usePanels";
import { SearchPalette } from "./components/SearchPalette";
import { ShaderBackground } from "./components/ShaderBackground";
import { Sidebar } from "./components/Sidebar";
import { VersionsHost } from "./components/Versions";
import { ImportHost } from "./components/Import";
import { ScanHost } from "./components/Scan";
import { useEffect, useState } from "react";
import { useWorkspace } from "./state/useWorkspace";
import { ThemeProvider } from "./theme/ThemeContext";

const query = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const isCapture = query.has("capture");
const toastMsg = query.has("toast") ? query.get("msg") ?? "" : null;

export default function App() {
  // The small self-closing window of the "Clipboard to Inbox" hotkey (Rust closes it).
  if (toastMsg !== null) {
    return (
      <ThemeProvider>
        <div className="capture-popup"><div className="glass hotkey-toast" role="status">{toastMsg}</div></div>
      </ThemeProvider>
    );
  }
  if (isCapture) {
    return (
      <ThemeProvider>
        <ShaderBackground />
        <CaptureWindow />
      </ThemeProvider>
    );
  }
  return <MainApp />;
}

function MainApp() {
  const ws = useWorkspace();
  const panels = usePanels();
  const [searchOpen, setSearchOpen] = useState(false);

  // Anything asking Claude (chips, card menus) brings the chat panel into view.
  const { showRight } = panels;
  useEffect(() => {
    if (ws.chatRequest) showRight();
  }, [ws.chatRequest, showRight]);
  // So does asking for the Build tab ("Run in Dreamer").
  const { tabReq } = useBuildRuns();
  useEffect(() => {
    if (tabReq) showRight();
  }, [tabReq, showRight]);

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
        onSelect={(s) => {
          ws.setDesignOpen(false);
          void ws.select(s);
        }}
        onCreate={ws.createProject}
        onDelete={(s) => void ws.deleteProject(s)}
        designOpen={ws.designOpen}
        onOpenDesign={() => ws.setDesignOpen(true)}
        memoryOpen={ws.memoryOpen}
        onOpenMemory={() => ws.setMemoryOpen(true)}
        resize={panels.resize.left}
        ws={ws}
      />
      <ChatPanel ws={ws} panels={panels} />
      <HandoffHost ws={ws} />
      <TaskHost ws={ws} />
      <BuildStartHost ws={ws} />
      <MemoryHost ws={ws} />
      <VersionsHost ws={ws} />
      <ImportHost ws={ws} />
      <ScanHost ws={ws} />
      <PanelTabs left={panels.left} right={panels.right} onLeft={panels.toggleLeft} onRight={panels.toggleRight} />
      <TrayNotice />
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
      {ws.error && (
        <div className="toast" role="alert">
          <span>{ws.error}</span>
          <button type="button" className="btn" onClick={ws.clearError}>Close</button>
        </div>
      )}
    </ThemeProvider>
  );
}

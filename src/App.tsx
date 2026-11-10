import { CanvasArea } from "./components/CanvasArea";
import { ChatPanel } from "./components/ChatPanel";
import { ShaderBackground } from "./components/ShaderBackground";
import { Sidebar } from "./components/Sidebar";
import { useWorkspace } from "./state/useWorkspace";
import { ThemeProvider } from "./theme/ThemeContext";

export default function App() {
  const ws = useWorkspace();
  return (
    <ThemeProvider>
      <ShaderBackground />
      <CanvasArea ws={ws} />
      <Sidebar projects={ws.projects} active={ws.active} onSelect={(s) => void ws.select(s)} onCreate={(n) => void ws.createProject(n)} />
      <ChatPanel />
      {ws.error && (
        <div className="toast" role="alert">
          <span>{ws.error}</span>
          <button type="button" className="btn" onClick={ws.clearError}>Close</button>
        </div>
      )}
    </ThemeProvider>
  );
}

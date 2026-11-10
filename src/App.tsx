import { CanvasArea } from "./components/CanvasArea";
import { CaptureWindow } from "./components/CaptureWindow";
import { ChatPanel } from "./components/ChatPanel";
import { ShaderBackground } from "./components/ShaderBackground";
import { Sidebar } from "./components/Sidebar";
import { useWorkspace } from "./state/useWorkspace";
import { ThemeProvider } from "./theme/ThemeContext";

const isCapture = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("capture");

export default function App() {
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
  return (
    <ThemeProvider projectTheme={ws.data?.meta.theme ?? null}>
      <ShaderBackground />
      <CanvasArea ws={ws} />
      <Sidebar projects={ws.projects} active={ws.active} onSelect={(s) => void ws.select(s)} onCreate={(n) => void ws.createProject(n)} />
      <ChatPanel ws={ws} />
      {ws.error && (
        <div className="toast" role="alert">
          <span>{ws.error}</span>
          <button type="button" className="btn" onClick={ws.clearError}>Close</button>
        </div>
      )}
    </ThemeProvider>
  );
}

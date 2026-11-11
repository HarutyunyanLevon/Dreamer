import { CanvasArea } from "./components/CanvasArea";
import { CaptureWindow } from "./components/CaptureWindow";
import { ChatPanel } from "./components/ChatPanel";
import { SearchPalette } from "./components/SearchPalette";
import { ShaderBackground } from "./components/ShaderBackground";
import { Sidebar } from "./components/Sidebar";
import { useEffect, useState } from "react";
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
  const [searchOpen, setSearchOpen] = useState(false);

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
      <Sidebar projects={ws.projects} active={ws.active} onSelect={(s) => void ws.select(s)} onCreate={(n) => void ws.createProject(n)} />
      <ChatPanel ws={ws} />
      {searchOpen && <SearchPalette ws={ws} onClose={() => setSearchOpen(false)} />}
      {ws.error && (
        <div className="toast" role="alert">
          <span>{ws.error}</span>
          <button type="button" className="btn" onClick={ws.clearError}>Close</button>
        </div>
      )}
    </ThemeProvider>
  );
}

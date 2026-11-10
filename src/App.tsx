import { CanvasArea } from "./components/CanvasArea";
import { ChatPanel } from "./components/ChatPanel";
import { ShaderBackground } from "./components/ShaderBackground";
import { Sidebar } from "./components/Sidebar";
import { ThemeProvider } from "./theme/ThemeContext";

export default function App() {
  return (
    <ThemeProvider>
      <ShaderBackground />
      <CanvasArea />
      <Sidebar />
      <ChatPanel />
    </ThemeProvider>
  );
}

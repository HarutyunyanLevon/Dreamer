import { useEffect, useRef, useState } from "react";
import { ShaderRenderer } from "../theme/shader";
import { useTheme } from "../theme/ThemeContext";

/** Full-screen animated background. Falls back to the flat theme color (body background) if WebGL fails. */
export function ShaderBackground() {
  const { theme } = useTheme();
  const ref = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<ShaderRenderer | null>(null);
  const initial = useRef(theme.shader);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current!;
    const r = ShaderRenderer.create(canvas, initial.current);
    if (!r) {
      setFailed(true);
      return;
    }
    renderer.current = r;
    const onFail = () => setFailed(true);
    canvas.addEventListener("dreamer-shader-failed", onFail);
    r.start();
    return () => {
      canvas.removeEventListener("dreamer-shader-failed", onFail);
      r.dispose();
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    renderer.current?.setShader(theme.shader);
  }, [theme]);

  return <canvas ref={ref} className="bg-canvas" aria-hidden="true" style={{ display: failed ? "none" : "block" }} />;
}

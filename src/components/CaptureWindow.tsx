import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, useState } from "react";

/**
 * The always-on-top "Catch a thought" popup, opened by the global hotkey.
 * Enter creates an Inbox Cloud card and hides the window; Esc hides without saving.
 */
export function CaptureWindow() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hide = () => void getCurrentWindow().hide();

  const capture = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("create_card", { slug: "inbox", card: { title, stage: "cloud" } });
      setText("");
      hide();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="capture-popup"
      onKeyDown={(e) => {
        if (e.key === "Escape") hide();
      }}
    >
      <div className="glass capture-card">
        <span className="capture-label">Catch a thought</span>
        <input
          ref={inputRef}
          autoFocus
          className="capture-input"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void capture();
          }}
          placeholder="What's the idea?"
        />
        {error && <span className="capture-error">{error}</span>}
      </div>
    </div>
  );
}

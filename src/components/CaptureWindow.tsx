import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { IconClose } from "./Icons";

/**
 * The always-on-top "Catch a thought" popup, opened by the global hotkey.
 *
 * - Add (or Enter) creates an Inbox Mist card and closes the popup at once. If creating fails,
 *   the popup stays open with the error and the text, so nothing is lost.
 * - X, Esc, and clicking anywhere outside (the window losing focus, handled in Rust) close it and
 *   discard the text. The window is hidden, not destroyed, so the next hotkey opens it instantly,
 *   empty and focused.
 * - Closing needs `core:window:allow-hide` (capabilities/capture.json). Without it `hide()` was
 *   refused and the popup could not be closed at all.
 */
export function CaptureWindow() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setText("");
    setError(null);
  };
  const close = () => {
    reset();
    getCurrentWindow()
      .hide()
      .catch((e) => setError(`Couldn't close the popup: ${String(e)}`));
  };

  // Losing focus (Rust then hides the window) discards the text; regaining it (next hotkey)
  // focuses the field.
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) requestAnimationFrame(() => inputRef.current?.focus());
        else reset();
      })
      .then((u) => (disposed ? u() : (un = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const add = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("create_card", { slug: "inbox", card: { title, stage: "mist" } });
      close();
    } catch (e) {
      setError(`Couldn't add it: ${e instanceof Error ? e.message : String(e)}`);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="capture-popup"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="glass capture-card" role="dialog" aria-label="Catch a thought">
        <div className="capture-head">
          <span className="capture-label">Catch a thought</span>
          <button type="button" className="icon-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={close}>
            <IconClose />
          </button>
        </div>
        <input
          ref={inputRef}
          autoFocus
          className="capture-input"
          aria-label="Your idea"
          aria-invalid={error ? true : undefined}
          value={text}
          readOnly={busy}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="What's the idea?"
        />
        <div className="capture-foot">
          <span className="capture-hint">{error ? "" : "Lands in your Inbox as a Mist card."}</span>
          <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={() => void add()} title="Add to the Inbox (Enter)">
            Add
          </button>
        </div>
        {error && (
          <p className="capture-error scroll scroll-y" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

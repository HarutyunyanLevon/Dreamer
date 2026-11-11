import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal } from "../ui/Modal";

/**
 * One-time notice the first time the main window's X is clicked: Dreamer keeps running in the
 * tray (quick capture stays available). "Keep running" hides the window and remembers the notice
 * was seen (workspace.json `tray_notice_shown`); "Quit Dreamer" exits fully. Esc or a click outside
 * just leaves the window open; the next X then hides it.
 */
export function TrayNotice() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    api.onTrayNotice(() => setOpen(true)).then((u) => (disposed ? u() : (un = u))).catch(() => {});
    return () => {
      disposed = true;
      un?.();
    };
  }, []);
  if (!open) return null;
  return (
    <Modal onClose={() => setOpen(false)} label="Dreamer is still running in the tray" size="sm">
      <h3 className="dialog-title">Dreamer is still running in the tray</h3>
      <p>
        Closing the window keeps Dreamer running in the system tray, so the quick-capture hotkey keeps working. Open it again from the tray
        icon, or quit it fully with “Quit Dreamer” at the bottom of the project sidebar or in the tray menu.
      </p>
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={() => void api.quitApp()}>
          Quit Dreamer
        </button>
        <button
          type="button"
          className="btn primary"
          autoFocus
          onClick={() => {
            setOpen(false);
            void api.hideToTray();
          }}
        >
          Keep running in the tray
        </button>
      </div>
    </Modal>
  );
}

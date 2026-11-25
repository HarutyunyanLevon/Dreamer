import { useCallback, useEffect, useState } from "react";
import { claudeApi } from "../api/claudeIndex";
import type { LocalStatus, RestartStep } from "../api/claude";

export const RESTART_LABEL: Record<RestartStep, string> = { stopping: "Stopping…", starting: "Starting…", loading: "Loading model…" };

/** Consecutive failed restarts, shared by the dialog and the chat notes. */
let failures = 0;

/** "Restart Ollama": the step it is at, the last error, and how many restarts failed in a row. */
export function useOllamaRestart() {
  const [step, setStep] = useState<RestartStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fails, setFails] = useState(failures);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onLocalSetupEvent((e) => {
        if (e.type === "restart") setStep(e.step);
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  /** The new status, or null when it failed (see `error`). */
  const restart = useCallback(async (): Promise<LocalStatus | null> => {
    setError(null);
    setStep("stopping");
    try {
      const st = await claudeApi.restartOllama();
      failures = 0;
      setFails(0);
      return st;
    } catch (e) {
      failures += 1;
      setFails(failures);
      setError(String(e).replace(/^Error: /, ""));
      return null;
    } finally {
      setStep(null);
    }
  }, []);

  return { step, error, fails, restart };
}

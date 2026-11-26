import { useSyncExternalStore } from "react";
import { api } from "../api";
import { claudeApi } from "../api/claudeIndex";

/**
 * App-wide artifact state that isn't in any file: which artifacts have a turn running (with the
 * SpriteCook job progress), whether SpriteCook could make images in an artifact's last session, and
 * the SpriteCook credit balance (chat header). Fed by claude-events; read with the hooks below.
 */
interface ArtifactRun {
  turn: string;
  label: string;
  /** 0..1 when SpriteCook reports it, else null (indeterminate bar). */
  progress: number | null;
  credits: number;
  startedAt: number;
}
interface Balance {
  credits: number | null;
  /** "no_key" = no SpriteCook key saved; anything else is a failed check. */
  error: string | null;
  loading: boolean;
}
type SpritecookNote = { reason: "no_key" | "unreachable"; at: number };

let runs: Record<string, ArtifactRun> = {};
let notes: Record<string, SpritecookNote> = {};
let balance: Balance = { credits: null, error: null, loading: false };
/** Artifacts whose files changed (a counter per id): previews reload on it. */
let stamps: Record<string, number> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  ensureListening();
  listeners.add(l);
  return () => listeners.delete(l);
};

const turnToArtifact = new Map<string, string>();
let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  // Files written mid-turn (save_image, write_file) show up in the previews right away.
  let t: ReturnType<typeof setTimeout> | undefined;
  api
    .onChange((events) => {
      if (!events.some((e) => e.scope === "artifact")) return;
      clearTimeout(t);
      t = setTimeout(() => artifactRuns.touch(), 200);
    })
    .catch(() => {});
  claudeApi
    .onEvent((e) => {
      if (e.type === "artifact_progress" && e.artifact && runs[e.artifact]) {
        runs = { ...runs, [e.artifact]: { ...runs[e.artifact], label: e.label, progress: e.progress ?? null, credits: e.credits ?? runs[e.artifact].credits } };
        emit();
      } else if (e.type === "spritecook_status" && e.artifact) {
        const next = { ...notes };
        if (e.ok) delete next[e.artifact];
        else next[e.artifact] = { reason: e.reason ?? "unreachable", at: Date.now() };
        notes = next;
        emit();
      } else if (e.type === "spritecook_balance") {
        balance = { credits: e.credits ?? null, error: e.error ?? null, loading: false };
        emit();
      } else if (e.type === "message_done" || e.type === "error") {
        const art = e.id ? turnToArtifact.get(e.id) : undefined;
        if (art) {
          endRun(art);
          if (e.id) turnToArtifact.delete(e.id);
          // The balance moves after each artifact turn.
          refreshBalance();
        }
      } else if (e.type === "sidecar_exit") {
        for (const [turn, art] of turnToArtifact) {
          if (turn !== e.keep) {
            endRun(art);
            turnToArtifact.delete(turn);
          }
        }
      }
    })
    .catch(() => {
      listening = false;
    });
}

function endRun(id: string) {
  if (!runs[id]) return;
  const { [id]: _, ...rest } = runs;
  runs = rest;
  stamps = { ...stamps, [id]: (stamps[id] ?? 0) + 1 };
  emit();
}

export const artifactRuns = {
  start(artifact: string, turn: string) {
    ensureListening();
    turnToArtifact.set(turn, artifact);
    runs = { ...runs, [artifact]: { turn, label: "Claude is working…", progress: null, credits: 0, startedAt: Date.now() } };
    emit();
  },
  /** The artifact's files changed on disk (watcher): previews reload. */
  touch(id?: string) {
    if (id) stamps = { ...stamps, [id]: (stamps[id] ?? 0) + 1 };
    else stamps = Object.fromEntries(Object.entries(stamps).map(([k, v]) => [k, v + 1]));
    globalStamp++;
    emit();
  },
  running: (id: string) => !!runs[id],
};
let globalStamp = 0;

export function refreshBalance() {
  ensureListening();
  balance = { ...balance, loading: true };
  emit();
  claudeApi.spritecookBalance().catch((err) => {
    balance = { credits: null, error: String(err), loading: false };
    emit();
  });
}

export const useArtifactRun = (id: string) => useSyncExternalStore(subscribe, () => runs[id] ?? null);
export const useSpritecookNote = (id: string) => useSyncExternalStore(subscribe, () => notes[id] ?? null);
export const useBalance = () => useSyncExternalStore(subscribe, () => balance);
/** Changes whenever this artifact (or any, after a watcher event) changed: a reload key for previews. */
export const useArtifactStamp = (id: string) => useSyncExternalStore(subscribe, () => `${stamps[id] ?? 0}:${globalStamp}`);

import { useSyncExternalStore } from "react";
import { api, type BuildAsk, type BuildEvent, type BuildLive, type BuildStep, type BuildSummary } from "../api";

/**
 * App-wide build run state (Build panel, board, "Run in Dreamer"): the live runs with their
 * streamed timeline, the run that just ended, the right panel's tab and a pending "start a run"
 * request (BuildStartHost asks about a dirty tree). Fed by build-events.
 */
export type TimelineItem =
  | { t: "step"; step: BuildStep }
  | { t: "text"; text: string }
  | { t: "ask"; ask: BuildAsk; decision?: string }
  | { t: "denied"; tool: string; reason: string }
  | { t: "task"; index: number };
export interface LiveRun {
  info: BuildLive;
  items: TimelineItem[];
  output: number;
  lastAt: number;
}
export interface StartRequest {
  slug: string;
  tasks: string[];
}
interface Store {
  live: Record<string, LiveRun>;
  /** The last run that ended, per project: its summary card stays in the panel. */
  ended: Record<string, BuildSummary>;
  tab: "chat" | "build";
  /** Bumped when something asks for the Build tab (the app shows the right panel). */
  tabReq: number;
  start: StartRequest | null;
  /** Bumped whenever a run starts or ends (the past-runs list reloads). */
  stamp: number;
}

let s: Store = { live: {}, ended: {}, tab: "chat", tabReq: 0, start: null, stamp: 0 };
const listeners = new Set<() => void>();
const set = (next: Partial<Store>) => {
  s = { ...s, ...next };
  listeners.forEach((l) => l());
};
let listening = false;
const subscribe = (l: () => void) => {
  if (!listening) {
    listening = true;
    api.onBuildEvent(onEvent).catch(() => {});
  }
  listeners.add(l);
  return () => listeners.delete(l);
};

function patchRun(id: string, f: (r: LiveRun) => LiveRun) {
  const r = s.live[id];
  if (r) set({ live: { ...s.live, [id]: f({ ...r, lastAt: Date.now() }) } });
}

function onEvent(e: BuildEvent) {
  switch (e.type) {
    case "started":
      set({ live: { ...s.live, [e.run]: { info: e.info, items: [], output: 0, lastAt: Date.now() } }, stamp: s.stamp + 1 });
      return;
    case "step":
      return patchRun(e.run, (r) => {
        const i = r.items.findIndex((x) => x.t === "step" && x.step.sid === e.step.sid);
        const items = [...r.items];
        if (i >= 0) items[i] = { t: "step", step: e.step };
        else items.push({ t: "step", step: e.step });
        return { ...r, items };
      });
    case "text":
      return patchRun(e.run, (r) => ({ ...r, items: [...r.items, { t: "text", text: e.text }] }));
    case "usage":
      return patchRun(e.run, (r) => ({ ...r, output: e.output }));
    case "ask":
      return patchRun(e.run, (r) => ({ ...r, info: { ...r.info, asks: [...r.info.asks, e.ask] }, items: [...r.items, { t: "ask", ask: e.ask }] }));
    case "ask_done":
      return patchRun(e.run, (r) => ({
        ...r,
        info: { ...r.info, asks: r.info.asks.filter((a) => a.req !== e.req) },
        items: r.items.map((x) => (x.t === "ask" && x.ask.req === e.req ? { ...x, decision: e.decision } : x)),
      }));
    case "denied":
      return patchRun(e.run, (r) => ({ ...r, items: [...r.items, { t: "denied", tool: e.tool, reason: e.reason }] }));
    case "task":
      return patchRun(e.run, (r) => ({ ...r, info: { ...r.info, current: e.index }, items: [...r.items, { t: "task", index: e.index }] }));
    case "done": {
      const live = { ...s.live };
      delete live[e.run];
      set({ live, ended: { ...s.ended, [e.summary.slug]: e.summary }, stamp: s.stamp + 1 });
      return;
    }
  }
}

export const buildRuns = {
  showTab(tab: "chat" | "build") {
    set({ tab, tabReq: tab === "build" ? s.tabReq + 1 : s.tabReq });
  },
  /** "Run in Dreamer": BuildStartHost checks the repo (dirty tree dialog) and starts the run. */
  requestStart(slug: string, tasks: string[]) {
    set({ start: { slug, tasks } });
  },
  clearStart() {
    set({ start: null });
  },
  /** A live run the panel found on (re)load (e.g. after a UI reload): its timeline starts empty. */
  adopt(info: BuildLive) {
    if (!s.live[info.id]) set({ live: { ...s.live, [info.id]: { info, items: info.asks.map((ask) => ({ t: "ask" as const, ask })), output: 0, lastAt: Date.now() } } });
  },
  setEnded(summary: BuildSummary) {
    set({ ended: { ...s.ended, [summary.slug]: summary }, stamp: s.stamp + 1 });
  },
  closeEnded(slug: string) {
    const ended = { ...s.ended };
    delete ended[slug];
    set({ ended });
  },
};

export function useBuildRuns(): Store {
  return useSyncExternalStore(subscribe, () => s);
}

/** The live run of a project, if any (one per repo; a project has one repo). */
export const liveRunOf = (st: Store, slug: string | null) => Object.values(st.live).find((r) => r.info.slug === slug) ?? null;

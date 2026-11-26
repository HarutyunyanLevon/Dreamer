import { dlog, query, sizeOfContent, text } from "./io.mjs";
import { ACTION_TOOLS, GUARD_RE, guard } from "./turn.mjs";

// ---- Live activity: what Claude is doing during a turn or one-shot job ----
//
// One tracker per turn (or job) turns the SDK stream into protocol events, each sent through `out`
// (which attaches the turn id or job id):
//   {type:"step", step:{sid, kind:"tool"|"thinking", tool?, label, status, startedAt, endedAt?, detail?}}
//   {type:"thinking_delta", sid, text}
//   {type:"usage", input, cacheRead, cacheCreate, output}   -- cumulative for the turn, after every API call
// Only the main agent's events count (parent_tool_use_id null).

const DEFAULT_CONTEXT_WINDOW = 200000;
const shortTool = (name) => String(name || "").replace(/^mcp__.+?__/, "");
export const clip = (s, n = 48) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
export const resultText = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return clip(url, 40);
  }
};

/** A short, human label for a tool call. `r` = {text, hasImage} once its result is in (and not an error). */
function toolLabel(name, input, r) {
  const a = input ?? {};
  switch (shortTool(name)) {
    case "read_card": {
      const c = r && parseJson(r.text);
      return c?.title ? `Read "${clip(c.title)}"` : "Reading a card";
    }
    case "search_cards": {
      if (!r) return a.query ? `Searching "${clip(a.query)}"` : "Searching cards";
      const hits = parseJson(r.text);
      const n = Array.isArray(hits) ? hits.length : 0;
      return `Searched "${clip(a.query)}" → ${n} card${n === 1 ? "" : "s"}`;
    }
    case "list_related":
      return "Found related cards";
    case "list_cards":
      return "Listed cards";
    case "view_attachment":
      if (!r) return "Looking at an attachment";
      return r.hasImage ? "Looked at an image" : "Read a web clip";
    case "create_card":
    case "create_cards":
      // Every card Claude makes in Dreamer is a ghost suggestion.
      return a.title ? `Suggested "${clip(a.title)}"` : "Suggested a card";
    case "update_card":
      return a.title ? `Edited "${clip(a.title)}"` : "Edited a card";
    case "propose_edit":
      return "Suggested an edit";
    case "propose_reference":
      return "Suggested a reference";
    case "propose_link":
      return "Suggested a link";
    case "list_tree":
      return "Read the canvas";
    case "propose_organize":
      return "Proposed a plan";
    case "merge_cards":
      return "Suggested a merge";
    case "link_cards":
    case "link":
      return "Linked cards";
    case "move_cards":
    case "move":
      return "Moved cards";
    case "frame_cards":
    case "frame":
      return "Framed cards";
    case "trash_card":
    case "trash":
      return "Moved a card to Trash";
    case "ask_question":
    case "ask_questions":
      return "Asked questions";
    case "remember":
    case "forget":
    case "memory_update":
    case "memory_seed":
      return "Updated memory";
    case "report_gaps":
      return "Reported the gaps";
    case "report_progress":
      return clip(a.note || a.step || "Progress", 60);
    case "write_design_doc":
      return a.name ? `Wrote ${a.name}` : "Writing a doc";
    case "WebSearch":
      return a.query ? `Searched the web "${clip(a.query)}"` : "Searching the web";
    case "WebFetch":
      return a.url ? `Opened ${domainOf(a.url)}` : "Opening a page";
    case "Bash":
      return a.command ? `$ ${clip(a.command, 80)}` : "Running a command";
    case "Read":
      return a.file_path ? `Read ${clip(a.file_path, 70)}` : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return a.file_path || a.notebook_path ? `${shortTool(name) === "Write" ? "Wrote" : "Edited"} ${clip(a.file_path || a.notebook_path, 70)}` : "Editing a file";
    case "Glob":
    case "Grep":
      return a.pattern ? `Searched ${clip(a.pattern, 60)}` : "Searching files";
    case "TodoWrite":
      return "Updated the plan";
    default:
      return shortTool(name) || "Tool";
  }
}

const zeroUsage = () => ({ input: 0, cacheRead: 0, cacheCreate: 0, output: 0 });
export const fromApiUsage = (u) => ({ input: u?.input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheCreate: u?.cache_creation_input_tokens ?? 0, output: u?.output_tokens ?? 0 });

export function makeTracker(out, label = "") {
  const startedAt = Date.now();
  const finished = []; // the turn's earlier API calls: {input, cacheRead, cacheCreate, output} each
  const callList = () => [...finished, ...(cur ? [cur] : [])].map((c) => ({ input: c.input, cacheRead: c.cacheRead, cacheCreate: c.cacheCreate, output: c.output }));
  const steps = new Map(); // sid -> step (plus private input / json fields)
  const blocks = new Map(); // content block index of the current API call -> sid
  let done = zeroUsage(); // API calls finished in this turn
  let cur = null; // the API call in progress (or the last one)
  let thinkN = 0;
  let asked = false; // an ask_question succeeded in this turn
  const usage = () => {
    const c = cur ?? zeroUsage();
    return { input: done.input + c.input, cacheRead: done.cacheRead + c.cacheRead, cacheCreate: done.cacheCreate + c.cacheCreate, output: done.output + c.output };
  };
  const emitStep = (s) => {
    const { input: _i, json: _j, ...pub } = s;
    out({ type: "step", step: pub });
  };
  const emitUsage = () => out({ type: "usage", ...usage(), calls: callList() });
  const logCall = () => {
    if (cur) dlog(`${label} api_call#${finished.length + 1} input=${cur.input} cacheRead=${cur.cacheRead} cacheCreate=${cur.cacheCreate} total_in=${cur.input + cur.cacheRead + cur.cacheCreate} output=${cur.output}`);
  };
  const relabel = (s) => {
    if (s.kind === "tool") s.label = toolLabel(s.tool, s.input);
  };
  return {
    startedAt,
    usage,
    /** The last API call's whole input: what the thread's context holds now. */
    contextTokens: () => (cur ? cur.input + cur.cacheRead + cur.cacheCreate : 0),
    hasUsage: () => !!cur,
    /** Each API call's own token counts, in order. */
    calls: callList,
    /** Tool calls of this turn that came back as errors (malformed input, failed request). */
    /** A successful tool call came after the turn's real tool error (the in-turn repair worked). */
    /** ask_question succeeded in this turn (its result is recorded). */
    asked: () => asked,
    /** Tool calls still running (each keeps its own time limit in the watchdog). */
    running: () => [...steps.values()].filter((s) => s.kind === "tool" && s.status === "running"),
    /** Calls that did the turn's job (a ghost card, a question, a proposal): no local retry after them. */
    actions: () => [...steps.values()].filter((s) => s.kind === "tool" && s.status === "done" && ACTION_TOOLS.has(s.tool)).length,
    /** Every tool call: name, duration, outcome (diagnostics). */
    toolLog: () => [...steps.values()].filter((s) => s.kind === "tool").map((s) => ({ tool: s.tool, status: s.status, ms: (s.endedAt ?? Date.now()) - s.startedAt })),
    on(msg) {
      if (msg.parent_tool_use_id) return;
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "message_start") {
          if (cur) {
            done = usage();
            finished.push(cur);
          }
          cur = fromApiUsage(ev.message?.usage);
          if (process.env.DREAMER_DEBUG_USAGE) dlog(`${label} raw message_start usage ${JSON.stringify(ev.message?.usage)}`);
          blocks.clear();
          emitUsage();
        } else if (ev?.type === "message_delta" && ev.usage) {
          const u = ev.usage;
          if (process.env.DREAMER_DEBUG_USAGE) dlog(`${label} raw message_delta usage ${JSON.stringify(u)} stop=${ev.delta?.stop_reason}`);
          cur = cur ?? zeroUsage();
          if (u.output_tokens != null) cur.output = u.output_tokens;
          if (u.input_tokens) cur.input = u.input_tokens;
          if (u.cache_read_input_tokens) cur.cacheRead = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens) cur.cacheCreate = u.cache_creation_input_tokens;
          if (ev.delta?.stop_reason) logCall();
          emitUsage();
        } else if (ev?.type === "content_block_start") {
          const cb = ev.content_block ?? {};
          if (cb.type === "tool_use" || cb.type === "server_tool_use") {
            const s = { sid: cb.id, kind: "tool", tool: shortTool(cb.name), label: "", status: "running", startedAt: Date.now(), input: {}, json: "", call: finished.length + 1 };
            relabel(s);
            steps.set(s.sid, s);
            blocks.set(ev.index, s.sid);
            emitStep(s);
          } else if (cb.type === "thinking") {
            const s = { sid: `th${++thinkN}`, kind: "thinking", label: "Thinking", status: "running", startedAt: Date.now(), call: finished.length + 1 };
            steps.set(s.sid, s);
            blocks.set(ev.index, s.sid);
            emitStep(s);
          }
        } else if (ev?.type === "content_block_delta") {
          const s = steps.get(blocks.get(ev.index));
          if (!s) return;
          if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) out({ type: "thinking_delta", sid: s.sid, text: ev.delta.thinking });
          else if (ev.delta?.type === "input_json_delta") s.json += ev.delta.partial_json ?? "";
        } else if (ev?.type === "content_block_stop") {
          const s = steps.get(blocks.get(ev.index));
          if (!s) return;
          if (s.kind === "thinking") {
            s.status = "done";
            s.endedAt = Date.now();
            emitStep(s);
          } else if (s.status === "running") {
            const input = parseJson(s.json || "{}");
            if (input && typeof input === "object") s.input = input;
            const before = s.label;
            relabel(s);
            if (s.label !== before) emitStep(s);
          }
        }
      } else if (msg.type === "assistant") {
        // The complete blocks: tool inputs are certain here (the streamed JSON may be cut short).
        for (const b of msg.message?.content ?? []) {
          const s = (b?.type === "tool_use" || b?.type === "server_tool_use") && steps.get(b.id);
          if (s && s.status === "running" && b.input && typeof b.input === "object") {
            s.input = b.input;
            const before = s.label;
            relabel(s);
            if (s.label !== before) emitStep(s);
          }
        }
      } else if (msg.type === "user") {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const s = steps.get(b.tool_use_id);
          if (!s || s.status !== "running") continue;
          const txt = resultText(b.content);
          dlog(`${label} tool_result ${s.tool} call#${s.call} bytes=${sizeOfContent(b.content)} text=${txt.length}${Array.isArray(b.content) && b.content.some((x) => x?.type === "image") ? " +image" : ""}${b.is_error ? " (error)" : ""}`);
          // Per-call diagnostics: what was asked, what came back, whether a Dreamer guard answered, and where it sits relative to ask_question.
          const guard = GUARD_RE.test(txt);
          const ask = s.tool === "ask_question" || s.tool === "ask_questions";
          const pos = asked ? "after_ask" : ask && !b.is_error ? "ask" : "before_ask";
          dlog(`${label} tool_call #${s.call} name=${s.tool} pos=${pos} guard=${guard ? "yes" : "no"} error=${b.is_error ? "yes" : "no"} args=${JSON.stringify(clip(JSON.stringify(s.input ?? {}), 300))} result=${JSON.stringify(clip(txt, 300))}`);
          if (ask && !b.is_error && !guard) asked = true;
          s.status = b.is_error ? "error" : "done";
          s.endedAt = Date.now();
          if (b.is_error) s.detail = clip(txt.replace(/^Error:\s*/, ""), 200);
          else s.label = toolLabel(s.tool, s.input, { text: txt, hasImage: Array.isArray(b.content) && b.content.some((x) => x?.type === "image") });
          emitStep(s);
        }
      }
    },
    /** Closes steps still open when the turn ends. */
    finish(isError) {
      for (const s of steps.values()) {
        if (s.status !== "running") continue;
        s.status = isError ? "error" : "done";
        s.endedAt = Date.now();
        emitStep(s);
      }
    },
  };
}

/** The model's context window from a result's modelUsage, or 200k. */
export function contextWindowOf(result) {
  const ws = Object.values(result?.modelUsage ?? {})
    .map((m) => m?.contextWindow)
    .filter((n) => typeof n === "number" && n > 0);
  return ws.length ? Math.max(...ws) : DEFAULT_CONTEXT_WINDOW;
}

// A queue that the stdin reader pushes into and the query's async-iterable prompt pulls from,
// so one long-lived streaming session can carry many chat turns (and survive interrupts).
export function makeTurnQueue() {
  const waiting = [];
  const buffered = [];
  const END = Symbol("end");
  let ended = false;
  return {
    push(msg) {
      if (ended) return;
      const w = waiting.shift();
      if (w) w(msg);
      else buffered.push(msg);
    },
    /** Ends the prompt stream, which ends that Claude session. */
    end() {
      ended = true;
      waiting.splice(0).forEach((w) => w(END));
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (ended && !buffered.length) return;
        const next = buffered.length ? buffered.shift() : await new Promise((resolve) => waiting.push(resolve));
        if (next === END) return;
        yield next;
      }
    },
  };
}

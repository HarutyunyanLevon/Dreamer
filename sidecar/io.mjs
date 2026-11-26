import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

// The user's installed Claude Code (resolved by the app, see sidecar.rs). Release builds ship
// the SDK without its bundled per-platform binary, so this is what every query() runs.
export const CLAUDE_EXE = process.env.DREAMER_CLAUDE_EXE || "";
export const query = (args) =>
  sdkQuery({ ...args, options: { ...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {}), ...args.options } });


export const pendingToolReplies = new Map();
let reqSeq = 0; export const nextReq = () => ++reqSeq;

/** One diagnostics line in sidecar.log (the app records our stderr there). Sizes and ids only, never content. */
export const dlog = (line) => console.error(`[ctx] ${line}`);
export const sizeOfContent = (c) =>
  typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b?.type === "text" ? (b.text ?? "").length : b?.type === "image" ? (b.source?.data ?? b.data ?? "").length : 0), 0) : 0;

export function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// The app reads stdout; if that pipe is gone there is nobody left to answer.
process.stdout.on("error", () => process.exit(1));


/**
 * Asks Rust for something and waits for its tool_response. `t`: the turn this belongs to; while the
 * request is out, the turn's watchdog waits for this request's own timeout instead of its idle limit.
 */
export function requestTool(tool_, input, timeoutMs = 15000, t = null) {
  const reqId = `r${nextReq()}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const settle = () => t?.waits.delete(reqId);
    const timer = setTimeout(() => {
      pendingToolReplies.delete(reqId);
      settle();
      dlog(`tool_timeout turn=${t?.id ?? "-"} tool=${tool_} req=${reqId} after_ms=${timeoutMs}`);
      reject(new Error("timed out waiting for the app"));
    }, timeoutMs);
    pendingToolReplies.set(reqId, {
      resolve: (v) => {
        settle();
        if (Date.now() - startedAt > 2000) dlog(`tool_slow turn=${t?.id ?? "-"} tool=${tool_} req=${reqId} ms=${Date.now() - startedAt}`);
        resolve(v);
      },
      reject: (e) => {
        settle();
        reject(e);
      },
      timer,
    });
    t?.waits.set(reqId, Date.now() + timeoutMs + 5000);
    send({ type: "tool_request", reqId, tool: tool_, input });
  });
}

// Nothing Claude reads (tool results included) may be bigger than this; the app trims too, this is the backstop.
const MAX_TOOL_CHARS = 8000;
const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^,;\s)"'<>]*)*,[^\s)"'<>\]]*/gi;
/** Drops data:/base64 URIs and caps the length. */
function trimForClaude(t, max = MAX_TOOL_CHARS) {
  let out = String(t ?? "").replace(DATA_URI, "[embedded data omitted]");
  if (out.length > max) out = `${out.slice(0, max)}\n…truncated (${out.length - max} more chars), use read_card`;
  return out;
}
export const text = (v, max) => ({ content: [{ type: "text", text: trimForClaude(typeof v === "string" ? v : JSON.stringify(v, null, 1), max) }] });
export const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

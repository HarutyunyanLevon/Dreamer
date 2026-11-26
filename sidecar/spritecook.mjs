import { parseJson, resultText } from "./activity.mjs";
import { dlog, nextReq, send, text } from "./io.mjs";
import { sessions } from "./session.mjs";
import { artifactGate } from "./tools/artifactSession.mjs";
import { emit } from "./turn.mjs";

// ---- SpriteCook (artifact images), through its remote MCP server ----
// URL from Settings, key from the OS credential store (both passed by the app at spawn). The key is
// removed from our env at once, so no Claude Code process inherits it; it only goes into the MCP
// server's Authorization header of artifact sessions.
export const SPRITECOOK = { url: process.env.DREAMER_SPRITECOOK_URL || "https://api.spritecook.ai/mcp/", key: process.env.DREAMER_SPRITECOOK_KEY || "" };
delete process.env.DREAMER_SPRITECOOK_KEY;
export const DEFAULT_CREDIT_CAP = Number(process.env.DREAMER_CREDIT_CAP) || 4;
/** The SpriteCook tools artifact sessions may use (checked against the live list at session init). */
export const SPRITECOOK_TOOLS = [
  "generate_game_art", "generate_character", "make_rotation_sheet", "generate_character_animations", "check_character_animation_run",
  "animate_game_art", "remove_background", "create_ui_kit", "generate_ui_kit_concepts", "select_ui_kit_concept",
  "generate_ui_kit_component_sheets", "extract_ui_kit_components", "finalize_ui_kit", "get_ui_kit", "check_job_status",
  "get_asset_metadata", "get_credit_balance", "create_project", "assign_assets_to_project", "list_presets",
  "get_preset_settings", "save_private_preset", "import_asset", "create_asset_upload", "finalize_asset_upload",
];
/** Calls that spend credits: they go through the per-turn cap (artifactGate) instead of allowedTools. */
export const PAID_TOOLS = new Set([
  "generate_game_art", "generate_character", "make_rotation_sheet", "generate_character_animations", "animate_game_art",
  "remove_background", "create_ui_kit", "generate_ui_kit_concepts", "generate_ui_kit_component_sheets", "extract_ui_kit_components", "finalize_ui_kit",
]);
/** These count by the credits they report, not as one call. */
const CREDIT_COUNTED = new Set(["generate_character_animations", "animate_game_art", "create_ui_kit", "generate_ui_kit_concepts", "generate_ui_kit_component_sheets", "extract_ui_kit_components", "finalize_ui_kit"]);
export const FREE_TOOLS = SPRITECOOK_TOOLS.filter((t) => !PAID_TOOLS.has(t));
export const spritecookServer = () => (SPRITECOOK.key ? { type: "http", url: SPRITECOOK.url, headers: { Authorization: `Bearer ${SPRITECOOK.key}` } } : null);
// ---- Credits: auto under a per-turn cap ----
//
// Paid SpriteCook calls run without asking while the turn stays at or under the cap (Settings,
// default 4 paid calls). A call that would go over it pauses the turn: the chat shows "Generate N
// more (~X credits)?" and the call waits for the answer. Animations and UI kits count by the credits
// they report (estimated beforehand from the last one seen), everything else as one call.

export const pendingCredit = new Map(); // reqId -> resolve(bool)
/** Credits each counted tool reported last time (the estimate for the next one). */
const lastCredits = new Map();
/** Credits reported per plain image call, for the "~X credits" estimate. */
const seenCredits = { calls: 0, credits: 0 };

const estimateUnits = (tool_) => (CREDIT_COUNTED.has(tool_) ? Math.max(1, lastCredits.get(tool_) ?? 2) : 1);
const perCall = () => (seenCredits.calls ? seenCredits.credits / seenCredits.calls : null);

/** Before a paid call: within the cap -> go; over it -> ask the user and wait. */
export async function creditCheck(s, tool_) {
  const c = s.credits ?? (s.credits = { calls: 0, units: 0, spent: 0, jobs: [], allowed: s.artifact?.cap ?? DEFAULT_CREDIT_CAP });
  const est = estimateUnits(tool_);
  if (c.units + est > c.allowed) {
    const more = s.artifact?.cap ?? DEFAULT_CREDIT_CAP;
    const pc = perCall();
    const reqId = `cc${nextReq()}`;
    const t = s.turn;
    emit(t, { type: "credit_confirm", reqId, tool: tool_, used: c.units, cap: c.allowed, more, estCredits: pc == null ? null : Math.round(pc * more * 10) / 10 });
    dlog(`credit_confirm turn=${t?.id ?? "-"} tool=${tool_} used=${c.units} cap=${c.allowed}`);
    // Waiting for the user: the turn's watchdog pauses until they answer.
    if (t) t.userWait++;
    const ok = await new Promise((resolve) => pendingCredit.set(reqId, resolve));
    if (t) t.userWait--;
    pendingCredit.delete(reqId);
    emit(t, { type: "credit_answered", reqId, allow: ok });
    if (!ok) {
      return {
        ok: false,
        message: "The user declined more paid SpriteCook calls this turn. Generate nothing else: save what you have, write the notes, call suggest_next and end the turn.",
      };
    }
    c.allowed = c.units + more;
  }
  c.units += est;
  c.calls += 1;
  return { ok: true, est };
}

/** Every pending confirm is answered "no" (the turn was stopped). */
export function denyPendingCredits() {
  for (const resolve of pendingCredit.values()) resolve(false);
  pendingCredit.clear();
}

/** Credits and job ids a SpriteCook result reports (keys vary by tool; first number found wins). */
function readCredits(obj) {
  let credits = null;
  const jobs = [];
  let progress = null;
  let status = null;
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (credits == null && typeof v === "number" && /^(credits_(used|charged|spent|cost)|cost_credits|credit_cost|credits)$/.test(key)) credits = v;
      else if (typeof v === "string" && /^(job_id|run_id)$/.test(key) && !jobs.includes(v)) jobs.push(v);
      else if (progress == null && typeof v === "number" && key === "progress") progress = v > 1 ? v / 100 : v;
      else if (status == null && typeof v === "string" && key === "status") status = v;
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(obj, 0);
  return { credits, jobs, progress, status };
}

/**
 * A SpriteCook tool result arrived in an artifact turn: count what it cost, keep its job ids, and
 * show progress on the card (the artifact's running state).
 */
export function onSpritecookResult(s, t, name, content, isError) {
  const short = name.replace(/^mcp__spritecook__/, "");
  const txt = resultText(content);
  const info = readCredits(parseJson(txt));
  const c = s.credits;
  if (c) {
    for (const j of info.jobs) if (!c.jobs.includes(j)) c.jobs.push(j);
    if (info.credits != null && !isError && short !== "get_credit_balance") {
      c.spent += info.credits;
      if (CREDIT_COUNTED.has(short)) {
        // Counted by credits: replace the estimate with what it really cost.
        c.units += info.credits - estimateUnits(short);
        lastCredits.set(short, info.credits);
      } else if (PAID_TOOLS.has(short)) {
        seenCredits.calls += 1;
        seenCredits.credits += info.credits;
      }
    }
  }
  const label = isError ? `SpriteCook: ${short} failed` : info.status && info.status !== "completed" && info.status !== "succeeded" ? `SpriteCook: ${info.status.replace(/_/g, " ")}` : `SpriteCook: ${short.replace(/_/g, " ")}`;
  emit(t, { type: "artifact_progress", artifact: s.artifact?.id ?? null, label, progress: info.progress, credits: c?.spent ?? 0 });
}

// ---- A direct MCP call to SpriteCook, without Claude (the chat header's credit balance) ----
async function spritecookCall(name, args = {}) {
  if (!SPRITECOOK.key) throw new Error("no SpriteCook key");
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${SPRITECOOK.key}` };
  let sid = null;
  let n = 0;
  const post = async (method, params, notify = false) => {
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++n, method, params };
    const r = await fetch(SPRITECOOK.url, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    sid = r.headers.get("mcp-session-id") ?? sid;
    const t = await r.text();
    if (notify) return null;
    if (!r.ok) throw new Error(`SpriteCook answered HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    const msgs = ct.includes("event-stream")
      ? t.split("\n").filter((l) => l.startsWith("data:")).map((l) => parseJson(l.slice(5).trim())).filter(Boolean)
      : [parseJson(t)];
    const m = msgs.find((x) => x?.id === body.id);
    if (!m) throw new Error("SpriteCook sent no reply");
    if (m.error) throw new Error(m.error.message || "SpriteCook error");
    return m.result;
  };
  try {
    await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dreamer", version: "1.0.0" } });
    await post("notifications/initialized", {}, true);
    const res = await post("tools/call", { name, arguments: args });
    if (res?.isError) throw new Error(resultText(res.content) || "SpriteCook error");
    return res?.structuredContent ?? parseJson(resultText(res?.content)) ?? resultText(res?.content);
  } finally {
    if (sid) fetch(SPRITECOOK.url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sid }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

export async function sendBalance() {
  if (!SPRITECOOK.key) return send({ type: "spritecook_balance", credits: null, error: "no_key" });
  try {
    const r = await spritecookCall("get_credit_balance");
    const credits = typeof r?.total_credits === "number" ? r.total_credits : typeof r?.credits === "number" ? r.credits : null;
    send({ type: "spritecook_balance", credits, tier: r?.tier ?? null, error: credits == null ? "unreadable" : null });
  } catch (e) {
    dlog(`spritecook_balance failed: ${e?.message ?? e}`);
    send({ type: "spritecook_balance", credits: null, error: e?.message ?? String(e) });
  }
}

/** Thinking budget of a "Think" turn. */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { clip, makeTracker, makeTurnQueue } from "./activity.mjs";
import { dlog, fail, query, requestTool, send, text } from "./io.mjs";
import { GEN_SYSTEM, MEMORY_SECTIONS, MEMORY_SEED_SYSTEM, MEMORY_UPDATE_SYSTEM, SUMMARY_SYSTEM } from "./prompts/jobs.mjs";
import { killChild, nextSession, spawner } from "./session.mjs";
import { FIRST_EVENT_MS, IDLE_MS, SUMMARY_MS } from "./turn.mjs";

export const oneshots = new Map();

function imageResult(args, r) {
  if (r.kind === "image") {
    return {
      content: [
        { type: "text", text: `Image ${args.attachment_id}${r.caption ? ` (caption: ${r.caption})` : " (no caption)"}:` },
        { type: "image", data: r.data, mimeType: r.mime },
      ],
    };
  }
  const head = `Web clip ${args.attachment_id}: ${r.title ? `"${r.title}" ` : ""}<${r.url}>${r.caption ? ` (caption: ${r.caption})` : ""}`;
  return text(`${head}\n\n${r.text}`);
}

function handoffTools(job) {
  const call = (name, input) => requestTool(`handoff_${name}`, { ...input, job });
  const wrap = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
  const tools = [
    tool("list_cards", "List the cards in this job's scope.", {}, wrap(async () => text(await call("list_cards", {})))),
    tool("read_card", "Read one card in scope in full.", { id: z.string() }, wrap(async (a) => text(await call("read_card", { id: a.id })))),
    tool(
      "view_attachment",
      "Look at an image attachment (returned as an image) or read a web clip's saved text.",
      { card_id: z.string(), attachment_id: z.string() },
      wrap(async (a) => imageResult(a, await call("view_attachment", a))),
    ),
    tool(
      "report_progress",
      "Tell the user which phase you are in (shown in the progress panel).",
      { step: z.string().describe("e.g. reading, viewing images, writing 01-gdd.md"), note: z.string() },
      wrap(async (a) => text(await call("report_progress", a))),
    ),
    tool(
      "write_design_doc",
      "Save one design doc. name must be one of: 00-overview.md, 01-gdd.md, 02-tech-design.md, 03-roadmap.md, " +
        "04-open-questions.md, 05-assets.md, CLAUDE.md. Writing the same name again replaces it.",
      { name: z.string(), markdown: z.string() },
      wrap(async (a) => text(await call("write_design_doc", a))),
    ),
  ];
  return tools;
}

export function startOneshot(msg) {
  const { job, prompt } = msg;
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const tools = handoffTools(job);
  const turns = makeTurnQueue();
  const entry = { q: null, turns, cancelled: false };
  oneshots.set(job, entry);
  entry.q = query({
    prompt: turns,
    options: {
      systemPrompt: { type: "custom", prompt: GEN_SYSTEM },
      allowedTools: tools.map((t) => `mcp__handoff__${t.name}`),
      // No built-in tools at all (no files, shell or web), and the user's own settings are ignored.
      // Every tool offered is in allowedTools, so no permission callback is needed.
      tools: [],
      permissionMode: "default",
      settingSources: [],
      mcpServers: { handoff: createSdkMcpServer({ name: "handoff", version: "1.0.0", tools }) },
      includePartialMessages: true,
      ...(model ? { model } : {}),
    },
  });
  // One turn: the queue stays open until the result arrives (SDK MCP tools need streaming input).
  turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  const tracker = makeTracker((o) => !entry.cancelled && send({ ...o, job }));
  (async () => {
    let done = null;
    try {
      for await (const m of entry.q) {
        tracker.on(m);
        if (m.type === "result") {
          tracker.finish(m.is_error);
          done =
            m.subtype === "success" && !m.is_error
              ? { ok: true }
              : { ok: false, error: `Claude could not finish (${m.subtype}${m.is_error && m.result ? `: ${m.result}` : ""}).` };
          turns.end();
        }
      }
    } catch (e) {
      if (!done) done = { ok: false, error: e?.message ?? String(e) };
    }
    oneshots.delete(job);
    if (entry.cancelled) done = { ok: false, cancelled: true, error: "Cancelled." };
    send({ type: "oneshot_done", job, ...(done ?? { ok: false, error: "Claude stopped without a result." }) });
  })();
}

export function cancelOneshot(job) {
  const entry = oneshots.get(job);
  if (!entry) return;
  entry.cancelled = true;
  entry.q.interrupt?.().catch(() => {});
  entry.turns.end();
  try {
    entry.q.close?.();
  } catch {
    /* already gone */
  }
}

// ---- Memory passes: one query per chat turn (update) or per new project (seed) ----

export function startMemory(msg) {
  const { job, kind, prompt } = msg;
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const tools = memoryTools(job, kind);
  const turns = makeTurnQueue();
  const entry = { q: null, turns, cancelled: false };
  oneshots.set(job, entry);
  entry.q = query({
    prompt: turns,
    options: {
      systemPrompt: { type: "custom", prompt: kind === "seed" ? MEMORY_SEED_SYSTEM : MEMORY_UPDATE_SYSTEM },
      allowedTools: tools.map((t) => `mcp__memory__${t.name}`),
      tools: [],
      permissionMode: "default",
      settingSources: [],
      maxTurns: 3,
      mcpServers: { memory: createSdkMcpServer({ name: "memory", version: "1.0.0", tools }) },
      includePartialMessages: true,
      ...(model ? { model } : {}),
    },
  });
  turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  // Only its token count is shown (a muted line under the turn); steps and thinking are not.
  const tracker = makeTracker((o) => o.type === "usage" && send({ ...o, job }));
  (async () => {
    let ok = false;
    try {
      for await (const m of entry.q) {
        tracker.on(m);
        if (m.type === "result") {
          ok = !m.is_error;
          turns.end();
        }
      }
    } catch {
      /* reported as not ok below */
    }
    oneshots.delete(job);
    send({ type: "memory_done", job, ok: ok && !entry.cancelled });
  })();
}

export async function summarize({ transcript, model }, tracker, { timeoutMs = SUMMARY_MS, turn = null } = {}) {
  const sid = `sum${nextSession()}`;
  let q = null;
  let timedOut = false;
  let child = null;
  const stop = () => {
    try {
      q?.close?.();
    } catch {
      /* gone */
    }
    killChild({ sid, child });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    dlog(`summary_timeout turn=${turn?.id ?? "-"} after_ms=${timeoutMs}`);
    stop();
  }, timeoutMs);
  if (turn) turn.prepQuery = { close: stop };
  try {
    q = query({
      prompt: `Conversation:

${transcript}

Summarize it.`,
      options: {
        systemPrompt: { type: "custom", prompt: SUMMARY_SYSTEM },
        tools: [],
        allowedTools: [],
        permissionMode: "default",
        settingSources: [],
        maxTurns: 1,
        includePartialMessages: true,
        spawnClaudeCodeProcess: (opts) => (child = spawner({ sid })(opts)),
        ...(model ? { model } : {}),
      },
    });
    let out = null;
    for await (const m of q) {
      if (turn?.ended) break;
      tracker?.on(m);
      if (m.type === "result" && m.subtype === "success" && !m.is_error) out = String(m.result ?? "").trim();
    }
    return timedOut ? null : out || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (turn?.prepQuery?.close === stop) turn.prepQuery = null;
  }
}

// ---- One-shot completions (no tools): the Claude side of the organize pipeline ----
// {type:"complete_start", job, system, prompt, model} -> {type:"complete_done", job, ok, text?, error?}
// Own watchdog: first event 60 s, then 45 s.
export const completions = new Map();
export function startCompletion(msg) {
  const { job } = msg;
  const sid = `cmp${nextSession()}`;
  const entry = { q: null, child: null, done: false, last: Date.now(), first: 0, started: Date.now() };
  completions.set(job, entry);
  const finish = (r) => {
    if (entry.done) return;
    entry.done = true;
    clearInterval(entry.timer);
    completions.delete(job);
    try {
      entry.q?.close?.();
    } catch {
      /* gone */
    }
    if (!r.ok) killChild({ sid, child: entry.child });
    dlog(`complete_done job=${job} ok=${r.ok} ms=${Date.now() - entry.started}${r.ok ? ` chars=${r.text.length}` : ` error="${r.error}"`}`);
    send({ type: "complete_done", job, ...r });
  };
  entry.timer = setInterval(() => {
    const limit = entry.first ? entry.last + IDLE_MS : entry.started + FIRST_EVENT_MS.claude;
    if (Date.now() > limit) finish({ ok: false, error: entry.first ? `no activity for ${IDLE_MS / 1000}s` : `no reply within ${FIRST_EVENT_MS.claude / 1000}s` });
  }, 1000);
  entry.cancel = () => finish({ ok: false, error: "cancelled", cancelled: true });
  (async () => {
    try {
      entry.q = query({
        prompt: String(msg.prompt ?? ""),
        options: {
          systemPrompt: { type: "custom", prompt: String(msg.system ?? "") },
          tools: [],
          allowedTools: [],
          permissionMode: "default",
          settingSources: [],
          maxTurns: 1,
          includePartialMessages: true,
          spawnClaudeCodeProcess: (opts) => (entry.child = spawner({ sid })(opts)),
          env: { ...process.env, CLAUDE_CODE_MAX_RETRIES: "2" },
          ...(typeof msg.model === "string" && msg.model ? { model: msg.model } : {}),
        },
      });
      let out = null;
      for await (const m of entry.q) {
        if (entry.done) return;
        entry.last = Date.now();
        if (m.type === "stream_event" && !entry.first) entry.first = Date.now();
        if (m.type === "result") out = m.subtype === "success" && !m.is_error ? { ok: true, text: String(m.result ?? "") } : { ok: false, error: `Claude could not answer (${m.subtype})` };
      }
      finish(out ?? { ok: false, error: "Claude stopped without a result" });
    } catch (e) {
      finish({ ok: false, error: e?.message ?? String(e) });
    }
  })();
}

function memoryTools(job, kind) {
  let sent = false;
  const once = (result) => {
    if (sent) return text("Already recorded; stop now.");
    sent = true;
    send({ type: "memory_result", job, result });
    return text("Recorded. End your turn now.");
  };
  if (kind === "seed") {
    const list = z.array(z.string()).optional();
    return [
      tool("memory_seed", "Record the drafted memory, once.", { pitch: list, pillars: list, decisions: list, rejected: list, glossary: list, how: list }, async (a) => once(a)),
    ];
  }
  return [
    tool(
      "memory_update",
      "Record what to change in the memory, once: { none: true } or project_ops and/or card_decisions.",
      {
        none: z.boolean().optional(),
        project_ops: z
          .array(z.object({ op: z.enum(["add", "replace", "remove"]), section: z.enum(MEMORY_SECTIONS), text: z.string().optional(), old: z.string().optional() }))
          .optional(),
        card_decisions: z.array(z.string()).optional(),
      },
      async (a) => once(a),
    ),
  ];
}

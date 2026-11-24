# Chat reliability report

Branch `reliability`. Diagnosis first (sections 1–2), then the fixes (3), the harness (4) and the
numbers before and after (5). Everything measured on this machine: RTX 4080 Super (16 GB),
Windows 11, Ollama 0.40.16, Claude Code 2.1.322, Claude Agent SDK 0.3.322.

> Order of work, for the record: the evidence in sections 1–2 (logs, probes, captured requests,
> the baseline harness runs on the old pipeline) was collected before any behaviour changed. This
> document itself was written after the first fix commit, not before it.

## 1. What is actually running

| | |
|---|---|
| Configured local model | `qwen3.5:9b` (workspace.json `local_model`), the tier table's pick for 16 GB |
| Model turns actually use | `dreamer-qwen3.5:9b` (the variant, `ollama::variant_name`), confirmed in every `route … model=dreamer-qwen3.5:9b` log line and in `/api/ps` |
| Context | `num_ctx` 65,536 (`/api/ps` `context_length: 65536`; llama-server `n_ctx_slot = 65536`) |
| Placement | `/api/ps`: `size` 7,682,517,892 = `size_vram` 7,682,517,892 → Ollama reports 100 % on the GPU; llama-server: `offloaded 33/33 layers to GPU`, every load in server.log |
| Keep-alive | Ollama default: `expires_at` 5 min after the last request |

**Finding: the GPU was shared with a game.** During the investigation `cod.exe` (Call of Duty)
held ~8 GB and kept the GPU at 96–100 %. VRAM was 12.6 of 16 GB used before the model loaded,
15.3 GB after. Ollama still reported no offload (`size_vram == size`), but Windows (WDDM) was
paging the model's memory: a 13-token prompt took 22.8 s to read, a 6-token reply took 22–33 s
(0.2 tok/s; the same model does ~32 tok/s on an idle GPU, see server.log 16:53). The same collapse
is in server.log for 2026-11-24 from 16:54 on: generation fell from 32 tok/s to 0.01–1.4 tok/s in
the middle of a request. **`size_vram == size` does not prove the model is resident** on
Windows; another GPU-heavy app makes the local model 100× slower without any error. The old
pipeline then waited forever (see A below). The new one ends such turns within its watchdog
limits, but no software fix makes a 9B model useful at 0.2 tok/s: with a game running, local chat
is slow by nature.

## 2. Suspects and verdicts

Evidence sources: `%LOCALAPPDATA%\Dreamer\logs\sidecar.log` (the installed app, 2026-11-16 → 24),
`%LOCALAPPDATA%\Ollama\server.log`, direct probes against Ollama, a captured Claude Code → Ollama
request (the harness's fake server), and the harness's baseline runs of the old pipeline.

| # | Suspect | Verdict | Evidence |
|---|---|---|---|
| A | No watchdog: nothing ends a turn when the SDK stream or the Claude Code child goes silent | **Confirmed** | Code: no timer anywhere between `turn_start` and `result`. Log: turn `…-99` got no event for 9 min 19 s; turn `…-97` hung 10 min (Ollama `10m10s` request = Claude Code's 10-min API timeout) until the user pressed Stop. Baseline harness: silent local server, mid-stream local stall, silent Claude server: **6/6 infinite spinners** (no end after 180 s). |
| B | Global `currentId`/`currentSession` + per-session turn queue | **Confirmed** | Code: a session's queue head (a stopped turn whose result never came) blocked every later turn of that thread; tool handlers attributed events to the *global* turn id; `handleUserMessage` awaited the compaction / recap while `currentId` could be overwritten by the next message. Log: turn `…-19`'s `turn_start` was logged after turn `…-20` had been sent (out of order after a 19 s recap); "Retry with Claude" `…-98` was superseded by `…-99` mid-recap and never ended; stopped turns were never removed from `pending_ctx` (`failing #1: 6 turn(s) in flight` when nothing was running). `restartFresh` for a non-current session replayed a turn whose events were then dropped; eviction could close a session with a queued turn. |
| C | The prompt overflows `num_ctx` | **Ruled out** (for every logged turn) | server.log: largest prompt 18,088 tokens; every `stop processing` line has `truncated = 0`. A fresh local turn is ~7.4k tokens: system 6.8k chars + 14 tool schemas 11.7k chars + messages 7.5k chars (captured request). Risk kept in check anyway: local compaction now at 40k (was 64k against a 65,536 window) and `max_tokens` capped at 8,192 (Claude Code asked for 64,000). |
| D1 | Qwen thinking output, no text | **Confirmed** | The captured request Claude Code sends to Ollama has **no `thinking` field**, `max_tokens: 64000`, no temperature. Ollama then runs Qwen 3.5 in thinking mode at temperature 1.0 (server.log sampler: `temp = 1.000, top_k = 20, presence_penalty = 1.5`). Probe: the same 1-sentence question with no thinking field produced nothing in 10 min (200-token cap, contended GPU); with `thinking: {type: "disabled"}` → 15 tokens of text in one block. Organize calls produced 900–1,400 output tokens each. |
| D2 | Tool-call JSON Claude Code can't parse through Ollama | **Ruled out** | Every local tool call in the log arrived as a `tool_use` and reached Rust (159 `tool_request`s, 0 parse errors, 0 non-JSON lines). The organize failures were *validation* errors from `propose_organize` (a bad plan), not parse errors. |
| E1 | Model unloaded after keep_alive; first message after idle looks like a hang | **Confirmed** (contributes) | `/api/ps` `expires_at` = load + 5 min. A cold load is 29.8 s (`load_duration`) before the prompt is read; the first local turn of 2026-11-19 took 2 min 52 s to its first event. Every `/v1/messages` request resets the expiry to 5 min. |
| E2 | VRAM contention with the WebView shaders | **Ruled out as the cause; contention itself confirmed** | Dreamer's WebView renders the shader at ~16 % resolution and is a small GPU client; the contention that made the model crawl was a game (see section 1). |
| F | Per-turn tool limits (organize max 8): the model hits "limit reached" and stops without a plan | **Confirmed** | Turn `…-97` (local /organize, 37 cards): list_tree, 3 rejected `propose_organize` plans, list_tree again, then **5 more `propose_organize` calls that each got the 47-byte "limit reached" error**, then a 10-minute hang. No plan, error at the end. |
| G1 | `requestTool` replies that never come / come after 15 s | **Ruled out** (as observed) | 0 `timed out waiting for the app` in the log; all replies within milliseconds. |
| G2 | Rust side: dropped line, stdout/stdin backpressure deadlock | **Ruled out as observed; design risk fixed** | 0 non-JSON lines, 0 write failures. But tool handlers ran *on the thread that reads the sidecar's stdout*: a tool waiting on the workspace lock stopped every event, and a large `view_attachment` reply (base64 image) written to stdin from that thread could deadlock against a full stdout pipe. Tools now run on their own threads. |
| H | (found) Claude turns waited on the local model | **Confirmed — the main reason Claude stalled too** | "Retry with Claude" and every escalated Claude turn first ran a **local recap with no timeout**. Turn `…-98`: sent 13:04:15, the recap request ran **36 min 50 s** in Ollama at 0.01 tok/s, the Claude turn started at 13:41:08. Compaction summaries had the same problem. |
| I | (found) Claude Code's own retries | **Confirmed** | A Claude server answering 500: the old pipeline needed 22 requests and 179 s to show an error (Claude Code retries with backoff). |

## 3. Fixes

All required behaviours, and where they live:

**Watchdogs (adaptive)** — `sidecar/claude-sidecar.mjs` (`turnDeadline`, one tick a second)
- First model event: 90 s local, 60 s Claude. Then 45 s max between events. Text, thinking,
  tool and step events all count; a heartbeat does not.
- Tools keep their own limits: a Rust tool request waits for its own timeout (15 s, image save
  150 s) + 5 s; a running SpriteCook call 300 s, a web call 120 s, any other tool 60 s. A credit
  confirm (waiting for the user's click) pauses the watchdog.
- The steps before the model (thread summary, escalation recap) have budgets: 150 s / 120 s for
  a summary, 60 s for a recap; a recap that runs out continues without it ("using the last messages").
- The app (Rust, `sidecar.rs` `watchdog_tick`): the sidecar sends a heartbeat for the live turn
  every 10 s; a turn the sidecar says nothing about for 40 s is failed in Rust, the sidecar is told
  to drop it (`abort_turn`) and pinged; no `pong` within 10 s restarts the sidecar.
- The UI (`useClaudeChat`, `LAST_RESORT_MS`): a streaming turn with no event and no heartbeat for
  75 s is marked failed and its session closed. The spinner can never run forever.

**On a stall** — the turn is marked ended (nothing more is sent for it, so no late event lands on
the next turn), the session is closed, its model connection is cut (the proxy aborts the upstream
request, so Ollama stops generating) and its Claude Code child is killed by pid (`taskkill /T`,
the SDK's `spawnClaudeCodeProcess` gives us the child). The UI and Rust also drop events of turns
they have ended.

**Turns and sessions** — turn objects replace the global `currentId`/`currentSession`; each
session answers one turn at a time; a new turn never queues behind an unfinished one (that process
is closed and the thread continues in a new one, resumed from its session id). Chat tools are
built per session and refuse to act for an ended turn. A soft Stop that the session does not settle
within 8 s closes it.

**Local failure policy** — on error, empty reply or stall, a local turn that has not done anything
yet (no ghost card, no question, no proposal: no duplicates) is retried once automatically in a
fresh local session, with the full context plus the thread's last messages. If that fails too,
the turn ends with a clear reason and "Retry with Claude". Nothing calls Claude without a click.
A model that keeps calling tools after "limit reached" is stopped on the third refused call.

**Claude failures** — no automatic retry on an error or a stall: a clear reason and Retry.
Claude Code's own retries are cut to 2 (local: 1). The router's existing fast→main redo is kept
only for a *thin* answer (empty, or cut short by the tool limit), never for an error.

**Local model tuning** — a small proxy in the sidecar sits between Claude Code and Ollama and
rewrites each request: thinking off (`thinking: {type: "disabled"}`), `max_tokens` ≤ 8,192,
temperature 0.7 / top_p 0.8 / top_k 20 (Qwen 3.5's non-thinking settings for tool use). It also
logs every call's estimated prompt size against `num_ctx`. The model is pre-warmed after the
startup check when the window shows, on window focus (at most every 5 min) and after every local
turn, with `keep_alive` 30 min. It is not pinned in VRAM all day while Dreamer sits in the tray:
that would take 7.7 GB from games, which is the contention that broke local chat. `num_ctx` 65,536
fits fully on the GPU when the GPU is not shared (`size_vram == size`, 33/33 layers). Local
compaction now happens by 40k tokens.

**Organize redesign** — `src-tauri/src/organize_pipeline.rs`. Folders are project versions:
organize never touches them (`create_folder`, `move` and folder `rename` are gone from the tool
schema and the prompt, and `propose_organize` rejects them). A Rust-orchestrated pipeline of small
calls replaces the single agent turn: digest (aliases c1…cN, title, tags, 120-char snippet, links;
pinned listed but kept) → groups (3–8 frames + tag plan: reuse, merge near-duplicates, ≤ 5 new) →
assign in batches of 12 (frame, tags to add / remove; ids are enums in the JSON schema and every
answer is validated; a bad batch gets one retry with the errors listed) → layout in Rust (frames
sized to their cards, a grid inside each, no overlaps, pinned cards and existing frames avoided) →
the existing plan format (`create_frame`, the new `place` op with explicit positions, `retag`),
validated by `propose_organize`, so preview / Apply / Discard / revise work as before. Local steps
use Ollama's `/api/chat` with a JSON-schema `format` (structured output), `think: false`, each with
its own watchdog (first chunk 90 s, then 45 s, 240 s per call). The chat shows "Grouping…",
"Assigning 2/4…", "Laying out…". A batch that still fails leaves its cards unplaced: the plan is
shown as partial, lists them, and offers "Finish with Claude" and "Retry rest locally"; nothing
escalates by itself. The router rule that sent big organize scopes to Claude is gone; "Redo with
Claude" runs the same pipeline on Claude (one-shot completions, no tools).

**Diagnostics** — `sidecar.log` gets one `turn_end` line per turn (sizes, ids and times only):
turn id, backend, model, attempt, end reason (done / empty / error / stalled / limit / interrupted /
superseded / aborted), estimated prompt tokens vs `num_ctx`, time to first model event, the last
event and its time, every tool call with its duration and outcome. Plus `local_call` (each model
request's size), `local_http` (status, time to first byte, bytes), `turn_stall`, `local_retry`,
`session_close`, `kill_child`, `tool_timeout`, `tool_slow`, `tool_response_late`, and
`organize call` / `turn_end … kind=organize` for the pipeline.

## 4. The harness

`src-tauri/src/harness.rs` (binary `reliability`). It drives the real sidecar and the real Rust
handlers exactly like the chat panel: `sidecar::send_message`, the `claude-event` stream, the
thread files. It runs on a temp copy of the workspace (`%USERPROFILE%\Dreamer`), never the original.

- Project: **ColonizeEarth** (the only project in the workspace: 22 live cards in 5 folders plus
  16 in trash). S3 uses a copy with all 37 card files restored onto one canvas, no folders, two
  pinned: the unorganized ~40-card case.
- Fault hooks (inert unless set): `DREAMER_FAULT_TOOL_DELAY` (Rust reply late), and a fake
  Anthropic server the sidecar can be pointed at (`DREAMER_FAKE_LOCAL_URL`,
  `DREAMER_FAKE_CLAUDE_URL`): silent, stall mid-stream, drop, HTTP 500.
- Claude usage is kept small: Haiku for chat, Sonnet for Think, no memory passes; Claude-side
  stalls and errors use the fake server.

**Re-run it yourself:**

```
npm run reliability              # everything (S1–S6 ×10, S7 ×2 each, S8 ×3 each)
npm run reliability -- --local   # S1–S6 only, no Claude usage
```

Close GPU-heavy apps first (section 1). Each run writes a folder under `%TEMP%`
(`dreamer-reliability-<time>`) with `summary.md` (the tables below), `results.jsonl` and
`logs/sidecar.log`.

## 5. Before / after

Both runs on the same machine and the same evening (the GPU was fast enough then: ~35 tok/s),
same harness, same scenarios. TTFE = time from send to the first event after the route; a
"spinner" is a turn with no end at all within the harness cap (180 s before, 600 s after). Success
criteria: S1/S4 an answer; S2 a ghost card created; S3 a valid plan covering every non-pinned card
with frames, retags, an explicit non-overlapping layout and no folder ops; S5 the retry after a
Stop answers with no stray events; S6 all 5 turns answer and the thread compacts; S7 the Claude
turn answers; S8 a clear end (anything but a spinner).

### Before (old pipeline; S1–S6 ×5, fake-server faults ×2)

| Scenario | Success | TTFE median | TTFE p95 | Turn median | Turn p95 | End reasons (all turns) | Spinners |
|---|---|---|---|---|---|---|---|
| S1 | 5/5 | 0.7s | 2.1s | 2.5s | 3.7s | done 5 | 0 |
| S2 | 5/5 | 1.8s | 26.7s | 5.2s | 34.2s | done 5 | 0 |
| S3 | 0/5 | 0.8s | 1.7s | 51.5s | 86.2s | done/tool 5 | 0 |
| S4 | 5/5 | 5.0s | 5.2s | 7.3s | 7.6s | done 5 | 0 |
| S5 | 5/5 | 0.4s | 1.9s | 3.7s | 10.3s | done 5, error/error 5 | 0 |
| S6 | 1/5 | 0.1s | 1.8s | 3.5s | 7.6s | done 24, done/tool 1 | 0 |
| S8-error-claude | 1/2 | 179.2s | 179.2s | 179.2s | 180.2s | error 1, spinner 1 | 1 |
| S8-silent-claude | 0/2 | - | - | 180.1s | 180.2s | spinner 2 | 2 |
| S8-silent-local | 0/2 | - | - | 180.1s | 180.2s | spinner 2 | 2 |
| S8-stall-local | 0/2 | 0.9s | 0.9s | 180.1s | 180.2s | spinner 2 | 2 |

### After (new pipeline; S1–S6 ×10, S7 ×2 each, S8 ×3 each)

| Scenario | Success | TTFE median | TTFE p95 | Turn median | Turn p95 | End reasons (all turns) | Spinners |
|---|---|---|---|---|---|---|---|
| S1 | 10/10 | 0.7s | 1.9s | 1.2s | 2.3s | done 10 | 0 |
| S2 | 10/10 | 2.5s | 2.7s | 2.8s | 3.3s | done 10 | 0 |
| S3 | 9/10 | 0.0s | 0.0s | 19.5s | 20.5s | done 10 | 0 |
| S4 | 10/10 | 4.7s | 11.5s | 5.1s | 12.2s | done 10 | 0 |
| S5 | 10/10 | 1.7s | 2.8s | 5.6s | 10.3s | done 10, interrupted 10 | 0 |
| S6 | 10/10 | 0.1s | 1.8s | 0.8s | 4.6s | done 50 | 0 |
| S7-chat | 2/2 | 2.8s | 3.3s | 3.0s | 3.5s | done 2 | 0 |
| S7-retry | 2/2 | 1.7s | 2.2s | 9.8s | 47.9s | done 2, error/error+retry 2 | 0 |
| S7-think | 2/2 | 0.9s | 2.2s | 4.3s | 5.3s | done 4 | 0 |
| S8-error-claude | 3/3 | 3.4s | 3.5s | 3.4s | 3.5s | error 3 | 0 |
| S8-kill-claude-code | 3/3 | 1.6s | 1.7s | 2.7s | 3.2s | done 3 | 0 |
| S8-kill-ollama | 3/3 | 4.5s | 4.5s | 6.4s | 6.5s | error/error+retry 3 | 0 |
| S8-silent-claude | 3/3 | 60.7s | 60.9s | 60.7s | 60.9s | stalled 3 | 0 |
| S8-silent-local | 3/3 | 91.4s | 94.9s | 182.0s | 185.0s | stalled/stalled+retry 3 | 0 |
| S8-stall-local | 3/3 | 1.1s | 1.3s | 93.3s | 93.4s | stalled/stalled+retry 3 | 0 |
| S8-tool-delay | 3/3 | 2.3s | 2.3s | 18.0s | 18.1s | done/tool 3 | 0 |

Notes:
- **Zero spinners after**, faults included; 7 before.
- Local S1–S6 after: 10, 10, 9, 10, 10, 10 out of 10. S3's one failure is a plan with frames, a
  clean layout and every card placed, but no tag changes (the check requires retags).
- S3 before: 0/5. The old agent turn produced folder plans (11–26 folder ops, which the new rule
  forbids) or no plan at all (2 of 5), always ending in the "tool" fallback. The old S3 fixture
  had 25 live cards and no pinned card (ghost cards were not converted yet); after: 37 cards,
  2 pinned. S3 after takes ~20 s for 37 cards (4 model calls).
- S6 before 1/5: the old harness's compaction threshold was too high to be crossed, so most runs
  never compacted (all turns answered). The after numbers use the corrected threshold (7,600).
- S8 after: a silent local server ends at ~182 s (90 s, the automatic local retry, 90 s), a stall
  mid-stream at ~93 s (45 s ×2), a silent Claude server at 61 s (no automatic retry), a Claude
  server error in 3.4 s (before: 179 s, 22 requests). Killing Ollama mid-turn: a clear error with
  "Retry with Claude" in ~6 s. A Rust tool reply 20 s late: the tool times out at 15 s and the
  model answers anyway. Killing the Claude Code child: the turns ended normally, but in these short
  turns the kill often landed after the answer was complete, so this case is weaker evidence than
  the fake-server stalls.
- **Claude usage:** 6 real Claude turns in total (S7-chat 2, S7-retry 2, S7-think 2; Haiku and
  Sonnet). The "claude" turns in the fake-server rows went to the fake server and cost nothing.
- S1, S2, S4 and S5 were already fine before *on a free GPU*. The old failures cluster in long
  turns (organize), slow or wedged models (no watchdog), escalations (the local recap) and GPU
  contention (section 1). Short local turns also got faster (S1 median 2.5 s → 1.2 s, S2 p95
  34 s → 3.3 s), because Qwen no longer thinks first.

### Model / config used

`dreamer-qwen3.5:9b` (Qwen 3.5 9B Q4_K_M, `num_ctx` 65,536, fully on the GPU), Ollama 0.40.16,
thinking off, temperature 0.7 / top_p 0.8 / top_k 20 for chat, 0.2 for the organize steps,
`max_tokens` 8,192, `keep_alive` 30 min after Dreamer's own requests.

**Model swap: not recommended.** Local reached ≥ 9/10 on every scenario after tuning, so the 2–3
alternative-model benchmark was not needed. For local chat while a game holds the GPU, the only
real options are a smaller model (`qwen3.5:4b`, ~3.3 GB) or Claude for those sessions; nothing
was changed there.

### Open points for you
- When the local model is *not ready* (Ollama down), the router still sends turns to Claude
  automatically (reason "unavailable"), as before. That predates this work; say if it should ask first.
- The memory pass after each chat turn runs on Claude (Haiku), local turns included, as before.


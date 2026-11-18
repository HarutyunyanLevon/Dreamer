import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, TECH_GAP_ITEM, type Card, type NewCard } from "../api";
import { useClaudeChat, type ChatMessage } from "../state/useClaudeChat";
import type { Workspace } from "../state/useWorkspace";
import { STAGE_LABEL } from "../theme/types";
import { ClaudeSetup, needsSetup } from "./ClaudeSetup";
import { IconClip as IconGlobe, IconPin, IconSend } from "./Icons";
import type { usePanels } from "../state/usePanels";
import { ScrollArea } from "../ui/Scroll";
import { Modal } from "../ui/Modal";
import { DECISIONS_TITLE, TECH_TEMPLATE, TECH_TITLE } from "./kinds";
import { ActivitySummary, LiveActivity, Tokens, fmtTokens, modelLabel } from "./Activity";
import type { LocalStatus, ModelTier } from "../api/claude";
import { claudeApi } from "../api/claudeIndex";
import { LocalSetup, localChipLabel } from "./LocalSetup";
import { OrganizePlanCard, reviseText } from "./OrganizePlan";
import type { OrganizeReq } from "../state/useClaudeChat";
import { folderName } from "../state/useWorkspace";

/** "/organize [project] [instruction]" -> the request (scope: the open folder unless "project"). */
function parseOrganize(text: string): OrganizeReq | null {
  const m = /^\/organize\b\s*(.*)$/is.exec(text.trim());
  if (!m) return null;
  let rest = m[1].trim();
  const whole = /^(project|all|whole project|the whole project)\b[\s:,-]*/i.exec(rest);
  if (whole) rest = rest.slice(whole[0].length).trim();
  return { scope: whole ? "project" : "folder", instruction: rest };
}

const CHIPS = ["/grill-me", "/related", "Summarize", "Give me 3 takes"];
/** Chips that open something instead of sending a message. */
const SUMMARIZE = "Summarize";
/** Chips that only make sense about a specific card. */
const NEEDS_CARD = new Set(["/related"]);
/** Fixed chip / menu commands: the memory pass skips these turns (an answer to a grill-me question is not one). */
const NO_MEMORY = /^(\/expand|\/critique|\/describe|\/merge|\/related|\/grill-me|Give me 3 takes|Merge \d+ cards)/;

/**
 * The selected card's details for this turn. The project overview (every card's title, tags and
 * stage) is added by Rust on every turn, so it isn't repeated here.
 */
function formatContext(card: Card | null): string | undefined {
  if (!card) return undefined;
  return [
    `[Selected card] "${card.title}" (id ${card.id}, stage: ${card.stage}${card.tags.length ? `, tags: ${card.tags.join(", ")}` : ""})`,
    card.body || "(no notes yet)",
  ].join("\n");
}

/**
 * What a chip / context-menu command actually sends: some short commands expand to a fixed
 * instruction about the selected card. `quiet` turns show only a typing indicator.
 */
function expand(display: string, card: Card | null): { text: string; quiet: boolean } {
  let text = display;
  if (display === "Give me 3 takes" && card) {
    const group = crypto.randomUUID();
    text = `Give me 3 distinctly different takes branching from this card. Call create_card exactly 3 times (not more, not fewer); on every one of the 3 calls set branch_group to exactly "${group}" and variant_of to "${card.id}", so they can be grouped and compared.`;
  } else if (display === "/related" && card) {
    text = `/related: find cards related to "${card.title}" (id ${card.id}) in this project and propose the strongest links from it with propose_link (from "${card.id}"). Don't create cards.`;
  } else if (display === "/expand" && card) {
    text = `/expand: expand "${card.title}" (id ${card.id}).`;
  } else if (display === "/critique" && card) {
    text = `/critique: critique "${card.title}" (id ${card.id}).`;
  } else if (display === "/describe" && card) {
    text = `/describe: describe the images on "${card.title}" (id ${card.id}).`;
  }
  return { text, quiet: display === "/grill-me" };
}

export function ChatPanel({ ws, panels }: { ws: Workspace; panels: Pick<ReturnType<typeof usePanels>, "pins" | "setPin" | "resize"> }) {
  // One thread per card; the project-level thread when no card is selected. A pin keeps the thread
  // put while other cards are selected or opened.
  const pinned = ws.active ? panels.pins[ws.active] ?? null : null;
  const thread = pinned ?? ws.contextCardId ?? "project";
  const chat = useClaudeChat({
    slug: ws.active,
    thread,
    onLinkProposal: (p) => ws.addGhostLink({ slug: p.slug, from: p.from, to: p.to, label: p.label, reason: p.reason }),
  });
  const [text, setText] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [showModels, setShowModels] = useState(false);
  /** Settings › "Summarize a thread after" (0 = never), for the context meter. */
  const [compactTokens, setCompactTokens] = useState(0);
  const loadCompactTokens = useCallback(() => {
    api.getSettings().then((s) => setCompactTokens(s.compact_tokens)).catch(() => {});
  }, []);
  useEffect(loadCompactTokens, [loadCompactTokens]);
  /** Web access for the next message only (off by default, reset after each send). */
  const [web, setWeb] = useState(false);
  /** "Think" for the next message only: deep model with a thinking budget. */
  const [think, setThink] = useState(false);
  /** A tier pinned from the header chip (null = Auto, the router decides). Beats the router. */
  const [modelPin, setModelPin] = useState<ModelTier | null>(null);
  const [tierModels, setTierModels] = useState<Record<ModelTier, string> & { router: boolean }>({ fast: "haiku", main: "sonnet", deep: "opus", router: true });
  /** Local chat (Ollama): the setting and the last status check. */
  const [localOn, setLocalOn] = useState(true);
  const [localModel, setLocalModel] = useState("");
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [showLocal, setShowLocal] = useState(false);
  const loadTierModels = useCallback(() => {
    api
      .getSettings()
      .then((s) => {
        setTierModels({ fast: s.model_fast, main: s.model_chat, deep: s.model_deep, router: s.model_router });
        setLocalOn(s.local_chat);
        setLocalModel(s.local_model);
        if (s.local_chat) claudeApi.localStatus().then(setLocalStatus).catch(() => setLocalStatus(null));
      })
      .catch(() => {});
  }, []);
  useEffect(loadTierModels, [loadTierModels]);
  /** A pinned tier's name: with local chat on, fast and main both run on the local model. */
  const tierName = (t: ModelTier) => (localOn && t !== "deep" ? "Local" : modelLabel(tierModels[t]) ?? t);
  const panelRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the message box with its text, up to half the panel's height, then scroll inside.
  // Runs on every text change, so clearing after send also shrinks it back.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.max(48, Math.floor((panelRef.current?.clientHeight ?? 600) / 2));
    const needed = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.min(needed, max)}px`;
  }, [text]);
  const bodyRef = useRef<HTMLElement | null>(null);
  const handledReq = useRef(0);

  const contextCard = (thread !== "project" && ws.data?.cards.find((c) => c.id === thread)) || null;

  // A pinned card that was trashed releases the pin.
  const { setPin } = panels;
  useEffect(() => {
    if (pinned && pinned !== "project" && ws.active && ws.data?.slug === ws.active && !ws.data.cards.some((c) => c.id === pinned)) setPin(ws.active, null);
  }, [pinned, ws.active, ws.data, setPin]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [chat.messages]);

  // Requests from elsewhere: canvas Merge (sends a turn) and the card Prompt modal (fills the input).
  const req = ws.chatRequest;
  useEffect(() => {
    if (!req || handledReq.current === req.n) return;
    // A request for another thread waits until the panel has switched to it.
    if (req.thread !== undefined && (req.thread ?? "project") !== thread) {
      // An explicit ask about another card moves the chat there, so it releases a pin.
      if (pinned && ws.active) setPin(ws.active, null);
      return;
    }
    handledReq.current = req.n;
    ws.clearChatRequest();
    if (req.send) {
      const org = parseOrganize(req.text);
      if (chat.busy) ws.setError("Claude is still answering; try again in a moment.");
      else if (org) runOrganize(org);
      else if (ws.active) {
        const x = req.display ? { text: req.text, quiet: !!req.quiet } : expand(req.text, contextCard);
        chat.sendText(x.text, formatContext(contextCard), req.display ?? req.text, { quiet: x.quiet, folder: ws.folder, memory: !NO_MEMORY.test(req.display ?? req.text) });
      }
      return;
    }
    setText(req.text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [req, ws, chat, contextCard, thread, pinned, setPin]);

  if (chat.status && needsSetup(chat.status)) {
    return <ClaudeSetup status={chat.status} refresh={chat.refreshStatus} />;
  }

  /** An organize turn: list_tree, then one reviewable propose_organize plan (local or Claude by scope size). */
  function runOrganize(req: OrganizeReq, display?: string, text?: string) {
    if (!ws.active || chat.busy) return;
    const here = ws.folder ? `folder "${folderName(ws.data?.folders.find((f) => f.id === ws.folder))}" and its subfolders` : "the whole project";
    const where = req.scope === "project" ? "the whole project" : here;
    const body =
      text ??
      `/organize (scope: ${where}): ${req.instruction || "organize it into a clear structure"}. Call list_tree with scope "${req.scope}", then propose_organize once with the whole plan.`;
    const label = display ?? (req.instruction ? `/organize ${req.scope === "project" ? "project " : ""}${req.instruction}` : `Organize ${req.scope === "project" || !ws.folder ? "the project" : "this folder"}`);
    chat.sendText(body, undefined, label, { folder: ws.folder, selection: ws.getCanvasSelection(), memory: false, organize: req });
  }

  const send = (value: string, opts?: { answering?: boolean; question?: string }) => {
    const display = value.trim();
    if (!display || !ws.active || chat.busy) return;
    const org = parseOrganize(display);
    if (org) {
      runOrganize(org, display);
      setText("");
      return;
    }
    const x = expand(display, contextCard);
    chat.sendText(x.text, formatContext(contextCard), display, { quiet: x.quiet || !!opts?.answering, web, think, pin: modelPin, selection: ws.getCanvasSelection(), folder: ws.folder, memory: !!opts?.answering || !NO_MEMORY.test(display), question: opts?.question });
    setText("");
    setWeb(false);
    setThink(false);
  };

  /** "Save as clip": fetches the page into a clip on the chat's card, or a new clip card. */
  const saveClip = async (m: ChatMessage, url: string) => {
    const slug = ws.active;
    if (!slug) return;
    const clip = await api.fetchClip(slug, url).catch((e) => {
      ws.setError(String(e));
      return null;
    });
    if (!clip) return;
    const card = contextCard ? ws.data?.cards.find((c) => c.id === contextCard.id) : undefined;
    const ok = card ? await ws.setAttachments(card.id, [...card.attachments, clip]) : await ws.createCard({ kind: "clip", title: clip.title || url, attachments: [clip] });
    if (ok) chat.markFetchSaved(m.id, url);
  };

  /**
   * A handoff gap interview answer: "platform & tech" goes on the Tech & constraints card, every
   * other item on the Project decisions card. Either is created when the project has none yet.
   */
  const recordGapAnswer = async (item: string, question: string, choice: string) => {
    const isTech = item.trim().toLowerCase() === TECH_GAP_ITEM;
    const role = isTech ? "tech" : "decisions";
    let card: Card | null | undefined = ws.data?.cards.find((c) => c.role === role && !c.ghost);
    if (!card) {
      const fresh: NewCard = isTech
        ? { title: TECH_TITLE, role: "tech", body: TECH_TEMPLATE }
        : { title: DECISIONS_TITLE, role: "decisions", stage: "lucid", body: "Answers that settle open project questions (from the handoff gap interview)." };
      card = await ws.createCard(fresh);
      if (!card) return;
    }
    const sep = card.body.trim() ? "\n\n" : "";
    await ws.updateCard(card.id, { body: `${card.body.trimEnd()}${sep}**${item}:** ${question}\n**A:** ${choice}` });
  };

  const answer = (m: ChatMessage, choice: string) => {
    chat.answerQuestion(m.id, choice);
    if (m.question?.item) {
      void recordGapAnswer(m.question.item, m.question.question, choice);
    } else if (contextCard) {
      void ws.updateCard(contextCard.id, { body: `${contextCard.body}${contextCard.body ? "\n\n" : ""}**Q:** ${m.question!.question}\n**A:** ${choice}` });
    }
    send(choice, { answering: true, question: m.question!.question });
  };

  return (
    <aside id="chat-panel" className="glass chat" aria-label="Claude chat" data-wheel-boundary="" ref={panelRef}>
      <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize chat panel" title="Drag to resize, double-click to reset" {...panels.resize.right} />
      <header className="chat-head">
        <div className="orb" aria-hidden="true" />
        <div>
          <div className="chat-title">Claude</div>
          <div className="chat-sub">{contextCard ? `About "${contextCard.title}" · ${STAGE_LABEL[contextCard.stage]}` : "Project chat"}</div>
          <div className="thread-row">
            <span className={"thread-pill" + (pinned ? " pinned" : "")} title={pinned ? "Pinned thread" : "Following the selected card"}>
              {pinned && <IconPin />}
              {contextCard ? (
                <>
                  <span className={`dot dot-${contextCard.stage}`} aria-hidden="true" />
                  <span className="thread-name">{contextCard.title || "Untitled"}</span>
                </>
              ) : (
                <span className="thread-name">Project</span>
              )}
            </span>
            {contextCard && (
              <button
                type="button"
                className="chip"
                title="Switch to the project thread"
                onClick={() => (pinned && ws.active ? panels.setPin(ws.active, "project") : ws.setContextCard(null))}
              >
                Project
              </button>
            )}
            <button
              type="button"
              className={"chip pin-toggle" + (pinned ? " on" : "")}
              aria-pressed={!!pinned}
              title={pinned ? "Unpin: follow the selected card" : "Pin this thread while you select other cards"}
              disabled={!ws.active}
              onClick={() => ws.active && panels.setPin(ws.active, pinned ? null : thread)}
            >
              <IconPin />
            </button>
          </div>
          {chat.context && chat.context.tokens > 0 && <ContextMeter tokens={chat.context.tokens} window={chat.context.window} compactTokens={compactTokens} />}
        </div>
        <div className="chat-head-actions">
          <button
            type="button"
            className="chip"
            disabled={chat.busy || !ws.active}
            title={ws.folder ? "Let Claude propose how to organize this folder (you review it first). /organize project for everything" : "Let Claude propose how to organize the project (you review it first)"}
            onClick={() => runOrganize({ scope: ws.folder ? "folder" : "project", instruction: "" })}
          >
            Organize
          </button>
          {ws.active && ws.active !== "inbox" && (
            <button type="button" className="chip" title="What Dreamer remembers about this project" onClick={() => ws.setMemoryOpen(true)}>
              Memory
            </button>
          )}
          <button
            type="button"
            className={"chip model-chip" + (modelPin ? " on" : "")}
            title={
              modelPin
                ? `Pinned to ${tierName(modelPin)}. Click to change.`
                : localOn
                  ? `Auto: the local model (${localModel}) for chat; Claude for Think, web and Retry with Claude. Click to pin a model.`
                  : tierModels.router
                    ? "Auto: a small model for simple actions, the chat model otherwise. Click to pin a model."
                    : "Auto (router off): the chat model. Click to pin a model."
            }
            onClick={() => setModelPin((p) => (p === null ? "fast" : p === "fast" ? "main" : p === "main" ? "deep" : null))}
          >
            {modelPin ? tierName(modelPin) : "Auto"}
          </button>
          <button
            type="button"
            className={"chip local-chip" + (localOn && localStatus && !localStatus.ready ? " warn" : "")}
            title={!localOn ? "Local chat is off (Settings): every turn uses Claude" : localStatus?.ready ? `Chat runs on ${localStatus.model} through Ollama` : localStatus?.error ?? "Checking Ollama…"}
            onClick={() => setShowLocal(true)}
          >
            {localChipLabel(localStatus, localOn)}
          </button>
          <button type="button" className="chip" title="Which Claude models Dreamer uses" onClick={() => setShowModels(true)}>
            Models
          </button>
          <button
            type="button"
            className="chip"
            disabled={chat.busy || chat.messages.length === 0}
            title={contextCard ? `Clear the chat about "${contextCard.title}"` : "Clear the project chat"}
            onClick={() => setConfirmReset(true)}
          >
            Reset chat
          </button>
        </div>
      </header>
      {showLocal && <LocalSetup onClose={() => setShowLocal(false)} onStatus={setLocalStatus} />}
      {showModels && (
        <ModelSettings
          onClose={() => {
            setShowModels(false);
            loadCompactTokens();
            loadTierModels();
          }}
          onError={ws.setError}
        />
      )}
      {confirmReset && (
        <Modal onClose={() => setConfirmReset(false)} label="Reset chat" size="sm">
          <h3 className="dialog-title">Reset this chat?</h3>
          <p>
            This clears the conversation {contextCard ? <>about <strong>{contextCard.title}</strong></> : <>for the whole project</>} and starts Claude on a
            fresh session. Other cards' chats and all cards stay as they are.
          </p>
          <div className="editor-actions">
            <div className="side-spacer" />
            <button type="button" className="btn" onClick={() => setConfirmReset(false)}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setConfirmReset(false);
                void chat.reset().catch((e) => ws.setError(String(e)));
              }}
            >
              Reset chat
            </button>
          </div>
        </Modal>
      )}

      <ScrollArea boundary className="chat-body" ref={bodyRef}>
        {chat.messages.length === 0 && (
          <div className="msg claude">
            {contextCard
              ? `This is the chat for "${contextCard.title}". Ask a question, or use /grill-me, /related or Give me 3 takes.`
              : "This is the project chat. Select a card to open its own thread."}
          </div>
        )}
        {chat.messages.map((m) => (
          <Fragment key={m.id}>
          <ChatBubble
            key={m.id}
            message={m}
            onAnswer={(choice) => answer(m, choice)}
            onOpenCard={(id, project) => void ws.focusCard(id, project)}
            activeProject={ws.active}
            cardTitle={(id) => ws.data?.cards.find((c) => c.id === id)?.title}
            pending={(id) => !!ws.data?.proposals?.[id]}
            onSaveClip={(url) => void saveClip(m, url)}
            onUndoMemory={() => void chat.undoMemory(m.id).catch((e) => ws.setError(String(e)))}
            onEditMemory={() => ws.setMemoryOpen(true)}
            saveTarget={contextCard ? "this card" : "a new clip card"}
            retryDisabled={chat.busy}
            onStop={() => chat.interrupt()}
            onRetryStalled={() => chat.retryStalled(m.id)}
            onRetryWithClaude={() => chat.retryWithClaude(m.id)}
            onRetry={() => {
              // Not sent in this session (it failed before a restart): resend its visible text.
              if (!chat.retry(m.id)) {
                const user = chat.messages.find((x) => x.id === `${m.id}-u`);
                if (user) send(user.text);
              }
            }}
          />
          {m.organize && (
            <OrganizePlanCard
              message={m}
              ws={ws}
              busy={chat.busy}
              onChange={(patch) => chat.setOrganize(m.id, patch)}
              onRedo={(backend) => {
                const user = chat.messages.find((x) => x.id === `${m.id}-u`);
                const req = m.organizeReq ?? { scope: m.organize!.plan.scope, instruction: user?.text ?? "" };
                runOrganize({ ...req, backend }, `${user?.text ?? "Organize"} (${backend === "claude" ? "with Claude" : "locally"})`);
              }}
              onRevise={(ask) => runOrganize({ scope: m.organize!.plan.scope, instruction: ask, backend: m.backend ?? null }, `Revise the plan: ${ask}`, reviseText(m.organize!.plan, ask))}
            />
          )}
          </Fragment>
        ))}
      </ScrollArea>

      <div className="chips">
        {CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            className="chip"
            disabled={chat.busy || !ws.active || (NEEDS_CARD.has(c) && !contextCard)}
            title={NEEDS_CARD.has(c) && !contextCard ? "Open a card first" : c === SUMMARIZE ? "Turn the project into design docs for Claude Code (handoff pack)" : undefined}
            onClick={() => (c === SUMMARIZE ? ws.openHandoff(contextCard ? { kind: "card", id: contextCard.id } : { kind: "project" }) : send(c))}
          >
            {c}
          </button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <button
          type="button"
          className={"web-toggle" + (web ? " on" : "")}
          aria-pressed={web}
          aria-label="Web access for this message"
          title={web ? `Web on for this message: Claude may search and fetch pages${localOn ? " (this message goes to Claude, not the local model)" : ""}` : "Let Claude search the web for this message"}
          disabled={chat.busy || !ws.active}
          onClick={() => setWeb((w) => !w)}
        >
          <IconGlobe />
        </button>
        <button
          type="button"
          className={"web-toggle think-toggle" + (think ? " on" : "")}
          aria-pressed={think}
          aria-label="Think harder for this message"
          title={think ? `Think on for this message: ${modelLabel(tierModels.deep)} with extended thinking` : `Think harder for this message (${modelLabel(tierModels.deep)}, thinking on)`}
          disabled={chat.busy || !ws.active}
          onClick={() => setThink((v) => !v)}
        >
          Think
        </button>
        <textarea
          ref={inputRef}
          className="scroll scroll-y"
          rows={1}
          aria-label="Message Claude"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline; never send mid-IME-composition.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder={contextCard ? "Message Claude about this card…" : "Message Claude about this project…"}
          disabled={chat.busy || !ws.active}
        />
        {chat.busy ? (
          <button type="button" className="send" aria-label="Stop" onClick={() => chat.interrupt()}>
            ■
          </button>
        ) : (
          <button type="submit" className="send" aria-label="Send" disabled={!text.trim() || !ws.active}>
            <IconSend />
          </button>
        )}
      </form>
    </aside>
  );
}

function ChatBubble({
  message,
  onAnswer,
  onOpenCard,
  activeProject,
  cardTitle,
  pending,
  onSaveClip,
  onUndoMemory,
  onEditMemory,
  saveTarget,
  onRetry,
  onRetryWithClaude,
  retryDisabled,
  onStop,
  onRetryStalled,
}: {
  onRetry: () => void;
  /** A failed local turn: send it to Claude once. */
  onRetryWithClaude: () => void;
  retryDisabled: boolean;
  /** Stop / Retry offered by a stalled live turn. */
  onStop: () => void;
  onRetryStalled: () => void;
  message: ChatMessage;
  onAnswer: (choice: string) => void;
  onOpenCard: (id: string, project: string) => void;
  activeProject: string | null;
  cardTitle: (id: string) => string | undefined;
  pending: (cardId: string) => boolean;
  onSaveClip: (url: string) => void;
  onUndoMemory: () => void;
  onEditMemory: () => void;
  saveTarget: string;
}) {
  const [showSummary, setShowSummary] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const live = message.role === "claude" && message.streaming;
  const compacting = message.steps?.some((s) => s.sid === "compact" && s.status === "running");
  const activity = live ? (
    <LiveActivity
      steps={message.steps}
      usage={compacting ? message.compactUsage : message.usage}
      startedAt={message.startedAt ?? Date.now()}
      lastEventAt={message.lastEventAt ?? message.startedAt ?? Date.now()}
      writing={!!message.text && !message.quiet}
      onStop={onStop}
      onRetry={onRetryStalled}
    />
  ) : message.role === "claude" && !message.failure ? (
    // Turns with a backend show model and tokens in the badge under the reply instead.
    <ActivitySummary
      steps={message.steps}
      usage={message.backend ? undefined : message.usage}
      durationMs={message.durationMs}
      model={message.backend ? undefined : message.model}
      retriedFrom={message.retried ? message.retriedFrom : undefined}
    />
  ) : null;
  const localFailed = message.role === "claude" && !live && message.backend === "local" && (!!message.fallback || (message.isError && !message.failure));
  const retryClaude = localFailed && (
    <div className="chat-failure">
      <div className="chat-failure-line">
        <span>{FALLBACK_TEXT[message.fallback ?? "error"]}</span>
        <button type="button" className="chip" disabled={retryDisabled} onClick={onRetryWithClaude} title="Send this message to Claude once, with a recap of the thread; the next message is local again">
          Retry with Claude
        </button>
      </div>
    </div>
  );
  const badge = message.role === "claude" && !live && !message.failure && <ModelBadge message={message} />;
  const memBusy = message.memoryBusy && (
    <div className="memory-line busy" aria-live="polite">
      <span className="memory-text">
        Updating memory…{message.memoryBusy.input > 0 && <> ↑ {fmtTokens(message.memoryBusy.input)}</>}
      </span>
    </div>
  );
  if (message.kind === "compacted") {
    return (
      <button type="button" className="chat-compacted" title={message.summary || "Summary unavailable"} onClick={() => setShowSummary((v) => !v)}>
        Earlier messages summarized
        {showSummary && <span className="chat-compacted-text">{message.summary}</span>}
      </button>
    );
  }
  const mem = message.memory && (
    <div className={"memory-line" + (message.memory.undone ? " undone" : "")} aria-label="Memory update">
      <span className="memory-text">{message.memory.undone ? "Memory change undone" : `Memory updated: ${message.memory.label}`}</span>
      {!message.memory.undone && (
        <button type="button" className="memory-act" onClick={onUndoMemory}>
          Undo
        </button>
      )}
      <button type="button" className="memory-act" onClick={onEditMemory}>
        Edit memory
      </button>
    </div>
  );
  if (message.question) {
    return (
      <>
      {activity}
      <div className="msg claude">
        {message.question.question}
        <div className="chips question-chips">
          {message.question.choices.map((c) => (
            <button key={c} type="button" className={"chip" + (message.question!.answered === c ? " on" : "")} disabled={!!message.question!.answered} onClick={() => onAnswer(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      {badge}
      {retryClaude}
      {memBusy}
      {mem}
      </>
    );
  }
  const showText = message.role === "user" || !!message.text;
  return (
    <>
      {message.routeReason === "size" && (
        <div className="model-note" role="note">
          {message.routeNote ? `${message.routeNote[0].toUpperCase()}${message.routeNote.slice(1)}` : "A large scope"}: this plan uses Claude.
        </div>
      )}
      {message.role === "claude" && !live && activity}
      {message.searches?.map((s, i) => (
        <div key={i} className="search-trace" aria-label={`Searched cards: ${s.query}`}>
          <div className="search-trace-head">
            Searched cards: <strong>{s.query}</strong>
            {s.results.length === 0 && <span className="chat-sub"> · no matches</span>}
          </div>
          {s.results.length > 0 && (
            <div className="chips search-chips">
              {s.results.map((r) => (
                <button
                  key={`${r.project}:${r.id}`}
                  type="button"
                  className={"chip result-chip" + (r.ghost ? " ghost" : "")}
                  title={r.project === activeProject ? "Show on canvas" : `Open in ${r.projectName}`}
                  onClick={() => onOpenCard(r.id, r.project)}
                >
                  <span className={`dot dot-${r.stage}`} aria-hidden="true" />
                  {r.title}
                  {r.project !== activeProject && <span className="result-proj">{r.projectName}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {message.fetched && message.fetched.length > 0 && (
        <div className="search-trace fetch-trace" aria-label="Pages Claude read">
          <div className="search-trace-head">Read on the web</div>
          {message.fetched.map((f) => (
            <div key={f.url} className="chips search-chips">
              <span className="fetch-url" title={f.url}>{f.url.replace(/^https?:\/\//, "")}</span>
              <button type="button" className="chip" disabled={f.saved} title={f.saved ? undefined : `Save this page as a web clip on ${saveTarget}`} onClick={() => onSaveClip(f.url)}>
                {f.saved ? "Saved" : "Save as clip"}
              </button>
            </div>
          ))}
        </div>
      )}
      {message.proposals?.map((p) => (
        <div key={`prop-${p.card}`} className="search-trace">
          <div className="search-trace-head">
            Suggested changes to <strong>{cardTitle(p.card) ?? p.title}</strong>
            {pending(p.card) ? " · open the card's badge to keep or dismiss them" : " · settled"}
          </div>
          {pending(p.card) && activeProject && (
            <div className="chips search-chips">
              <button type="button" className="chip result-chip ghost" onClick={() => onOpenCard(p.card, activeProject)}>
                Show card
              </button>
            </div>
          )}
        </div>
      ))}
      {live && activity}
      {showText && !(message.quiet && live) && (
        <div className={"msg" + (message.role === "claude" ? " claude" : " user") + (message.isError && !message.failure ? " error" : "")}>
          {message.text}
        </div>
      )}
      {badge}
      {retryClaude}
      {message.isError && !message.failure && !live && message.backend !== "local" && (
        <div className="chat-failure">
          <div className="chat-failure-line">
            <button type="button" className="chip" disabled={retryDisabled} onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      )}
      {message.failure && (
        <div className="chat-failure" role="alert">
          <div className="chat-failure-line">
            <span>
              {message.failure.restarted ? "Claude's helper was restarted." : `Claude's helper stopped (code ${message.failure.code ?? "unknown"}).`}
            </span>
            <button type="button" className="chip" disabled={retryDisabled} onClick={onRetry}>
              Retry
            </button>
            {message.failure.details.length > 0 && (
              <button type="button" className="memory-act" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
                {showDetails ? "Hide details" : "Show details"}
              </button>
            )}
          </div>
          {showDetails && <pre className="chat-failure-details scroll scroll-x">{message.failure.details.join("\n")}</pre>}
        </div>
      )}
      {memBusy}
      {mem}
    </>
  );
}

const FALLBACK_TEXT: Record<string, string> = {
  error: "The local model couldn't answer.",
  empty: "The local model gave no answer.",
  tool: "A tool call by the local model failed.",
  vision: "The local model can't look at images.",
};

const REASON_TEXT: Record<string, string> = { think: "Think harder", web: "web", retry: "retried with Claude", unavailable: "local model unavailable", size: "large scope" };

/** Under each reply: "local · qwen3.5:35b-a3b" or "Claude · Opus · Think harder · ↑ 12k ↓ 300". */
function ModelBadge({ message: m }: { message: ChatMessage }) {
  if (!m.backend) return null;
  if (m.backend === "local") {
    return (
      <div className="model-badge local" title="Answered by the local model through Ollama (no Claude usage)">
        local · {m.model}
      </div>
    );
  }
  const reason = m.routeReason ? REASON_TEXT[m.routeReason] : null;
  return (
    <>
      {m.routeReason === "unavailable" && (
        <div className="model-note" role="note">
          Local model unavailable{m.routeNote ? `: ${m.routeNote}` : "."} This reply used Claude.
        </div>
      )}
      <div className="model-badge claude" title={m.escalated ? "One Claude turn with a recap of this thread; the next message is local again" : undefined}>
        Claude · {modelLabel(m.model) ?? "Claude"}
        {reason && <> · {reason}</>}
        {m.usage && (
          <>
            {" · "}
            <Tokens usage={m.usage} />
          </>
        )}
      </div>
    </>
  );
}

/** "34k / 200k" with a thin bar; amber from 80% of the auto-summary threshold. */
function ContextMeter({ tokens, window, compactTokens }: { tokens: number; window: number; compactTokens: number }) {
  const warn = compactTokens > 0 && tokens >= compactTokens * 0.8;
  const pct = Math.min(100, (tokens / Math.max(1, window)) * 100);
  const tip =
    `This thread's context: ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens after the last reply.` +
    (compactTokens > 0
      ? ` When a turn's input passes ${compactTokens.toLocaleString()} tokens, Dreamer summarizes the earlier messages and continues in a fresh session (Settings › “Summarize a thread after”).`
      : " Automatic summarizing is off (Settings › “Summarize a thread after” is 0).");
  return (
    <div className={"ctx-meter" + (warn ? " warn" : "")} title={tip} aria-label={tip}>
      <span className="ctx-meter-text">
        {fmtTokens(tokens)} / {fmtTokens(window)}
      </span>
      <span className="ctx-meter-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

const MODEL_SUGGESTIONS = ["sonnet", "opus", "haiku", "fable"];

/** Settings: which Claude model the chat and the handoff pack use (aliases or full model ids). */
function ModelSettings({ onClose, onError }: { onClose: () => void; onError: (e: string) => void }) {
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [exportModel, setExportModel] = useState("");
  const [router, setRouter] = useState(true);
  const [fastModel, setFastModel] = useState("");
  const [deepModel, setDeepModel] = useState("");
  const [memoryModel, setMemoryModel] = useState("");
  const [compactTokens, setCompactTokens] = useState("");
  const [memoryCap, setMemoryCap] = useState("");
  const [localChat, setLocalChat] = useState(true);
  const [localModel, setLocalModel] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [startHidden, setStartHidden] = useState(true);
  useEffect(() => {
    api.autostartEnabled().then(setAutostart).catch(() => setAutostart(false));
    api
      .getSettings()
      .then((s) => {
        setStartHidden(s.start_hidden);
        setChatModel(s.model_chat);
        setExportModel(s.model_export);
        setRouter(s.model_router);
        setFastModel(s.model_fast);
        setDeepModel(s.model_deep);
        setMemoryModel(s.model_memory);
        setCompactTokens(String(s.compact_tokens));
        setMemoryCap(String(s.memory_cap));
        setLocalChat(s.local_chat);
        setLocalModel(s.local_model);
      })
      .catch((e) => onError(String(e)));
  }, [onError]);
  const save = async () => {
    try {
      await api.updateSettings({ model_chat: chatModel ?? "", model_router: router, model_fast: fastModel, model_deep: deepModel, model_export: exportModel, model_memory: memoryModel, compact_tokens: Math.max(0, Math.floor(Number(compactTokens)) || 0), memory_cap: Math.max(0, Math.floor(Number(memoryCap)) || 0), local_chat: localChat, local_model: localModel });
      onClose();
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <Modal onClose={onClose} label="Claude models" size="sm">
      <h3 className="dialog-title">Settings</h3>
      <form
        className="model-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="check-row">
          <input type="checkbox" checked={localChat} disabled={chatModel === null} onChange={(e) => setLocalChat(e.target.checked)} />
          Chat on a local model (Ollama); Claude only for Think, web and Retry with Claude
        </label>
        <label>
          Local model (Ollama)
          <input className="name-input" value={localModel} disabled={chatModel === null || !localChat} placeholder="qwen3.5:35b-a3b" onChange={(e) => setLocalModel(e.target.value)} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={router} disabled={chatModel === null} onChange={(e) => setRouter(e.target.checked)} />
          Route chat messages to the cheapest fitting model
        </label>
        <label>
          Fast (simple actions and lookups)
          <input className="name-input" list="claude-models" value={fastModel} disabled={chatModel === null || !router} placeholder="haiku" onChange={(e) => setFastModel(e.target.value)} />
        </label>
        <label>
          Main (chat)
          <input className="name-input" list="claude-models" value={chatModel ?? ""} disabled={chatModel === null} placeholder="sonnet" onChange={(e) => setChatModel(e.target.value)} />
        </label>
        <label>
          Deep (the Think button)
          <input className="name-input" list="claude-models" value={deepModel} disabled={chatModel === null} placeholder="opus" onChange={(e) => setDeepModel(e.target.value)} />
        </label>
        <label>
          Handoff pack
          <input className="name-input" list="claude-models" value={exportModel} disabled={chatModel === null} placeholder="opus" onChange={(e) => setExportModel(e.target.value)} />
        </label>
        <label>
          Thread summaries
          <input className="name-input" list="claude-models" value={memoryModel} disabled={chatModel === null} placeholder="haiku" onChange={(e) => setMemoryModel(e.target.value)} />
        </label>
        <label>
          Summarize a thread after (input tokens)
          <input className="name-input" inputMode="numeric" value={compactTokens} disabled={chatModel === null} placeholder="50000" onChange={(e) => setCompactTokens(e.target.value)} />
        </label>
        <label>
          Project memory cap (words)
          <input className="name-input" inputMode="numeric" value={memoryCap} disabled={chatModel === null} placeholder="600" onChange={(e) => setMemoryCap(e.target.value)} />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={autostart === true}
            disabled={autostart === null}
            onChange={(e) => {
              api.setAutostart(e.target.checked).then(setAutostart).catch((er) => onError(String(er)));
            }}
          />
          Start Dreamer when Windows starts
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={startHidden}
            onChange={(e) => {
              setStartHidden(e.target.checked);
              api.updateSettings({ start_hidden: e.target.checked }).catch((er) => onError(String(er)));
            }}
          />
          Start hidden in the tray
        </label>
        <datalist id="claude-models">
          {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
        </datalist>
        <p className="chat-sub">An alias (sonnet, opus, haiku, fable) or a full model id. Leave empty for the default. Applies from the next message.</p>
        <div className="editor-actions">
          <button type="button" className="btn" title="Show sidecar.log, the record of Dreamer's Claude helper (no message text)" onClick={() => api.openLogsFolder().catch((er) => onError(String(er)))}>
            Open logs folder
          </button>
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={chatModel === null}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

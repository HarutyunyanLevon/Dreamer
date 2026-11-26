import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, TECH_GAP_ITEM, type Card, type OrganizePlanData, type ProjectData } from "../api";
import { openQuestions } from "./kinds";
import { useClaudeChat, type ChatMessage } from "../state/useClaudeChat";
import type { Workspace } from "../state/useWorkspace";
import { ClaudeSetup, needsSetup } from "./ClaudeSetup";
import { IconBulb, IconClip as IconGlobe, IconPlus, IconSend } from "./Icons";
import type { usePanels } from "../state/usePanels";
import { ScrollArea } from "../ui/Scroll";
import { Modal } from "../ui/Modal";
import { ActivitySummary, LiveActivity, Tokens, fmtTokens, modelLabel } from "./Activity";
import { isCloudModel } from "../api/claude";
import type { LocalStatus, ModelTier } from "../api/claude";
import type { SkillStatus, SpritecookKeyStatus } from "../api";
import { claudeApi } from "../api/claudeIndex";
import { LocalSetup } from "./LocalSetup";
import { RESTART_LABEL, useOllamaRestart } from "../state/useOllamaRestart";
import { ThreadMenu } from "./chat/ThreadMenu";
import { Popover } from "./chat/Popover";
import { PanelMenu } from "./chat/PanelMenu";
import { ModelChip } from "./chat/ModelChip";
import { ActionMenu, filterActions, type ChatAction } from "./chat/ActionMenu";
import { OrganizePlanCard, reviseText } from "./OrganizePlan";
import type { OrganizeReq } from "../state/useClaudeChat";
import { cardRect } from "./cardGeometry";
import { centerInside } from "./Frames";
import { refreshBalance, useBalance } from "../state/artifactRuns";
import { buildRuns, liveRunOf, useBuildRuns } from "../state/buildRuns";
import { BuildPanel } from "./BuildPanel";

/**
 * "/organize [project | selection | frame <id>] [instruction]" -> the request (default: the project).
 * Frame and selection resolve to their cards here.
 */
function parseOrganize(text: string, data: ProjectData | null, selection: string[]): OrganizeReq | { error: string } | null {
  const m = /^\/organize\b\s*(.*)$/is.exec(text.trim());
  if (!m) return null;
  let rest = m[1].trim();
  const take = (re: RegExp) => {
    const x = re.exec(rest);
    if (x) rest = rest.slice(x[0].length).trim();
    return x;
  };
  const frame = take(/^frame\s+(\S+)[\s:,-]*/i);
  if (frame) {
    const f = data?.canvas.frames[frame[1]];
    if (!f || !data) return { error: "That frame is gone." };
    const ids = Object.entries(data.canvas.cards).filter(([, p]) => centerInside(f, cardRect(p))).map(([id]) => id);
    return { scope: "frame", ids, name: f.title.trim() || "Untitled frame", instruction: rest };
  }
  if (take(/^(selection|selected)\b[\s:,-]*/i)) {
    if (!selection.length) return { error: "Select some cards on the canvas first." };
    return { scope: "selection", ids: selection, instruction: rest };
  }
  take(/^(project|all|whole project|the whole project)\b[\s:,-]*/i);
  return { scope: "project", instruction: rest };
}

const planScope = (p: OrganizePlanData): Pick<OrganizeReq, "scope" | "ids" | "name"> => ({ scope: p.scope, ids: p.scopeIds ?? undefined, name: p.scopeName });
const scopeWords = (r: OrganizeReq) => (r.scope === "frame" ? `frame "${r.name}"` : r.scope === "selection" ? `the ${r.ids?.length ?? 0} selected cards` : "the whole project");

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
  const builds = useBuildRuns();
  const building = liveRunOf(builds, ws.active);
  const chat = useClaudeChat({
    slug: ws.active,
    thread,
    onLinkProposal: (p) => ws.addGhostLink({ slug: p.slug, from: p.from, to: p.to, label: p.label, reason: p.reason }),
    // A chat turn (usually local) asked for a visual: Claude makes it in a new artifact card, with
    // a recap of the thread that asked. The request waits until that chat turn has finished.
    onArtifactEscalate: (e, from) => {
      if (from.slug !== ws.active) return;
      const source = from.thread !== "project" ? ws.data?.cards.find((c) => c.id === from.thread) : undefined;
      const pos = source ? ws.data?.canvas.cards[source.id] : undefined;
      void ws.createArtifact(
        { type: e.artifactType, title: e.title, brief: e.brief, sourceCard: source?.id, ...(pos ? { x: pos.x + (pos.w ?? 260) + 60, y: pos.y } : {}) },
        { recapFrom: from.thread },
      );
    },
  });
  // STATUS.md changed in the repo: a line in the project thread, whatever thread is open.
  const addBuildNote = chat.addBuildNote;
  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    api.onBuildUpdate((u) => (u.built.length + u.partial.length + u.in_progress.length + u.new.length + u.blocked.length > 0 || u.warnings.length > 0) && addBuildNote(u)).then((f) => (gone ? f() : (un = f)), () => {});
    return () => {
      gone = true;
      un?.();
    };
  }, [addBuildNote]);
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
  /** Whether the last typed message had Think on: the answers to its follow-up questions inherit it. */
  const lastThink = useRef(false);
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
  // An artifact card's "Images need a SpriteCook key" note opens Settings.
  useEffect(() => {
    const open = () => setShowModels(true);
    window.addEventListener("dreamer:open-settings", open);
    return () => window.removeEventListener("dreamer:open-settings", open);
  }, []);
  // Startup may find and prepare a local model after the panel loaded its settings.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onLocalSetupEvent((e) => {
        if (e.type === "detected" || e.type === "done") loadTierModels();
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [loadTierModels]);
  /** A pinned tier's name: with local chat on, fast and main both run on the local model. */
  const tierName = (t: ModelTier) => (localOn && t !== "deep" ? "Local" : modelLabel(tierModels[t]) ?? t);
  const panelRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the message box with its text, 1 to 8 lines, then scroll inside.
  // Runs on every text change, so clearing after send also shrinks it back.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + (el.offsetHeight - el.clientHeight);
    const needed = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.min(needed, Math.ceil(line * 8 + pad))}px`;
  }, [text]);
  /** The action menu: "+" (focus inside it) or "/" typed first (focus stays in the textarea). */
  const [plusOpen, setPlusOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState(0);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    setActiveAction(0);
    setActionNotice(null);
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
    // An artifact request (or one that asked to wait) is held until Claude is free.
    if (req.send && req.wait && chat.busy) return;
    handledReq.current = req.n;
    ws.clearChatRequest();
    if (req.send && req.artifact) {
      chat.sendText(req.text, undefined, req.display ?? req.text, { artifact: req.artifact, recapFrom: req.recapFrom, memory: false });
      return;
    }
    if (req.send) {
      const org = parseOrganize(req.text, ws.data, ws.getCanvasSelection());
      if (chat.busy) ws.setError("Claude is still answering; try again in a moment.");
      else if (org && "error" in org) ws.setError(org.error);
      else if (org) runOrganize(org);
      else if (ws.active) {
        const x = req.display ? { text: req.text, quiet: !!req.quiet } : expand(req.text, contextCard);
        chat.sendText(x.text, formatContext(contextCard), req.display ?? req.text, { quiet: x.quiet, memory: !NO_MEMORY.test(req.display ?? req.text) });
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
    const where = scopeWords(req);
    const body =
      text ??
      `/organize (scope: ${where}): ${req.instruction || "organize it into a clear structure"}. Call list_tree, then propose_organize once with the whole plan.`;
    const label = display && !display.startsWith("/organize frame") ? display : req.instruction ? `/organize ${req.instruction}` : `Organize ${req.scope === "project" ? "the project" : where}`;
    chat.sendText(body, undefined, label, { selection: ws.getCanvasSelection(), memory: false, organize: req });
  }

  const send = (value: string, opts?: { answering?: boolean; question?: string }) => {
    const display = value.trim();
    if (!display || !ws.active || chat.busy) return;
    const org = parseOrganize(display, ws.data, ws.getCanvasSelection());
    if (org && "error" in org) {
      ws.setError(org.error);
      return;
    }
    if (org) {
      runOrganize(org, display);
      setText("");
      return;
    }
    // In an artifact's thread every message is an artifact turn on Claude (feedback, a new part).
    if (contextCard?.kind === "artifact" && !contextCard.ghost) {
      chat.sendText(display, undefined, display, { artifact: contextCard.id, think, memory: false });
      setText("");
      setThink(false);
      return;
    }
    const x = expand(display, contextCard);
    // Answering a question Claude asked (e.g. /grill-me) keeps the Think of the message that started it.
    const thinkNow = opts?.answering ? think || lastThink.current : think;
    if (!opts?.answering) lastThink.current = think;
    chat.sendText(x.text, formatContext(contextCard), display, { quiet: x.quiet || !!opts?.answering, web, think: thinkNow, pin: modelPin, selection: ws.getCanvasSelection(), memory: !!opts?.answering || !NO_MEMORY.test(display), question: opts?.question });
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
  const recordGapAnswer = (item: string, question: string, choice: string) =>
    ws.appendToRoleCard(item.trim().toLowerCase() === TECH_GAP_ITEM ? "tech" : "decisions", `**${item}:** ${question}
**A:** ${choice}`, "record answer");

  /** A sent question form: one reply message, and each answer recorded where its question points. */
  const answer = (m: ChatMessage, answers: Record<string, string | undefined>) => {
    const qs = m.questions ?? [];
    chat.answerQuestions(m.id, answers);
    const got = qs.flatMap((q) => (answers[q.id] ? [{ q, a: answers[q.id]! }] : []));
    for (const { q, a } of got) if (q.item && !q.itemId) void recordGapAnswer(q.item, q.question, a);
    const card = contextCard && ws.data?.cards.find((c) => c.id === contextCard.id);
    const byItem = new Map(got.flatMap(({ q, a }) => (q.itemId ? [[q.itemId, a] as const] : [])));
    const plain = got.filter(({ q }) => !q.item && !q.itemId);
    if (card && byItem.size) {
      // One updateCard = one undo step (on the cc-questions card it also writes QUESTIONS.md back).
      void ws.updateCard(card.id, { items: (card.items ?? []).map((i) => (byItem.has(i.id) ? { ...i, answer: byItem.get(i.id) } : i)) });
    } else if (card && plain.length) {
      const add = plain.map(({ q, a }) => `**Q:** ${q.question}\n**A:** ${a}`).join("\n\n");
      void ws.updateCard(card.id, { body: `${card.body}${card.body ? "\n\n" : ""}${add}` });
    }
    const text = qs.map((q) => `Q: ${q.question}\nA: ${answers[q.id] ?? "(skipped)"}`).join("\n");
    send(text, { answering: true, question: qs.map((q) => q.question).join("\n") });
  };

  const canAct = !chat.busy && !!ws.active;
  /** The most recent reply: the only one that offers "Retry locally". */
  const lastReplyId = [...chat.messages].reverse().find((m) => m.role === "claude" && !m.kind)?.id;
  const group = contextCard ? "card" : "project";
  const needCard = contextCard ? undefined : { short: "Open a card first", long: "Select a card on the canvas (or a recent one in the thread menu) to open its own thread, then run this." };
  const summarize = () => ws.openHandoff(contextCard ? { kind: "card", id: contextCard.id } : { kind: "project" });
  const actions: ChatAction[] = [
    { id: "grill", label: "/grill-me", desc: "Question this card or the project until it's solid", group, command: "/grill-me", run: () => (contextCard?.kind === "checklist" && openQuestions(contextCard.items) > 0 ? ws.startChecklistGrill(contextCard.id) : send("/grill-me")) },
    { id: "related", label: "/related", desc: "Find and link cards related to this one", group, command: "/related", disabled: needCard, run: () => send("/related") },
    { id: "takes", label: "Give me 3 takes", desc: "Three different directions for this card", group, run: () => send("Give me 3 takes") },
    ...(contextCard
      ? ([
          { id: "expand", label: "/expand", desc: "Develop this card further", group: "card", command: "/expand", run: () => send("/expand") },
          { id: "critique", label: "/critique", desc: "Find weak spots in this card", group: "card", command: "/critique", run: () => send("/critique") },
          { id: "describe", label: "/describe", desc: "Describe the images on this card", group: "card", command: "/describe", run: () => send("/describe") },
        ] satisfies ChatAction[])
      : []),
    ...(contextCard
      ? ([{ id: "build-prompt", label: "Make build prompt", desc: "Turn this card into a task for Claude Code", group: "card", run: () => ws.openTask({ kind: "card", id: contextCard.id }) }] satisfies ChatAction[])
      : []),
    { id: "summarize", label: "Summarize", desc: "Turn the project into design docs for Claude Code", group: "project", run: summarize },
    { id: "org-project", label: "Organize the project", desc: "Claude proposes a tidy-up plan you review", group: "project", command: "/organize", run: () => runOrganize({ scope: "project", instruction: "" }) },
    { id: "org-selection", label: "Organize the selection", desc: "Claude proposes a plan for the selected cards", group: "project", command: "/organize selection", run: () => send("/organize selection") },
  ];
  const byId = (id: string) => actions.find((a) => a.id === id)!;
  const suggestions = (contextCard ? ["grill", "related", "build-prompt"] : ["summarize", "org-project", "grill"]).map(byId);

  // "/" typed first opens the menu filtered by what follows (until Esc, or no item matches).
  const slashQuery = text.startsWith("/") && !text.includes("\n") && text !== slashDismissed ? text.slice(1) : null;
  const slashItems = slashQuery !== null && canAct ? filterActions(actions, slashQuery) : [];
  const slashOpen = !plusOpen && slashItems.length > 0;
  const menuItems = plusOpen ? actions : slashItems;

  const pickAction = (a: ChatAction) => {
    if (a.disabled) {
      setActionNotice(a.disabled.long);
      return;
    }
    if (!canAct) return;
    setPlusOpen(false);
    setActionNotice(null);
    if (slashOpen) setText("");
    a.run();
    inputRef.current?.focus();
  };
  const closeActions = () => {
    setPlusOpen(false);
    setActionNotice(null);
    if (slashOpen) setSlashDismissed(text);
  };

  const ctxTip = chat.context && chat.context.tokens > 0 ? contextTip(chat.context.tokens, chat.context.window, compactTokens) : null;
  const autoHelp = localOn
    ? `Auto: the local model (${localModel}) for chat; Claude for Think, web and Retry with Claude.`
    : tierModels.router
      ? "Auto: a small model for simple actions, the chat model otherwise."
      : "Auto (router off): the chat model.";

  const tabs = (
    <div className="seg panel-view-tabs" role="tablist" aria-label="Right panel">
      <button type="button" role="tab" aria-selected={builds.tab === "chat"} className={"chip" + (builds.tab === "chat" ? " on" : "")} onClick={() => buildRuns.showTab("chat")}>Chat</button>
      <button type="button" role="tab" aria-selected={builds.tab === "build"} className={"chip" + (builds.tab === "build" ? " on" : "")} onClick={() => buildRuns.showTab("build")}>
        Build{building && <span className={"build-tab-dot" + (building.info.asks.length ? " ask" : "")} aria-label={building.info.asks.length ? "waiting for you" : "running"} />}
      </button>
    </div>
  );
  if (builds.tab === "build") {
    return (
      <aside id="chat-panel" className="glass chat" aria-label="Build" data-wheel-boundary="" ref={panelRef}>
        <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize chat panel" title="Drag to resize, double-click to reset" {...panels.resize.right} />
        <header className="chat-head">{tabs}</header>
        <BuildPanel ws={ws} />
      </aside>
    );
  }
  return (
    <aside id="chat-panel" className="glass chat" aria-label="Claude chat" data-wheel-boundary="" ref={panelRef}>
      <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize chat panel" title="Drag to resize, double-click to reset" {...panels.resize.right} />
      <header className="chat-head">
        {tabs}
        <div className="orb small" aria-hidden="true" />
        <span className="chat-title">Claude</span>
        <ThreadMenu
          slug={ws.active}
          cards={ws.data?.cards ?? []}
          card={contextCard}
          pinned={!!pinned}
          onProject={() => (pinned && ws.active ? panels.setPin(ws.active, "project") : ws.setContextCard(null))}
          onCard={(id) => {
            if (pinned && ws.active) panels.setPin(ws.active, id);
            ws.setContextCard(id);
          }}
          onTogglePin={() => ws.active && panels.setPin(ws.active, pinned ? null : thread)}
        />
        <PanelMenu
          onMemory={ws.active && ws.active !== "inbox" ? () => ws.setMemoryOpen(true) : null}
          onModels={() => setShowModels(true)}
          onReset={() => setConfirmReset(true)}
          resetDisabled={chat.busy || chat.messages.length === 0}
          resetTitle={contextCard ? `Clear the chat about "${contextCard.title}"` : "Clear the project chat"}
          info={chat.context && chat.context.tokens > 0 ? <ContextMeter tokens={chat.context.tokens} window={chat.context.window} compactTokens={compactTokens} /> : undefined}
        />
        {ctxTip && chat.context && (
          <div className={"ctx-line" + (ctxTip.warn ? " warn" : "")} title={ctxTip.tip} aria-hidden="true">
            <span style={{ width: `${ctxTip.pct}%` }} />
          </div>
        )}
      </header>
      {showLocal && <LocalSetup onClose={() => setShowLocal(false)} onStatus={setLocalStatus} turnBusy={chat.busy} />}
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
          <>
            <div className="msg claude">
              {contextCard ? `Chat about "${contextCard.title || "Untitled"}". Type / for actions.` : "Project chat. Select a card for its own thread, or type / for actions."}
            </div>
            <div className="suggestions">
              {suggestions.map((a) => (
                <button key={a.id} type="button" className="suggest" disabled={!canAct} title={a.desc} onClick={() => pickAction(a)}>
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}
        {chat.messages.map((m) => (
          <Fragment key={m.id}>
          <ChatBubble
            key={m.id}
            message={m}
            onAnswer={(answers) => answer(m, answers)}
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
            onRetryLocally={m.id === lastReplyId ? () => chat.retryLocally(m.id) : undefined}
            onOpenLocalSetup={() => setShowLocal(true)}
            onCredit={(allow) => chat.answerCredit(m.id, allow)}
            onOpenSettings={() => setShowModels(true)}
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
                const req: OrganizeReq = m.organizeReq ?? { scope: m.organize!.plan.scope, ids: m.organize!.plan.scopeIds ?? undefined, name: m.organize!.plan.scopeName, instruction: user?.text ?? "" };
                // Redo makes the whole plan again (not only the rest of a partial one).
                runOrganize({ ...req, instruction: req.rest ? "" : req.instruction, backend, prior: null, rest: false }, `${req.rest ? "Organize" : user?.text ?? "Organize"} (${backend === "claude" ? "with Claude" : "locally"})`);
              }}
              onRevise={(ask) => runOrganize({ ...planScope(m.organize!.plan), instruction: ask, backend: m.backend ?? null, prior: m.organize!.plan }, `Revise the plan: ${ask}`, reviseText(m.organize!.plan, ask))}
              onFinish={(backend) =>
                runOrganize(
                  { ...planScope(m.organize!.plan), instruction: "", backend, prior: m.organize!.plan, rest: true },
                  backend === "claude" ? "Finish the plan with Claude" : "Retry the rest locally",
                  `/organize: place the ${m.organize!.plan.unplaced?.length ?? 0} unplaced cards into the plan's frames.`,
                )
              }
            />
          )}
          </Fragment>
        ))}
      </ScrollArea>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        {(plusOpen || slashOpen) && (
          <ActionMenu
            actions={menuItems}
            anchor={plusOpen ? plusRef : inputRef}
            fromSlash={!plusOpen}
            active={activeAction}
            setActive={setActiveAction}
            notice={actionNotice}
            onPick={pickAction}
            onClose={closeActions}
          />
        )}
        <textarea
          ref={inputRef}
          className="scroll scroll-y"
          rows={1}
          aria-label="Message Claude"
          aria-activedescendant={slashOpen && slashItems[activeAction] ? `chat-action-${slashItems[activeAction].id}` : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (slashOpen) {
              const n = slashItems.length;
              const cur = slashItems[Math.min(activeAction, n - 1)];
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActiveAction((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeActions();
                return;
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                if (cur.command && !cur.disabled) setText(`${cur.command} `);
                else pickAction(cur);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                pickAction(cur);
                return;
              }
            }
            // Enter sends; Shift+Enter is a newline; never send mid-IME-composition.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder={contextCard ? "Message Claude about this card…" : "Message Claude about this project…"}
          disabled={chat.busy || !ws.active}
        />
        <div className="composer-row">
          <button
            ref={plusRef}
            type="button"
            className="comp-btn"
            aria-label="Actions"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            title="Actions (or type /)"
            disabled={!canAct}
            onClick={() => {
              setActionNotice(null);
              setPlusOpen((o) => !o);
            }}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className={"comp-btn comp-tog" + (web ? " on" : "")}
            aria-pressed={web}
            aria-label="Web access for this message"
            title={web ? `Web on for this message: Claude may search and fetch pages${localOn ? " (this message goes to Claude, not the local model)" : ""}` : "Let Claude search the web for this message"}
            disabled={!canAct}
            onClick={() => setWeb((w) => !w)}
          >
            <IconGlobe />
            {web && <span className="tog-label">Web</span>}
          </button>
          <button
            type="button"
            className={"comp-btn comp-tog" + (think ? " on" : "")}
            aria-pressed={think}
            aria-label="Think harder for this message"
            title={think ? `Think on for this message: ${modelLabel(tierModels.deep)} with extended thinking` : `Think harder for this message (${modelLabel(tierModels.deep)}, thinking on)`}
            disabled={!canAct}
            onClick={() => setThink((v) => !v)}
          >
            <IconBulb />
            {think && <span className="tog-label">Think</span>}
          </button>
          <span className="composer-spacer" />
          <BalanceChip onSettings={() => setShowModels(true)} />
          <ModelChip
            pin={modelPin}
            onPin={setModelPin}
            tierName={tierName}
            autoHelp={autoHelp}
            localOn={localOn}
            localStatus={localStatus}
            localModel={localModel}
            onLocalSetup={() => setShowLocal(true)}
            onModels={() => setShowModels(true)}
          />
          {chat.busy ? (
            <button type="button" className="send" aria-label="Stop" title="Stop" onClick={() => chat.interrupt()}>
              ■
            </button>
          ) : (
            <button type="submit" className="send" aria-label="Send" title="Send (Enter)" disabled={!text.trim() || !ws.active}>
              <IconSend />
            </button>
          )}
        </div>
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
  onRetryLocally,
  onOpenLocalSetup,
  retryDisabled,
  onStop,
  onRetryStalled,
  onCredit,
  onOpenSettings,
}: {
  /** Answer a paused artifact turn's credit confirm. */
  onCredit: (allow: boolean) => void;
  onOpenSettings: () => void;
  onRetry: () => void;
  /** A failed local turn: send it to Claude once. */
  onRetryWithClaude: () => void;
  /** After a restart, on the most recent turn only: send it again on the local model. */
  onRetryLocally?: () => void;
  onOpenLocalSetup: () => void;
  retryDisabled: boolean;
  /** Stop / Retry offered by a stalled live turn. */
  onStop: () => void;
  onRetryStalled: () => void;
  message: ChatMessage;
  onAnswer: (answers: Record<string, string | undefined>) => void;
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
    <>
      {message.localLoading && (
        <div className="model-note" role="status">
          Loading local model…
        </div>
      )}
    <LiveActivity
      steps={message.steps}
      usage={compacting ? message.compactUsage : message.usage}
      startedAt={message.startedAt ?? Date.now()}
      lastEventAt={message.lastEventAt ?? message.startedAt ?? Date.now()}
      writing={!!message.text && !message.quiet}
      onStop={onStop}
      onRetry={onRetryStalled}
    />
    </>
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
  // A turn that still produced something usable (text, a question card, a ghost card, a change)
  // shows a small grey note; the red banner is only for a turn with nothing to show.
  const usable = !!message.text?.trim() || !!message.questions || !!message.organize || !!message.proposals?.length || !!message.steps?.some((s) => s.kind === "tool" && s.status === "done" && USABLE_TOOLS.has(s.tool ?? ""));
  const retryClaude = localFailed && usable ? (
    <StepFailedNote message={message} retryDisabled={retryDisabled} onRetryWithClaude={onRetryWithClaude} />
  ) : localFailed && (
    <div className="chat-failure">
      <div className="chat-failure-line">
        <span>{FALLBACK_TEXT[message.fallback ?? "error"]}</span>
        <button type="button" className="chip" disabled={retryDisabled} onClick={onRetryWithClaude} title="Send this message to Claude once, with a recap of the thread; the next message is local again">
          Retry with Claude
        </button>
      </div>
    </div>
  );
  const badge = message.role === "claude" && !live && !message.failure && <ModelBadge message={message} busy={retryDisabled} onRetryLocally={onRetryLocally} onOpenLocalSetup={onOpenLocalSetup} />;
  const memBusy = message.memoryBusy && (
    <div className="memory-line busy" aria-live="polite">
      <span className="memory-text">
        Updating memory…{message.memoryBusy.input > 0 && <> ↑ {fmtTokens(message.memoryBusy.input)}</>}
      </span>
    </div>
  );
  if (message.kind === "build" && message.build) {
    const u = message.build;
    const jumps = [...u.built, ...u.partial, ...u.in_progress, ...u.new, ...u.blocked];
    return (
      <div className="build-line" role="status">
        <b>{message.text}</b>
        {jumps.length > 0 && (
          <div className="jumps">
            {jumps.map((j) => (
              <button key={j.id} type="button" className="jump" title="Open this card" onClick={() => onOpenCard(j.id, u.slug)}>{j.title || "Untitled"}</button>
            ))}
          </div>
        )}
        {u.warnings.map((w, i) => <span key={i} className="warn">{w}</span>)}
      </div>
    );
  }
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
  if (message.questions) {
    return (
      <>
      {activity}
      <QuestionForm message={message} onSend={onAnswer} />
      {message.creditAsk && <CreditAsk ask={message.creditAsk} live={!!live} onAnswer={onCredit} />}
      {message.spritecookNote && message.role === "claude" && (
        <div className="chat-failure sc-note" role="note">
          <div className="chat-failure-line">
            <span>{message.spritecookNote === "no_key" ? "No SpriteCook key: image steps were skipped. Themes and mockups still work as HTML." : "SpriteCook couldn't be reached: image steps were skipped."}</span>
            <button type="button" className="chip" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>
      )}
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

/** "Generate N more (~X credits)?" under a paused artifact turn. */
const OTHER = "\u0000other";

/**
 * A question form: every question with its chips (recommended first), "Other…" and Skip, sent
 * as one reply. Read-only once sent, showing what was chosen.
 */
function QuestionForm({ message, onSend }: { message: ChatMessage; onSend: (answers: Record<string, string | undefined>) => void }) {
  const qs = message.questions!;
  const done = !!message.answered;
  const [pick, setPick] = useState<Record<string, string | undefined>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const value = (id: string) => (pick[id] === OTHER ? other[id]?.trim() || undefined : pick[id]);
  const ready = qs.every((q) => skip[q.id] || !!value(q.id));
  const submit = () => {
    if (!done && ready) onSend(Object.fromEntries(qs.map((q) => [q.id, skip[q.id] ? undefined : value(q.id)])));
  };
  const choose = (id: string, c: string | undefined) => {
    setPick((p) => ({ ...p, [id]: c }));
    setSkip((s) => ({ ...s, [id]: false }));
  };
  return (
    <div
      className="msg claude question-form"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      {qs.map((q) => {
        const choices = q.recommended ? [q.recommended, ...q.choices.filter((c) => c !== q.recommended)] : q.choices;
        // Sent: the chosen chip, or the Other text; live: this form's picks.
        const chosen = done ? (q.answer && choices.includes(q.answer) ? q.answer : q.answer ? OTHER : undefined) : pick[q.id];
        const skipped = done ? !!q.skipped : !!skip[q.id];
        return (
          <fieldset key={q.id} className={"question" + (skipped ? " skipped" : "")} disabled={done}>
            <legend>{q.question}</legend>
            {q.context && <div className="question-context">{q.context}</div>}
            <div className="chips question-chips" role="radiogroup" aria-label={q.question}>
              {choices.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={chosen === c} className={"chip" + (chosen === c ? " on" : "")} onClick={() => choose(q.id, c)}>
                  {c}
                  {c === q.recommended && <span className="rec-tag">Recommended</span>}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={chosen === OTHER} className={"chip" + (chosen === OTHER ? " on" : "")} onClick={() => choose(q.id, OTHER)}>
                {done && chosen === OTHER ? q.answer : "Other…"}
              </button>
              {!done && (
                <button type="button" className="link-btn question-skip" aria-pressed={skipped} onClick={() => setSkip((s) => ({ ...s, [q.id]: !s[q.id] }))}>
                  {skipped ? "Skipped" : "Skip"}
                </button>
              )}
              {done && skipped && <span className="question-context">Skipped</span>}
            </div>
            {!done && chosen === OTHER && (
              <input
                className="question-other"
                autoFocus
                aria-label="Your answer"
                value={other[q.id] ?? ""}
                onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    choose(q.id, OTHER);
                  }
                }}
              />
            )}
          </fieldset>
        );
      })}
      {!done && (
        <button type="button" className="btn primary question-send" disabled={!ready} onClick={submit} title="Send the answers (Ctrl+Enter)">
          Send
        </button>
      )}
    </div>
  );
}

function CreditAsk({ ask, live, onAnswer }: { ask: NonNullable<ChatMessage["creditAsk"]>; live: boolean; onAnswer: (allow: boolean) => void }) {
  if (ask.answered) {
    return <div className="credit-ask done">{ask.answered === "yes" ? `Allowed ${ask.more} more paid SpriteCook calls.` : "Stopped at the credit cap."}</div>;
  }
  if (!live) return <div className="credit-ask done">Paused at the credit cap ({ask.used} of {ask.cap} paid calls).</div>;
  return (
    <div className="credit-ask" role="group" aria-label="Credit cap reached">
      <span>
        This turn used {ask.used} of {ask.cap} paid SpriteCook calls.
      </span>
      <button type="button" className="btn primary" onClick={() => onAnswer(true)}>
        Generate {ask.more} more{ask.estCredits != null ? ` (~${ask.estCredits} credits)` : ""}?
      </button>
      <button type="button" className="btn" onClick={() => onAnswer(false)}>
        Stop here
      </button>
    </div>
  );
}

/** SpriteCook credits next to the model chip; refreshed after every artifact turn, click to refresh. */
function BalanceChip({ onSettings }: { onSettings: () => void }) {
  const b = useBalance();
  useEffect(() => {
    refreshBalance();
  }, []);
  if (b.error === "no_key") return null;
  const label = b.credits != null ? `${Math.round(b.credits).toLocaleString()} cr` : b.loading ? "…" : "–";
  return (
    <button
      type="button"
      className={"model-chip balance-chip" + (b.error ? " warn" : "")}
      title={b.error ? `SpriteCook balance unavailable: ${b.error}. Click to retry; SpriteCook settings are in Settings.` : "SpriteCook credits. Click to refresh."}
      aria-label={`SpriteCook credits: ${label}`}
      onClick={() => refreshBalance()}
      onContextMenu={(e) => {
        e.preventDefault();
        onSettings();
      }}
    >
      ◈ {label}
    </button>
  );
}

/** Tools whose success is visible output of a turn (see `usable` above). */
const USABLE_TOOLS = new Set(["create_card", "ask_question", "ask_questions", "propose_link", "merge_cards", "propose_edit", "propose_organize", "propose_artifact", "escalate_artifact", "remember", "forget"]);

/** "One step failed · Details", with "Retry with Claude" in a ⋯ menu: the turn's output stands. */
function StepFailedNote({ message, retryDisabled, onRetryWithClaude }: { message: ChatMessage; retryDisabled: boolean; onRetryWithClaude: () => void }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const failed = message.steps?.filter((s) => s.kind === "tool" && s.status === "error") ?? [];
  return (
    <div className="step-failed">
      <div className="step-failed-line">
        <span>One step failed</span>
        <span aria-hidden="true">·</span>
        <button type="button" className="memory-act" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
          Details
        </button>
        <button ref={btn} type="button" className="step-failed-more" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" title="More actions" onClick={() => setOpen((v) => !v)}>
          ⋯
        </button>
      </div>
      {details && (
        <div className="step-failed-details">
          {failed.length ? failed.map((s) => <div key={s.sid}>{s.label || s.tool}{s.detail ? `: ${s.detail}` : ""}</div>) : FALLBACK_TEXT[message.fallback ?? "error"]}
        </div>
      )}
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)} label="Reply actions">
          <button
            type="button"
            role="menuitem"
            className="menu-item cm-item"
            disabled={retryDisabled}
            title="Send this message to Claude once, with a recap of the thread; the next message is local again"
            onClick={() => {
              setOpen(false);
              onRetryWithClaude();
            }}
          >
            <span className="cm-label">Retry with Claude</span>
          </button>
        </Popover>
      )}
    </div>
  );
}

const FALLBACK_TEXT: Record<string, string> = {
  error: "The local model couldn't answer.",
  empty: "The local model gave no answer.",
  tool: "A tool call by the local model failed.",
  vision: "The local model can't look at images.",
  stalled: "The local model stopped responding (it was retried once).",
};

const REASON_TEXT: Record<string, string> = { think: "Think harder", web: "web", retry: "retried with Claude", unavailable: "local model unavailable", size: "large scope" };

/** Under each reply: "local · qwen3.5:35b-a3b" or "Claude · Opus · Think harder · ↑ 12k ↓ 300". */
function ModelBadge({ message: m, busy, onRetryLocally, onOpenLocalSetup }: { message: ChatMessage; busy: boolean; onRetryLocally?: () => void; onOpenLocalSetup: () => void }) {
  const rs = useOllamaRestart();
  const [back, setBack] = useState(false);
  if (!m.backend) return null;
  if (m.backend === "local") {
    return (
      <div className="model-badge local" title={m.model && isCloudModel(m.model) ? "Answered by an Ollama cloud model through Ollama (no Claude usage)" : "Answered by the local model through Ollama (no Claude usage)"}>
        local · {m.model && isCloudModel(m.model) ? `${m.model} (cloud)` : m.model}
      </div>
    );
  }
  const reason = m.routeReason ? REASON_TEXT[m.routeReason] : null;
  return (
    <>
      {m.routeReason === "unavailable" && (
        <div className="model-note" role="note">
          {back ? (
            <>
              Local model is back.{" "}
              {onRetryLocally && (
                <button type="button" className="memory-act" disabled={busy} onClick={onRetryLocally}>
                  Retry locally
                </button>
              )}
            </>
          ) : (
            <>
              Local model unavailable{m.routeNote ? `: ${m.routeNote}` : "."} This reply used Claude.
              {m.routeCanRestart && rs.fails >= 2 ? (
                <>
                  {" "}
                  <button type="button" className="memory-act" onClick={onOpenLocalSetup}>
                    Open Local model settings
                  </button>
                </>
              ) : (
                m.routeCanRestart && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="memory-act"
                      disabled={busy || !!rs.step}
                      title={busy ? "Wait for the reply to finish" : "Stop Ollama, start it again and load the model"}
                      onClick={() => void rs.restart().then((st) => st?.ready && setBack(true))}
                    >
                      {rs.step ? RESTART_LABEL[rs.step] : "Restart"}
                    </button>
                  </>
                )
              )}
              {rs.error && <span role="alert"> {rs.error}</span>}
            </>
          )}
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

/** The context meter's numbers and explanation (header line and the ⋯ menu). */
function contextTip(tokens: number, window: number, compactTokens: number) {
  const warn = compactTokens > 0 && tokens >= compactTokens * 0.8;
  const pct = Math.min(100, (tokens / Math.max(1, window)) * 100);
  const tip =
    `This thread's context: ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens after the last reply.` +
    (compactTokens > 0
      ? ` When a turn's input passes ${compactTokens.toLocaleString()} tokens, Dreamer summarizes the earlier messages and continues in a fresh session (Settings › “Summarize a thread after”).`
      : " Automatic summarizing is off (Settings › “Summarize a thread after” is 0).");
  return { warn, pct, tip };
}

/** "34k / 200k" with a thin bar; amber from 80% of the auto-summary threshold. */
function ContextMeter({ tokens, window, compactTokens }: { tokens: number; window: number; compactTokens: number }) {
  const { warn, pct, tip } = contextTip(tokens, window, compactTokens);
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
/** "Claude Code card skill": installs dreamer-cards into the user's ~/.claude/skills (asks before writing). */
function SkillRow({ onError }: { onError: (e: string) => void }) {
  const [st, setSt] = useState<SkillStatus | null>(null);
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    api.skillStatus().then(setSt).catch(() => setSt(null));
  }, []);
  const run = (f: () => Promise<SkillStatus>) => {
    setAsk(false);
    f().then(setSt).catch((e) => onError(String(e)));
  };
  const state = st?.state;
  return (
    <div className="model-form">
      <div>
        Claude Code card skill{" "}
        <span className="chat-sub">
          {state === "current" ? "installed" : state === "outdated" ? "installed (updates at next start)" : state === "edited" ? "Update available (your edited copy differs)" : state === "missing" ? "not installed" : "needs the desktop app"}
        </span>
      </div>
      <p className="chat-sub">Lets Claude Code write Dreamer cards (a .dreamer.md bundle) when you ask it to log ideas or built features.</p>
      {ask && st && <p className="chat-sub">{state === "edited" ? "This replaces your edited copy at " : "This writes "}<code>{st.path}</code></p>}
      <div className="editor-actions">
        {st && (state === "missing" || state === "edited" || state === "outdated") && (
          <button type="button" className="btn" onClick={() => (ask ? run(api.skillInstall) : setAsk(true))}>
            {ask ? "Confirm" : state === "missing" ? "Install" : "Update"}
          </button>
        )}
        {st && state !== "missing" && (
          <button type="button" className="btn" onClick={() => run(api.skillRemove)}>Remove</button>
        )}
        {ask && <button type="button" className="btn" onClick={() => setAsk(false)}>Not now</button>}
      </div>
    </div>
  );
}

function ModelSettings({ onClose, onError }: { onClose: () => void; onError: (e: string) => void }) {
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [exportModel, setExportModel] = useState("");
  const [buildModel, setBuildModel] = useState("");
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
  const [scUrl, setScUrl] = useState("");
  const [creditCap, setCreditCap] = useState("");
  const [scKey, setScKey] = useState<SpritecookKeyStatus | null>(null);
  const [newKey, setNewKey] = useState("");
  useEffect(() => {
    api.autostartEnabled().then(setAutostart).catch(() => setAutostart(false));
    api.spritecookKeyStatus().then(setScKey).catch(() => setScKey(null));
    api
      .getSettings()
      .then((s) => {
        setStartHidden(s.start_hidden);
        setChatModel(s.model_chat);
        setExportModel(s.model_export);
        setBuildModel(s.build_model);
        setRouter(s.model_router);
        setFastModel(s.model_fast);
        setDeepModel(s.model_deep);
        setMemoryModel(s.model_memory);
        setCompactTokens(String(s.compact_tokens));
        setMemoryCap(String(s.memory_cap));
        setLocalChat(s.local_chat);
        setLocalModel(s.local_model);
        setScUrl(s.spritecook_url);
        setCreditCap(String(s.credit_cap));
      })
      .catch((e) => onError(String(e)));
  }, [onError]);
  const save = async () => {
    try {
      await api.updateSettings({ model_chat: chatModel ?? "", model_router: router, model_fast: fastModel, model_deep: deepModel, model_export: exportModel, build_model: buildModel, model_memory: memoryModel, compact_tokens: Math.max(0, Math.floor(Number(compactTokens)) || 0), memory_cap: Math.max(0, Math.floor(Number(memoryCap)) || 0), local_chat: localChat, local_model: localModel, spritecook_url: scUrl, credit_cap: Math.max(0, Math.floor(Number(creditCap)) || 0) });
      if (newKey.trim()) await api.spritecookSetKey(newKey.trim());
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
          Build runs (Claude Code in the repo; Claude only)
          <input className="name-input" list="claude-models" value={buildModel} disabled={chatModel === null} placeholder="sonnet" onChange={(e) => setBuildModel(e.target.value)} />
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
        <h4 className="settings-sub" id="integrations-settings">Integrations</h4>
        <SkillRow onError={onError} />
        <h4 className="settings-sub" id="spritecook-settings">SpriteCook (artifact images)</h4>
        <label>
          API key {scKey?.hasKey ? <span className="chat-sub">saved: {scKey.masked}</span> : <span className="chat-sub">not set: themes and mockups still work, images don't</span>}
          <input className="name-input" type="password" autoComplete="off" value={newKey} placeholder={scKey?.hasKey ? "Paste a new key to replace it" : "sc_live_…"} onChange={(e) => setNewKey(e.target.value)} />
        </label>
        {scKey?.hasKey && (
          <button
            type="button"
            className="btn"
            onClick={() => api.spritecookSetKey("").then(setScKey).catch((er) => onError(String(er)))}
          >
            Remove saved key
          </button>
        )}
        <label>
          Server URL
          <input className="name-input" value={scUrl} disabled={chatModel === null} placeholder="https://api.spritecook.ai/mcp/" onChange={(e) => setScUrl(e.target.value)} />
        </label>
        <label>
          Paid SpriteCook calls per artifact turn before asking
          <input className="name-input" inputMode="numeric" value={creditCap} disabled={chatModel === null} placeholder="4" onChange={(e) => setCreditCap(e.target.value)} />
        </label>
        <p className="chat-sub">The key is kept in the Windows credential store, never in the workspace.</p>
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

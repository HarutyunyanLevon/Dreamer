import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Card, type OrganizePlanData, type ProjectData } from "../../api";
import { openQuestions } from "../kinds";
import { isImage } from "../Attachments";
import { NO_MEMORY, VERBS, selectionBlock } from "../verbs";
import { useClaudeChat, type ChatMessage } from "../../state/useClaudeChat";
import { type Workspace } from "../../state/workspace";
import { ClaudeSetup, needsSetup } from "../ClaudeSetup";
import { IconBulb, IconClip as IconGlobe, IconPlus, IconSend } from "../Icons";
import { type usePanels } from "../../state/usePanels";
import { ScrollArea } from "../../ui/Scroll";
import { Modal } from "../../ui/Modal";
import { modelLabel } from "../Activity";
import { type ModelTier } from "../../api/claude";
import { ThreadMenu } from "./ThreadMenu";
import { PanelMenu } from "./PanelMenu";
import { ModelChip } from "./ModelChip";
import { ActionMenu, filterActions, type ChatAction } from "./ActionMenu";
import { OrganizePlanCard, reviseText } from "../OrganizePlan";
import { type OrganizeReq } from "../../state/useClaudeChat";
import { cardRect } from "../cardGeometry";
import { centerInside } from "../Frames";
import { ChatBubble } from "./MessageView";
import { BalanceChip, ContextMeter, ModelSettings, contextTip } from "./Status";

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


/**
 * The selected card's details for this turn. The project overview (every card's title, tags and
 * stage) is added by Rust on every turn, so it isn't repeated here.
 */
function formatContext(card: Card | null, sel: Card[] = []): string | undefined {
  if (sel.length > 1) return selectionBlock(sel);
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
function expand(display: string, card: Card | null, sel: Card[] = []): { text: string; quiet: boolean } {
  const many = sel.length > 1;
  const subject = many ? `the selection (ids ${sel.map((c) => c.id).join(", ")}), as ONE idea` : card ? `"${card.title}" (id ${card.id})` : null;
  const ids = many ? sel.map((c) => c.id) : card ? [card.id] : [];
  let text = display;
  if (subject) {
    if (display === "Give me 3 takes") {
      const group = crypto.randomUUID();
      text = `Give me 3 distinctly different takes branching from ${subject}. Call create_card exactly 3 times (not more, not fewer); on every one of the 3 calls set branch_group to exactly "${group}", variant_of to "${ids[0]}" and linked_from to every source card, so they can be grouped and compared.`;
    } else if (display === "/related") {
      text = `/related: find cards related to ${subject} in this project and propose the strongest links from it with propose_link (from each of ${ids.map((i) => `"${i}"`).join(", ")}). Don't create cards.`;
    } else if (["/expand", "/critique", "/describe", "/what-if", "/references", "/grill-me"].includes(display)) {
      text = `${display}: ${display.slice(1)} ${subject}.`;
    }
  }
  return { text, quiet: display === "/grill-me" || display === "/grill-project" };
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
    // A chat turn asked for a visual: Claude makes it in a new artifact card, with
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
  const loadTierModels = useCallback(() => {
    api
      .getSettings()
      .then((s) => {
        setTierModels({ fast: s.model_fast, main: s.model_chat, deep: s.model_deep, router: s.model_router });
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
  /** A pinned tier's name. */
  const tierName = (t: ModelTier) => modelLabel(tierModels[t]) ?? t;
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
  /** The canvas selection when it is 2+ cards (one idea for Claude); otherwise empty. */
  const selectedCards = (): Card[] => {
    const ids = ws.getCanvasSelection();
    return ids.length > 1 ? ids.map((id) => ws.data?.cards.find((c) => c.id === id)).filter((c): c is Card => !!c) : [];
  };

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
        const sel = selectedCards();
        const x = req.display ? { text: req.text, quiet: !!req.quiet } : expand(req.text, contextCard, sel);
        chat.sendText(x.text, formatContext(contextCard, sel), req.display ?? req.text, { quiet: x.quiet, selection: ws.getCanvasSelection(), memory: !NO_MEMORY.test(req.display ?? req.text) });
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
    const sel = selectedCards();
    const x = expand(display, contextCard, sel);
    // Answering a question Claude asked (e.g. /grill-me) keeps the Think of the message that started it.
    const thinkNow = opts?.answering ? think || lastThink.current : think;
    if (!opts?.answering) lastThink.current = think;
    chat.sendText(x.text, formatContext(contextCard, sel), display, { quiet: x.quiet || !!opts?.answering, web, think: thinkNow, pin: modelPin, selection: ws.getCanvasSelection(), memory: !!opts?.answering || !NO_MEMORY.test(display), question: opts?.question });
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

  /** A sent question form: one reply message, and each answer recorded where its question points. */
  const answer = (m: ChatMessage, answers: Record<string, string | undefined>) => {
    const qs = m.questions ?? [];
    chat.answerQuestions(m.id, answers);
    const got = qs.flatMap((q) => (answers[q.id] ? [{ q, a: answers[q.id]! }] : []));
    const card = contextCard && ws.data?.cards.find((c) => c.id === contextCard.id);
    const byItem = new Map(got.flatMap(({ q, a }) => (q.itemId ? [[q.itemId, a] as const] : [])));
    const plain = got.filter(({ q }) => !q.itemId);
    if (card && byItem.size) {
      // One updateCard = one undo step.
      void ws.updateCard(card.id, { items: (card.items ?? []).map((i) => (byItem.has(i.id) ? { ...i, answer: byItem.get(i.id) } : i)) });
    } else if (card && plain.length) {
      const add = plain.map(({ q, a }) => `**Q:** ${q.question}\n**A:** ${a}`).join("\n\n");
      void ws.updateCard(card.id, { body: `${card.body}${card.body ? "\n\n" : ""}${add}` });
    }
    const text = qs.map((q) => `Q: ${q.question}\nA: ${answers[q.id] ?? "(skipped)"}`).join("\n");
    send(text, { answering: true, question: qs.map((q) => q.question).join("\n") });
  };

  const canAct = !chat.busy && !!ws.active;
  const subjectCards = selectedCards().length ? selectedCards() : contextCard ? [contextCard] : [];
  const subject = subjectCards.length > 0;
  const summarize = () => ws.openHandoff(contextCard ? { kind: "card", id: contextCard.id } : { kind: "project" });
  const actions: ChatAction[] = [
    ...(subject
      ? VERBS.flatMap((g) => g.items.map((v): ChatAction => {
          const noImg = v.needsImages && !subjectCards.some((c) => c.attachments.some(isImage));
          return {
            id: v.cmd,
            label: v.label,
            desc: `${g.group}: ${v.desc}`,
            group: "card",
            command: v.cmd.startsWith("/") ? v.cmd : undefined,
            disabled: noImg ? { short: "No images", long: "There are no images here." } : undefined,
            run: () => (v.cmd === "/grill-me" && contextCard?.kind === "checklist" && openQuestions(contextCard.items) > 0 ? ws.startChecklistGrill(contextCard.id) : send(v.cmd)),
          };
        }))
      : [{ id: "grill-project", label: "Grill the project", desc: "Project-wide questions: player, platform, scope, tone", group: "project", command: "/grill-project", run: () => send("/grill-project") } satisfies ChatAction]),
    { id: "summarize", label: "Summarize", desc: "Turn the project into design docs for Claude Code", group: "project", run: summarize },
    { id: "org-project", label: "Organize the project", desc: "Claude proposes a tidy-up plan you review", group: "project", command: "/organize", run: () => runOrganize({ scope: "project", instruction: "" }) },
    { id: "org-selection", label: "Organize the selection", desc: "Claude proposes a plan for the selected cards", group: "project", command: "/organize selection", run: () => send("/organize selection") },
  ];
  const byId = (id: string) => actions.find((a) => a.id === id)!;
  const suggestions = (contextCard ? ["grill", "related", "summarize"] : ["summarize", "org-project", "grill"]).map(byId);

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
  const autoHelp = tierModels.router ? "Auto: a small model for simple actions, the chat model otherwise." : "Auto (router off): the chat model.";

  return (
    <aside id="chat-panel" className="glass chat" aria-label="Claude chat" data-wheel-boundary="" ref={panelRef}>
      <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize chat panel" title="Drag to resize, double-click to reset" {...panels.resize.right} />
      <header className="chat-head">
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
              onRedo={() => {
                const user = chat.messages.find((x) => x.id === `${m.id}-u`);
                const req: OrganizeReq = m.organizeReq ?? { scope: m.organize!.plan.scope, ids: m.organize!.plan.scopeIds ?? undefined, name: m.organize!.plan.scopeName, instruction: user?.text ?? "" };
                // Redo makes the whole plan again (not only the rest of a partial one).
                runOrganize({ ...req, instruction: req.rest ? "" : req.instruction, prior: null, rest: false }, req.rest ? "Organize" : user?.text ?? "Organize");
              }}
              onRevise={(ask) => runOrganize({ ...planScope(m.organize!.plan), instruction: ask, prior: m.organize!.plan }, `Revise the plan: ${ask}`, reviseText(m.organize!.plan, ask))}
              onFinish={() =>
                runOrganize(
                  { ...planScope(m.organize!.plan), instruction: "", prior: m.organize!.plan, rest: true },
                  "Finish the plan",
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
            title={web ? `Web on for this message: Claude may search and fetch pages` : "Let Claude search the web for this message"}
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

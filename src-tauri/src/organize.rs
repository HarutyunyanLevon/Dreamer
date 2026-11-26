//! Organize: the read-only `list_tree` tool, the `propose_organize` validator and the
//! deterministic layout the organize pipeline (organize_pipeline.rs) uses.
//!
//! A plan works on its scope (the project, a frame's cards or the selection) with frames, layout
//! and tags. Nothing here writes. A plan is checked against the project as it is now (ids exist,
//! cards are in scope, pinned positions respected), and either
//! rejected as a whole (every bad op listed, so the model can fix the plan) or handed back
//! normalized for the UI, which previews it and applies the checked ops as one undo step.

use crate::error::{AppError, Result};
use crate::model::ProjectData;
use crate::state::AppState;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_OPS: usize = 300;
const MAX_TITLE: usize = 80;
const LAYOUTS: &[&str] = &["grid", "cluster-by-tag", "flow-by-links", "stage-columns"];
const FOLDER_OPS_MSG: &str = "there are no folders: organize with frames, layout (arrange / place) and tags";

/// What an organize run works on: "project" (every card), "frame" (a frame's cards) or
/// "selection"; `ids` = the cards in scope (None = all).
#[derive(Clone, Debug, Default)]
pub struct Scope {
    pub kind: String,
    pub name: String,
    pub ids: Option<BTreeSet<String>>,
}

impl Scope {
    pub fn new(kind: Option<&str>, name: Option<String>, ids: Option<Vec<String>>) -> Scope {
        let kind = match kind {
            Some(k @ ("frame" | "selection")) if ids.is_some() => k.to_string(),
            _ => return Scope { kind: "project".into(), ..Default::default() },
        };
        Scope { name: name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| if kind == "frame" { "the frame".into() } else { "the selection".into() }), kind, ids: ids.map(|v| v.into_iter().collect()) }
    }
    pub fn has(&self, id: &str) -> bool {
        self.ids.as_ref().is_none_or(|s| s.contains(id))
    }
}

struct World {
    p: ProjectData,
    scope: Scope,
}

fn load(state: &AppState, slug: &str, scope: &Scope) -> Result<World> {
    let p = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.load_project(slug)?;
    Ok(World { p, scope: scope.clone() })
}

impl World {
    fn scope_name(&self) -> String {
        if self.scope.kind == "project" { self.p.meta.name.clone() } else { self.scope.name.clone() }
    }
    /// Live (not ghost) cards in scope.
    fn live_cards(&self) -> BTreeMap<&str, &crate::model::Card> {
        self.p.cards.iter().filter(|c| !c.meta.ghost && self.scope.has(&c.meta.id)).map(|c| (c.meta.id.as_str(), c)).collect()
    }
}

/// Compact text: the canvas frames and the in-scope cards with ids, titles, tags, stage, place, flags.
pub fn list_tree(state: &AppState, slug: &str, scope: &Scope, _input: &Value) -> Result<Value> {
    let w = load(state, slug, scope)?;
    let live = w.live_cards();
    let c = &w.p.canvas;
    let n = c.cards.keys().filter(|id| live.contains_key(id.as_str())).count();
    let mut out = format!(
        "Scope: {} \"{}\" · {n} cards. Organize with frames, layout and tags. Pinned cards keep their position.",
        w.scope.kind,
        w.scope_name()
    );
    out.push_str("\n\nFrames (id · title · x,y wxh):");
    for (id, f) in &c.frames {
        out.push_str(&format!("\n- {id} · \"{}\" · {},{} {}x{}", f.title.trim(), f.x.round(), f.y.round(), f.w.round(), f.h.round()));
    }
    out.push_str("\n\nCards (id · title · stage · tags · x,y · frame · flags · links):");
    let mut frames: Vec<(&String, &crate::model::Frame)> = c.frames.iter().collect();
    frames.sort_by_key(|f| std::cmp::Reverse(f.1.z));
    for (id, p) in &c.cards {
        let Some(card) = live.get(id.as_str()) else { continue };
        let (cx, cy) = (p.x + p.w.unwrap_or(236.0) / 2.0, p.y + p.h.unwrap_or(150.0) / 2.0);
        let frame = frames.iter().find(|(_, f)| cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h).map(|(fid, _)| fid.as_str()).unwrap_or("-");
        let stage = serde_json::to_value(card.meta.stage).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        let tags = if card.meta.tags.is_empty() { "-".to_string() } else { card.meta.tags.join(",") };
        let links: Vec<&str> = card.meta.links.iter().map(|l| l.to.as_str()).collect();
        out.push_str(&format!(
            "\n- {id} · \"{}\" · {stage} · {tags} · {},{} · {frame}{}{}",
            card.meta.title.trim(),
            p.x.round(),
            p.y.round(),
            if p.pinned { " · pinned" } else { "" },
            if links.is_empty() { String::new() } else { format!(" · links {}", links.join(",")) }
        ));
    }
    Ok(Value::String(crate::ctx::cap_chars(&out, 30_000)))
}

fn str_list(v: Option<&Value>) -> std::result::Result<Vec<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(|s| s.trim().to_string()).ok_or_else(|| "expected a list of strings".to_string())).collect(),
        Some(_) => Err("expected a list of strings".into()),
    }
}

fn title_of(op: &Value) -> std::result::Result<String, String> {
    let t = op.get("title").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if t.is_empty() {
        return Err("needs a title".into());
    }
    Ok(t.chars().take(MAX_TITLE).collect())
}

/// Checks a whole plan. Err: every problem, for the model to fix. Ok: the normalized plan for the UI.
/// Extra keys of `input` (the pipeline's "pipeline" / "unplaced") are passed through.
pub fn propose_organize(state: &AppState, slug: &str, scope: &Scope, input: &Value) -> Result<Value> {
    let w = load(state, slug, scope)?;
    let canvas = &w.p.canvas;
    let live = w.live_cards();
    let rationale = input.get("rationale").and_then(Value::as_str).map(str::trim).unwrap_or_default().chars().take(1200).collect::<String>();
    let ops = input.get("ops").and_then(Value::as_array).cloned().unwrap_or_default();
    let on_canvas = |id: &str| canvas.cards.contains_key(id) && live.contains_key(id);
    let pinned: BTreeSet<String> = canvas.cards.iter().filter(|(_, p)| p.pinned).map(|(id, _)| id.clone()).collect();
    let mut frames: BTreeSet<String> = canvas.frames.keys().cloned().collect();

    let mut errors: Vec<String> = Vec::new();
    if ops.is_empty() {
        errors.push("the plan has no ops".into());
    }
    if ops.len() > MAX_OPS {
        errors.push(format!("at most {MAX_OPS} ops per plan"));
    }
    if rationale.is_empty() {
        errors.push("add a one-paragraph rationale".into());
    }
    let mut kept: BTreeSet<String> = BTreeSet::new();
    let mut out_ops: Vec<Value> = Vec::new();
    let mut referenced: BTreeSet<String> = BTreeSet::new();

    for (i, op) in ops.iter().take(MAX_OPS).enumerate() {
        let kind = op.get("op").and_then(Value::as_str).unwrap_or_default();
        let mut bad = |m: String| errors.push(format!("op {} ({}): {m}", i + 1, if kind.is_empty() { "?" } else { kind }));
        let mut o = Map::new();
        o.insert("op".into(), json!(kind));
        match kind {
            "create_folder" | "move" => bad(FOLDER_OPS_MSG.into()),
            "rename" => {
                let id = op.get("id").and_then(Value::as_str).unwrap_or_default();
                let title = match title_of(op) {
                    Ok(t) => t,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                if live.contains_key(id) {
                    bad("cards are never renamed by a plan (that would edit card text); rename frames only".into());
                    continue;
                }
                if !frames.contains(id) {
                    bad(format!("unknown frame {id:?}"));
                    continue;
                }
                o.insert("id".into(), json!(id));
                o.insert("title".into(), json!(title));
                referenced.insert(id.to_string());
            }
            "create_frame" => {
                let t = op.get("tempId").and_then(Value::as_str).map(str::trim).unwrap_or_default();
                if t.is_empty() || t == "root" || t.len() > 40 || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                    bad("needs a tempId (letters, digits, - or _), e.g. \"new-combat\"".into());
                    continue;
                }
                if frames.contains(t) || w.p.cards.iter().any(|c| c.meta.id == t) {
                    bad(format!("tempId {t:?} is already used"));
                    continue;
                }
                let title = match title_of(op) {
                    Ok(t) => t,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                let r = op.get("rect");
                let n = |k: &str| r.and_then(|r| r.get(k)).and_then(Value::as_f64).filter(|n| n.is_finite());
                let (Some(x), Some(y), Some(fw), Some(fh)) = (n("x"), n("y"), n("w"), n("h")) else {
                    bad("needs rect {x, y, w, h}".into());
                    continue;
                };
                if !(crate::model::MIN_FRAME_SIDE..=crate::model::MAX_FRAME_SIDE).contains(&fw) || !(crate::model::MIN_FRAME_SIDE..=crate::model::MAX_FRAME_SIDE).contains(&fh) {
                    bad(format!("frame sides must be {}..{}", crate::model::MIN_FRAME_SIDE, crate::model::MAX_FRAME_SIDE));
                    continue;
                }
                frames.insert(t.to_string());
                o.insert("tempId".into(), json!(t));
                o.insert("title".into(), json!(title));
                o.insert("rect".into(), json!({ "x": x.round(), "y": y.round(), "w": fw.round(), "h": fh.round() }));
                if let Some(c) = op.get("color").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) {
                    o.insert("color".into(), json!(c.trim()));
                }
            }
            "arrange" => {
                let layout = op.get("layout").and_then(Value::as_str).unwrap_or_default();
                if !LAYOUTS.contains(&layout) {
                    bad(format!("layout must be one of {}", LAYOUTS.join(", ")));
                    continue;
                }
                let ids = match str_list(op.get("ids")) {
                    Ok(v) => v,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                let mut take: Vec<String> = Vec::new();
                for id in ids {
                    if take.contains(&id) {
                        continue;
                    }
                    if !on_canvas(&id) {
                        bad(format!("card {id:?} is not in scope"));
                        continue;
                    }
                    // A pinned card never changes position.
                    if pinned.contains(&id) {
                        kept.insert(id);
                        continue;
                    }
                    referenced.insert(id.clone());
                    take.push(id);
                }
                if take.len() < 2 {
                    if take.is_empty() && kept.is_empty() {
                        bad("needs the ids of at least 2 cards in scope".into());
                    }
                    continue;
                }
                o.insert("ids".into(), json!(take));
                o.insert("layout".into(), json!(layout));
            }
            "place" => {
                let Some(pos) = op.get("positions").and_then(Value::as_object) else {
                    bad("needs positions {card id: {x, y}}".into());
                    continue;
                };
                let mut out = Map::new();
                for (id, p) in pos {
                    if !on_canvas(id) {
                        bad(format!("card {id:?} is not in scope"));
                        continue;
                    }
                    if pinned.contains(id) {
                        kept.insert(id.clone());
                        continue;
                    }
                    let n = |k: &str| p.get(k).and_then(Value::as_f64).filter(|n| n.is_finite() && n.abs() < 1e6);
                    let (Some(x), Some(y)) = (n("x"), n("y")) else {
                        bad(format!("card {id}: needs numeric x and y"));
                        continue;
                    };
                    out.insert(id.clone(), json!({ "x": x.round(), "y": y.round() }));
                    referenced.insert(id.clone());
                }
                if out.is_empty() {
                    continue;
                }
                o.insert("positions".into(), Value::Object(out));
            }
            "retag" => {
                let id = op.get("id").and_then(Value::as_str).unwrap_or_default();
                let Some(card) = live.get(id) else {
                    bad(format!("unknown card {id:?}"));
                    continue;
                };
                if !canvas.cards.contains_key(id) {
                    bad(format!("card {id:?} is not in scope"));
                    continue;
                }
                let (add, remove) = match (str_list(op.get("add")), str_list(op.get("remove"))) {
                    (Ok(a), Ok(r)) => (a, r),
                    (Err(e), _) | (_, Err(e)) => {
                        bad(e);
                        continue;
                    }
                };
                let mut add: Vec<String> = add.into_iter().filter(|t| !t.is_empty() && t.chars().count() <= 40 && !card.meta.tags.contains(t)).collect();
                add.dedup();
                let remove: Vec<String> = remove.into_iter().filter(|t| card.meta.tags.contains(t)).collect();
                if add.is_empty() && remove.is_empty() {
                    continue;
                }
                o.insert("id".into(), json!(id));
                o.insert("add".into(), json!(add));
                o.insert("remove".into(), json!(remove));
                referenced.insert(id.to_string());
            }
            "" => bad("missing \"op\"".into()),
            other => bad(format!("unknown op {other:?}; use create_frame, rename (frames), arrange, place or retag (plans never delete, edit card text or move cards out of scope)")),
        }
        if o.len() > 1 {
            out_ops.push(Value::Object(o));
        }
    }
    if !errors.is_empty() {
        return Err(AppError::Invalid(format!(
            "The plan was NOT shown to the user. Fix these ops and call propose_organize again with the whole corrected plan:\n- {}",
            errors.join("\n- ")
        )));
    }
    if out_ops.is_empty() {
        return Err(AppError::Invalid(if kept.is_empty() {
            "Nothing in this plan would change anything (it was NOT shown). Propose real changes, or tell the user the canvas is already organized.".into()
        } else {
            "Every op only touched pinned cards, which keep their place (the plan was NOT shown). Leave pinned cards out.".into()
        }));
    }
    let mut titles = Map::new();
    for id in referenced.iter().chain(kept.iter()) {
        let t = if let Some(c) = live.get(id.as_str()) {
            if c.meta.title.trim().is_empty() { "Untitled".to_string() } else { c.meta.title.trim().to_string() }
        } else if let Some(f) = canvas.frames.get(id) {
            if f.title.trim().is_empty() { "Untitled frame".into() } else { f.title.trim().to_string() }
        } else {
            continue;
        };
        titles.insert(id.clone(), json!(t));
    }
    let kept: Vec<Value> = kept.iter().map(|id| json!({ "id": id, "title": titles.get(id).cloned().unwrap_or(json!(id)) })).collect();
    let mut plan = json!({
        "slug": slug,
        "scope": w.scope.kind,
        "scopeIds": w.scope.ids,
        "scopeName": w.scope_name(),
        "rationale": rationale,
        "ops": out_ops,
        "kept": kept,
        "titles": titles,
    });
    for k in ["pipeline", "unplaced", "partial"] {
        if let Some(v) = input.get(k) {
            plan[k] = v.clone();
        }
    }
    Ok(plan)
}

// ---------------------------------------------------------------------------------------------
// Deterministic layout (the organize pipeline; the model never places cards)
// ---------------------------------------------------------------------------------------------

/// Default card width (mirrors CARD_W in src/components/cardGeometry.ts).
pub const CARD_W: f64 = 236.0;
const GAP: f64 = 40.0;
const FRAME_PAD: f64 = 40.0;
const FRAME_HEADER: f64 = 56.0;
const FRAME_GAP: f64 = 120.0;
/// Frames are packed in rows up to about this wide.
const ROW_MAX_W: f64 = 3600.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn hits(&self, o: &Rect) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
    fn grown(&self, m: f64) -> Rect {
        Rect { x: self.x - m, y: self.y - m, w: self.w + 2.0 * m, h: self.h + 2.0 * m }
    }
}

/// How tall a card without a fixed height renders, roughly (title, tags, up to 18 body lines,
/// images). Generous on purpose: the layout must never overlap.
pub fn estimate_card_h(card: &crate::model::Card, w: f64) -> f64 {
    let per_line = ((w - 32.0) / 8.6).max(10.0);
    let title_lines = (card.meta.title.chars().count() as f64 / (per_line * 0.75)).ceil().clamp(1.0, 3.0);
    let body: String = card.body.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let body_lines: f64 = body.split('\n').map(|l| (l.chars().count() as f64 / per_line).ceil().max(if l.trim().is_empty() { 0.4 } else { 1.0 })).sum::<f64>().min(18.0);
    let images = card.meta.attachments.iter().filter(|a| matches!(a, crate::model::Attachment::Image { .. })).count() + usize::from(card.meta.fields.contains_key("image"));
    let items = card.meta.items.len().min(12) as f64;
    30.0 + title_lines * 26.0 + if card.meta.tags.is_empty() { 0.0 } else { 30.0 } + body_lines * 22.5 + items * 26.0 + (images.min(2) as f64) * 170.0 + 20.0
}

/// A card to place: its size (fixed or estimated).
#[derive(Clone, Debug)]
pub struct CardBox {
    pub id: String,
    pub w: f64,
    pub h: f64,
}

/// Frames sized to their cards, cards in a grid inside each, frames packed in rows from `origin`,
/// never on top of an obstacle (pinned cards, existing frames). Returns each group's frame rect and
/// every card's top-left position. `loose`: cards to lay out below the frames, without a frame.
pub fn layout(groups: &[Vec<CardBox>], loose: &[CardBox], obstacles: &[Rect], origin: (f64, f64)) -> (Vec<Rect>, BTreeMap<String, (f64, f64)>) {
    let mut frames: Vec<Rect> = Vec::new();
    let mut pos: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let (ox, oy) = origin;
    let (mut x, mut y, mut row_h) = (ox, oy, 0.0f64);
    let blocked = |r: &Rect, placed: &[Rect]| obstacles.iter().chain(placed.iter()).any(|o| r.hits(&o.grown(GAP)));
    for g in groups {
        let n = g.len().max(1);
        let cols = if n <= 3 { n } else { ((n as f64).sqrt().ceil() as usize).min(4) };
        let cell_w = g.iter().map(|c| c.w).fold(CARD_W, f64::max) + GAP;
        let rows: Vec<&[CardBox]> = g.chunks(cols).collect();
        let row_hs: Vec<f64> = rows.iter().map(|r| r.iter().map(|c| c.h).fold(0.0, f64::max) + GAP).collect();
        let fw = (cols as f64 * cell_w - GAP + 2.0 * FRAME_PAD).max(crate::model::MIN_FRAME_SIDE);
        let fh = (FRAME_HEADER + row_hs.iter().sum::<f64>() - GAP + 2.0 * FRAME_PAD).max(crate::model::MIN_FRAME_SIDE);
        // Next free spot in reading order.
        let mut r;
        let mut guard = 0;
        loop {
            if x > ox && x + fw > ox + ROW_MAX_W {
                x = ox;
                y += row_h + FRAME_GAP;
                row_h = 0.0;
            }
            r = Rect { x, y, w: fw, h: fh };
            guard += 1;
            if !blocked(&r, &frames) || guard > 400 {
                break;
            }
            // Step past whatever is in the way.
            let past = obstacles.iter().chain(frames.iter()).filter(|o| r.hits(&o.grown(GAP))).map(|o| o.x + o.w + FRAME_GAP).fold(x + 80.0, f64::max);
            x = past;
        }
        frames.push(r);
        let mut cy = r.y + FRAME_PAD + FRAME_HEADER;
        for (ri, row) in rows.iter().enumerate() {
            for (ci, c) in row.iter().enumerate() {
                pos.insert(c.id.clone(), ((r.x + FRAME_PAD + ci as f64 * cell_w).round(), cy.round()));
            }
            cy += row_hs[ri];
        }
        x = r.x + fw + FRAME_GAP;
        row_h = row_h.max(fh);
    }
    // Loose cards: rows below everything placed so far, clear of obstacles.
    if !loose.is_empty() {
        let bottom = frames.iter().chain(obstacles.iter()).map(|r| r.y + r.h).fold(oy, f64::max);
        let (mut lx, mut ly, mut lh) = (ox, if frames.is_empty() { oy } else { bottom + FRAME_GAP }, 0.0f64);
        let mut placed: Vec<Rect> = frames.clone();
        for c in loose {
            loop {
                if lx > ox && lx + c.w > ox + ROW_MAX_W {
                    lx = ox;
                    ly += lh + GAP;
                    lh = 0.0;
                }
                let r = Rect { x: lx, y: ly, w: c.w, h: c.h };
                if obstacles.iter().chain(placed.iter()).any(|o| r.hits(o)) {
                    lx += CARD_W + GAP;
                    continue;
                }
                pos.insert(c.id.clone(), (lx.round(), ly.round()));
                placed.push(r);
                lx += c.w + GAP;
                lh = lh.max(c.h);
                break;
            }
        }
    }
    (frames, pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_keeps_plans_to_their_cards() {
        // A frame or selection without ids never widens silently: it is the whole project.
        let s = Scope::new(Some("frame"), Some("Combat".into()), None);
        assert_eq!(s.kind, "project");
        assert!(s.has("anything"));
        let s = Scope::new(Some("frame"), Some("Combat".into()), Some(vec!["a".into()]));
        assert_eq!((s.kind.as_str(), s.name.as_str()), ("frame", "Combat"));
        assert!(s.has("a") && !s.has("b"));
        let s = Scope::new(Some("selection"), None, Some(vec![]));
        assert_eq!(s.name, "the selection");
        assert!(!s.has("a"), "an empty selection touches nothing");
        assert_eq!(Scope::new(Some("bogus"), None, Some(vec!["a".into()])).kind, "project");
    }

    fn b(id: &str, h: f64) -> CardBox {
        CardBox { id: id.into(), w: CARD_W, h }
    }

    #[test]
    fn layout_never_overlaps_and_avoids_obstacles() {
        let groups: Vec<Vec<CardBox>> = (0..6).map(|g| (0..(g + 2)).map(|i| b(&format!("g{g}c{i}"), 150.0 + (i as f64) * 60.0)).collect()).collect();
        let loose = vec![b("l1", 200.0), b("l2", 500.0)];
        let obstacles = vec![Rect { x: 300.0, y: 100.0, w: 236.0, h: 300.0 }];
        let (frames, pos) = layout(&groups, &loose, &obstacles, (0.0, 0.0));
        assert_eq!(frames.len(), 6);
        let all: Vec<&CardBox> = groups.iter().flatten().chain(loose.iter()).collect();
        assert_eq!(pos.len(), all.len());
        let rects: Vec<Rect> = all.iter().map(|c| Rect { x: pos[&c.id].0, y: pos[&c.id].1, w: c.w, h: c.h }).collect();
        for i in 0..rects.len() {
            assert!(!rects[i].hits(&obstacles[0]), "card on a pinned card");
            for j in i + 1..rects.len() {
                assert!(!rects[i].hits(&rects[j]), "cards {i} and {j} overlap");
            }
        }
        for (i, f) in frames.iter().enumerate() {
            assert!(!f.hits(&obstacles[0]), "frame {i} on a pinned card");
            for g in &frames[i + 1..] {
                assert!(!f.hits(g), "frames overlap");
            }
            // Every card of a group sits inside its frame.
            for c in &groups[i] {
                let (x, y) = pos[&c.id];
                assert!(x >= f.x && y >= f.y && x + c.w <= f.x + f.w && y + c.h <= f.y + f.h, "card outside its frame");
            }
        }
    }

    #[test]
    fn card_height_estimate_grows_with_content() {
        let mut c = crate::model::Card { meta: serde_yaml::from_str("id: 01J0000000000000000000000A\ntitle: Short\n").unwrap(), body: String::new() };
        let small = estimate_card_h(&c, CARD_W);
        c.body = "word ".repeat(400);
        let big = estimate_card_h(&c, CARD_W);
        assert!(small >= 80.0 && big > small && big < 700.0, "{small} {big}");
    }
}

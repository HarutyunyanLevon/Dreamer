//! "Let Claude organize": the read-only `list_tree` tool and the `propose_organize` validator.
//!
//! Nothing here writes. A plan is checked against the project as it is now (ids exist, no folder
//! into itself, pinned positions respected), simulated op by op, and either rejected as a whole
//! (every bad op listed, so the model can fix the plan) or handed back normalized for the UI, which
//! previews it and applies the checked ops as one undo step.

use crate::error::{AppError, Result};
use crate::model::{Canvas, ProjectData};
use crate::state::AppState;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Up to this many cards in scope the plan is made by the local model; above it, by Claude.
pub const LOCAL_MAX_CARDS: usize = 40;
const MAX_OPS: usize = 300;
const MAX_TITLE: usize = 80;
const LAYOUTS: &[&str] = &["grid", "cluster-by-tag", "flow-by-links", "stage-columns"];

/// The project with every canvas keyed by folder id ("" = the root).
struct World {
    p: ProjectData,
    canvases: BTreeMap<String, Canvas>,
}

fn load(state: &AppState, slug: &str) -> Result<World> {
    let p = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.load_project(slug)?;
    let mut canvases = p.canvases.clone();
    canvases.insert(String::new(), p.canvas.clone());
    Ok(World { p, canvases })
}

impl World {
    fn folder_title(&self, id: &str) -> String {
        if id.is_empty() {
            return "the project root".into();
        }
        self.p.folders.iter().find(|f| f.id == id).map(|f| if f.title.trim().is_empty() { "Untitled folder".to_string() } else { f.title.trim().to_string() }).unwrap_or_else(|| id.to_string())
    }
    fn live_cards(&self) -> BTreeMap<&str, &crate::model::Card> {
        self.p.cards.iter().filter(|c| !c.meta.ghost).map(|c| (c.meta.id.as_str(), c)).collect()
    }
    /// Canvas keys in scope: the open folder and everything below it (the root = the whole project).
    fn scope_keys(&self, open: Option<&str>, scope: &str) -> Vec<String> {
        let open = open.filter(|o| self.canvases.contains_key(*o)).unwrap_or("");
        if scope == "project" || open.is_empty() {
            return self.canvases.keys().cloned().collect();
        }
        let mut out = vec![open.to_string()];
        let mut i = 0;
        while i < out.len() {
            let cur = out[i].clone();
            out.extend(self.p.folders.iter().filter(|f| f.parent.as_deref() == Some(cur.as_str())).map(|f| f.id.clone()));
            i += 1;
        }
        out
    }
    fn count(&self, keys: &[String]) -> usize {
        let live = self.live_cards();
        keys.iter().filter_map(|k| self.canvases.get(k)).map(|c| c.cards.keys().filter(|id| live.contains_key(id.as_str())).count()).sum()
    }
}

fn scope_of(input: &Value) -> &str {
    match input.get("scope").and_then(Value::as_str) {
        Some("project") => "project",
        _ => "folder",
    }
}

/// Cards in scope (not counting suggestions): picks the local model or Claude for an organize turn.
pub fn scope_count(state: &AppState, slug: &str, folder: Option<&str>, scope: &str) -> Result<usize> {
    let w = load(state, slug)?;
    Ok(w.count(&w.scope_keys(folder, scope)))
}

/// Compact text: folders, frames and cards in scope with ids, titles, tags, stage, place, flags.
pub fn list_tree(state: &AppState, slug: &str, open: Option<String>, input: &Value) -> Result<Value> {
    let w = load(state, slug)?;
    let scope = scope_of(input);
    let keys = w.scope_keys(open.as_deref(), scope);
    let live = w.live_cards();
    let paths = crate::storage::Workspace::folder_paths(&w.p.folders);
    let path = |k: &str| if k.is_empty() { "root".to_string() } else { paths.get(k).cloned().unwrap_or_else(|| k.to_string()) };
    let head = match (scope, open.as_deref().filter(|o| w.canvases.contains_key(*o))) {
        ("folder", Some(o)) => format!("Scope: folder \"{}\" ({o}) and its subfolders", path(o)),
        _ => "Scope: the whole project".to_string(),
    };
    let mut out = format!("{head} · {} cards. \"root\" = the project root. Pinned items keep their position.", w.count(&keys));
    out.push_str("\n\nFolders (id · path · parent · cards):");
    for k in keys.iter().filter(|k| !k.is_empty()) {
        let Some(f) = w.p.folders.iter().find(|f| &f.id == k) else { continue };
        let n = w.canvases.get(k).map_or(0, |c| c.cards.keys().filter(|id| live.contains_key(id.as_str())).count());
        let pinned = w.canvases.get(f.parent.as_deref().unwrap_or("")).and_then(|c| c.folders.get(k)).is_some_and(|p| p.pinned);
        out.push_str(&format!("\n- {k} · {} · parent {} · {n}{}", path(k), f.parent.as_deref().unwrap_or("root"), if pinned { " · pinned" } else { "" }));
    }
    out.push_str("\n\nFrames (id · title · on · x,y wxh):");
    for k in &keys {
        for (id, f) in &w.canvases[k].frames {
            out.push_str(&format!("\n- {id} · \"{}\" · on {} · {},{} {}x{}", f.title.trim(), if k.is_empty() { "root" } else { k }, f.x.round(), f.y.round(), f.w.round(), f.h.round()));
        }
    }
    out.push_str("\n\nCards (id · title · stage · tags · on · x,y · frame · flags · links):");
    for k in &keys {
        let c = &w.canvases[k];
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
                "\n- {id} · \"{}\" · {stage} · {tags} · on {} · {},{} · {frame}{}{}",
                card.meta.title.trim(),
                if k.is_empty() { "root" } else { k },
                p.x.round(),
                p.y.round(),
                if p.pinned { " · pinned" } else { "" },
                if links.is_empty() { String::new() } else { format!(" · links {}", links.join(",")) }
            ));
        }
    }
    Ok(Value::String(crate::ctx::cap_chars(&out, 30_000)))
}

/// What a plan works on while it is checked: where every card / folder / frame is after each op.
struct Sim {
    card_on: BTreeMap<String, String>,
    folder_parent: BTreeMap<String, String>,
    frame_on: BTreeMap<String, String>,
    temps: BTreeSet<String>,
}

impl Sim {
    /// `id` is `anc` or below it.
    fn inside(&self, id: &str, anc: &str) -> bool {
        let mut cur = id.to_string();
        for _ in 0..=self.folder_parent.len() {
            if cur == anc {
                return true;
            }
            match self.folder_parent.get(&cur) {
                Some(p) if !p.is_empty() => cur = p.clone(),
                _ => return false,
            }
        }
        false
    }
    /// "root"/""/null = the root (""); a folder id or a tempId made earlier in the plan.
    fn target(&self, v: Option<&Value>) -> std::result::Result<String, String> {
        match v {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(s)) if s.is_empty() || s == "root" => Ok(String::new()),
            Some(Value::String(s)) if self.folder_parent.contains_key(s) => Ok(s.clone()),
            Some(Value::String(s)) => Err(format!("unknown folder {s:?} (use a folder id, a tempId created earlier in the plan, or \"root\")")),
            Some(_) => Err("folder must be a string id".into()),
        }
    }
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

fn temp_of(op: &Value, sim: &Sim, w: &World) -> std::result::Result<String, String> {
    let t = op.get("tempId").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if t.is_empty() || t == "root" || t.len() > 40 || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("needs a tempId (letters, digits, - or _), e.g. \"new-combat\"".into());
    }
    if sim.temps.contains(t) || w.canvases.contains_key(t) || sim.frame_on.contains_key(t) || w.p.cards.iter().any(|c| c.meta.id == t) {
        return Err(format!("tempId {t:?} is already used"));
    }
    Ok(t.to_string())
}

/// Checks a whole plan. Err: every problem, for the model to fix. Ok: the normalized plan for the UI.
pub fn propose_organize(state: &AppState, slug: &str, open: Option<String>, input: &Value) -> Result<Value> {
    let w = load(state, slug)?;
    let scope = scope_of(input);
    let open = open.filter(|o| w.canvases.contains_key(o));
    let keys: BTreeSet<String> = w.scope_keys(open.as_deref(), scope).into_iter().collect();
    let live = w.live_cards();
    let move_pinned = input.get("move_pinned").and_then(Value::as_bool).unwrap_or(false);
    let rationale = input.get("rationale").and_then(Value::as_str).map(str::trim).unwrap_or_default().chars().take(1200).collect::<String>();
    let ops = input.get("ops").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut sim = Sim { card_on: BTreeMap::new(), folder_parent: BTreeMap::new(), frame_on: BTreeMap::new(), temps: BTreeSet::new() };
    let mut pinned: BTreeSet<String> = BTreeSet::new();
    for (k, c) in &w.canvases {
        for (id, p) in &c.cards {
            if live.contains_key(id.as_str()) {
                sim.card_on.insert(id.clone(), k.clone());
                if p.pinned {
                    pinned.insert(id.clone());
                }
            }
        }
        for (id, p) in &c.folders {
            if p.pinned {
                pinned.insert(id.clone());
            }
        }
        for id in c.frames.keys() {
            sim.frame_on.insert(id.clone(), k.clone());
        }
    }
    for f in &w.p.folders {
        sim.folder_parent.insert(f.id.clone(), f.parent.clone().unwrap_or_default());
    }

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
    let in_scope_card = |id: &str, sim: &Sim| sim.card_on.get(id).is_some_and(|k| keys.contains(k));
    let in_scope_folder = |id: &str| keys.contains(id) && !id.is_empty() && !(scope == "folder" && open.as_deref() == Some(id));

    for (i, op) in ops.iter().take(MAX_OPS).enumerate() {
        let kind = op.get("op").and_then(Value::as_str).unwrap_or_default();
        let mut bad = |m: String| errors.push(format!("op {} ({}): {m}", i + 1, if kind.is_empty() { "?" } else { kind }));
        let mut o = Map::new();
        o.insert("op".into(), json!(kind));
        match kind {
            "create_folder" => {
                let t = match temp_of(op, &sim, &w) {
                    Ok(t) => t,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                let parent = match sim.target(op.get("parent")) {
                    Ok(p) => p,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                let title = match title_of(op) {
                    Ok(t) => t,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                sim.temps.insert(t.clone());
                sim.folder_parent.insert(t.clone(), parent.clone());
                o.insert("tempId".into(), json!(t));
                o.insert("title".into(), json!(title));
                o.insert("parent".into(), if parent.is_empty() { Value::Null } else { json!(parent) });
                if let Some(c) = op.get("color").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) {
                    o.insert("color".into(), json!(c.trim()));
                }
                referenced.insert(parent);
            }
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
                    bad("cards are never renamed by a plan (that would edit card text); rename folders or frames only".into());
                    continue;
                }
                if !(sim.folder_parent.contains_key(id) || sim.frame_on.contains_key(id)) {
                    bad(format!("unknown folder or frame {id:?}"));
                    continue;
                }
                o.insert("id".into(), json!(id));
                o.insert("title".into(), json!(title));
                referenced.insert(id.to_string());
            }
            "move" => {
                let to = match sim.target(op.get("to")) {
                    Ok(t) => t,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                let ids = match str_list(op.get("ids")) {
                    Ok(v) if !v.is_empty() => v,
                    Ok(_) => {
                        bad("needs ids".into());
                        continue;
                    }
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
                    if sim.card_on.contains_key(&id) {
                        if !in_scope_card(&id, &sim) && !sim.card_on.get(&id).is_some_and(|k| sim.temps.contains(k)) {
                            bad(format!("card {id} is outside the scope"));
                            continue;
                        }
                        if pinned.contains(&id) && !move_pinned {
                            kept.insert(id);
                            continue;
                        }
                        sim.card_on.insert(id.clone(), to.clone());
                    } else if sim.folder_parent.contains_key(&id) {
                        if !sim.temps.contains(&id) && !in_scope_folder(&id) {
                            bad(format!("folder {id} is outside the scope"));
                            continue;
                        }
                        if !to.is_empty() && sim.inside(&to, &id) {
                            bad(format!("folder {id} can't go into itself or a folder below it"));
                            continue;
                        }
                        if pinned.contains(&id) && !move_pinned {
                            kept.insert(id);
                            continue;
                        }
                        sim.folder_parent.insert(id.clone(), to.clone());
                    } else if !w.p.cards.iter().any(|c| c.meta.id == id) {
                        bad(format!("unknown card or folder {id:?}"));
                        continue;
                    } else {
                        bad(format!("{id} is a suggestion (ghost card); leave it out"));
                        continue;
                    }
                    referenced.insert(id.clone());
                    take.push(id);
                }
                if take.is_empty() {
                    continue;
                }
                o.insert("ids".into(), json!(take));
                o.insert("to".into(), if to.is_empty() { Value::Null } else { json!(to) });
                for k in ["x", "y"] {
                    if let Some(n) = op.get(k).and_then(Value::as_f64).filter(|n| n.is_finite() && n.abs() < 1e6) {
                        o.insert(k.into(), json!(n.round()));
                    }
                }
                referenced.insert(to);
            }
            "create_frame" => {
                let t = match temp_of(op, &sim, &w) {
                    Ok(t) => t,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
                let on = match sim.target(op.get("folder")) {
                    Ok(p) => p,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
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
                sim.temps.insert(t.clone());
                sim.frame_on.insert(t.clone(), on.clone());
                o.insert("tempId".into(), json!(t));
                o.insert("folder".into(), if on.is_empty() { Value::Null } else { json!(on) });
                o.insert("title".into(), json!(title));
                o.insert("rect".into(), json!({ "x": x.round(), "y": y.round(), "w": fw.round(), "h": fh.round() }));
                referenced.insert(on);
            }
            "arrange" => {
                let on = match sim.target(op.get("folder")) {
                    Ok(p) => p,
                    Err(e) => {
                        bad(e);
                        continue;
                    }
                };
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
                    match sim.card_on.get(&id) {
                        Some(k) if *k == on => {}
                        Some(_) => {
                            bad(format!("card {id} is not on {} at this point of the plan (move it there first)", w.folder_title(&on)));
                            continue;
                        }
                        None => {
                            bad(format!("unknown card {id:?}"));
                            continue;
                        }
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
                        bad("needs the ids of at least 2 cards on that folder".into());
                    }
                    continue;
                }
                o.insert("folder".into(), if on.is_empty() { Value::Null } else { json!(on) });
                o.insert("ids".into(), json!(take));
                o.insert("layout".into(), json!(layout));
                referenced.insert(on);
            }
            "retag" => {
                let id = op.get("id").and_then(Value::as_str).unwrap_or_default();
                let Some(card) = live.get(id) else {
                    bad(format!("unknown card {id:?}"));
                    continue;
                };
                let (add, remove) = match (str_list(op.get("add")), str_list(op.get("remove"))) {
                    (Ok(a), Ok(r)) => (a, r),
                    (Err(e), _) | (_, Err(e)) => {
                        bad(e);
                        continue;
                    }
                };
                let add: Vec<String> = add.into_iter().filter(|t| !t.is_empty() && t.chars().count() <= 40 && !card.meta.tags.contains(t)).collect();
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
            other => bad(format!("unknown op {other:?}; use create_folder, rename, move, create_frame, arrange or retag (plans never delete or edit card text)")),
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
            "Every op only touched pinned items, which keep their place (the plan was NOT shown). Leave pinned items out.".into()
        }));
    }
    let mut titles = Map::new();
    for id in referenced.iter().chain(kept.iter()) {
        if id.is_empty() || sim.temps.contains(id) {
            continue;
        }
        let t = if let Some(c) = live.get(id.as_str()) {
            if c.meta.title.trim().is_empty() { "Untitled".to_string() } else { c.meta.title.trim().to_string() }
        } else if sim.folder_parent.contains_key(id) {
            w.folder_title(id)
        } else if let Some(f) = w.canvases.values().find_map(|c| c.frames.get(id)) {
            if f.title.trim().is_empty() { "Untitled frame".into() } else { f.title.trim().to_string() }
        } else {
            continue;
        };
        titles.insert(id.clone(), json!(t));
    }
    let kept: Vec<Value> = kept.iter().map(|id| json!({ "id": id, "title": titles.get(id).cloned().unwrap_or(json!(id)) })).collect();
    Ok(json!({
        "slug": slug,
        "scope": scope,
        "folder": if scope == "folder" { open.clone().map(Value::String).unwrap_or(Value::Null) } else { Value::Null },
        "scopeName": if scope == "folder" { open.as_deref().map(|o| w.folder_title(o)).unwrap_or_else(|| w.p.meta.name.clone()) } else { w.p.meta.name.clone() },
        "rationale": rationale,
        "ops": out_ops,
        "kept": kept,
        "titles": titles,
    }))
}

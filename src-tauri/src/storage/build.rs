//! The Built stage: a card's `build` block, its snapshot (`cards/<id>.built.md`), drift ("Needs
//! rebuild"), the STATUS.md sync and the repo link file. Spec: docs/status-format.md.

use super::*;
use serde::Deserialize;
use crate::status::{self, Entry};
use serde_json::{json, Map};
use std::collections::HashMap;

pub const STATUS_REL: &str = "docs/design/STATUS.md";
pub const TASKS_REL: &str = "docs/design/tasks";
pub const OUTBOX_REL: &str = ".dreamer/outbox";
pub const STATUS_TEMPLATE: &str = "# Build status\n<!-- dreamer:status v1 -->\n";
pub const FRAME_TITLE: &str = "Built outside Dreamer";
const MAX_EVIDENCE: u64 = 25 * 1024 * 1024;

/// Hash of the saved content that counts for drift: title, body, tags, fields.
pub fn content_hash(c: &Card) -> String {
    let fields = serde_json::to_string(&c.meta.fields).unwrap_or_default();
    status::fnv(&[c.meta.title.trim(), &c.body, &c.meta.tags.join("\u{1f}"), &fields])
}

/// The saved content as readable text (the snapshot file, and what "Diff since built" compares).
pub fn snapshot_text(c: &Card) -> String {
    #[derive(Serialize)]
    struct Head<'a> {
        title: &'a str,
        tags: &'a [String],
        fields: &'a BTreeMap<String, Value>,
    }
    let yaml = serde_yaml::to_string(&Head { title: c.meta.title.trim(), tags: &c.meta.tags, fields: &c.meta.fields }).unwrap_or_default();
    format!("---\n{yaml}---\n\n{}\n", c.body.trim_end_matches('\n'))
}

pub fn build_status(c: &Card) -> Option<&str> {
    c.meta.extra.get("build")?.get("status")?.as_str()
}

pub fn is_dirty(c: &Card) -> bool {
    c.meta.extra.get("build").and_then(|b| b.get("dirty")).and_then(Value::as_bool).unwrap_or(false)
}

fn block_mut(c: &mut Card) -> &mut Map<String, Value> {
    let v = c.meta.extra.entry("build".into()).or_insert_with(|| json!({}));
    if !v.is_object() {
        *v = json!({});
    }
    v.as_object_mut().expect("just made an object")
}

fn push_history(b: &mut Map<String, Value>, status: &str, source: &str) {
    let h = b.entry("history").or_insert_with(|| json!([]));
    if !h.is_array() {
        *h = json!([]);
    }
    h.as_array_mut().expect("just made an array").push(json!({ "at": now(), "status": status, "source": source }));
}

fn snapshot_path(dir: &Path, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    Ok(dir.join("cards").join(format!("{id}.built.md")))
}

/// The card becomes built (from STATUS.md or by hand): stage Built, snapshot of the saved
/// content written, `dirty` cleared, history extended. The caller writes the card file.
pub fn mark_built(dir: &Path, card: &mut Card, status: &str, source: &str) -> Result<()> {
    card.meta.stage = Stage::Built;
    let hash = content_hash(card);
    atomic_write(&snapshot_path(dir, &card.meta.id)?, snapshot_text(card).as_bytes())?;
    let b = block_mut(card);
    b.insert("status".into(), json!(status));
    b.insert("built_at".into(), json!(now()));
    b.insert("snapshot_hash".into(), json!(hash));
    b.insert("dirty".into(), json!(false));
    b.remove("dirty_manual");
    push_history(b, status, source);
    Ok(())
}

/// Recomputes `dirty` from the saved content. True when it changed. Partial builds never drift
/// (they are not finished yet), and a card with no snapshot has nothing to drift from.
pub fn refresh_dirty(card: &mut Card) -> bool {
    if card.meta.stage != Stage::Built {
        return false;
    }
    let hash = content_hash(card);
    let Some(b) = card.meta.extra.get_mut("build").and_then(Value::as_object_mut) else { return false };
    let Some(snap) = b.get("snapshot_hash").and_then(Value::as_str) else { return false };
    // `dirty_manual`: dragged to "Needs rebuild" on the Build board; stays until built again or dragged back.
    let manual = b.get("dirty_manual").and_then(Value::as_bool).unwrap_or(false);
    let dirty = manual || (b.get("status").and_then(Value::as_str) != Some("partial") && snap != hash);
    if b.get("dirty").and_then(Value::as_bool).unwrap_or(false) == dirty {
        return false;
    }
    b.insert("dirty".into(), json!(dirty));
    true
}

/// What `update_card` does for the Built stage: a card that just became built is snapshotted; a
/// built card has its drift recomputed (a built card that never had a snapshot gets one).
pub(super) fn on_save(dir: &Path, card: &mut Card, was_built: bool) -> Result<()> {
    if card.meta.stage != Stage::Built {
        return Ok(());
    }
    let status = build_status(card).filter(|s| matches!(*s, "built" | "partial")).map(String::from);
    let has_snapshot = card.meta.extra.get("build").and_then(|b| b.get("snapshot_hash")).is_some();
    match (was_built, status) {
        (false, _) => mark_built(dir, card, "built", "manual")?,
        (true, Some(s)) if !has_snapshot => mark_built(dir, card, &s, "manual")?,
        _ => {
            refresh_dirty(card);
        }
    }
    Ok(())
}

pub fn gitignore_add(repo: &Path) -> Result<bool> {
    let path = repo.join(".gitignore");
    let text = fs::read_to_string(&path).unwrap_or_default();
    if text.lines().any(|l| matches!(l.trim(), ".dreamer" | ".dreamer/" | "/.dreamer" | "/.dreamer/")) {
        return Ok(false);
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { eol };
    atomic_write(&path, format!("{text}{sep}.dreamer/{eol}").as_bytes())?;
    Ok(true)
}

// ---------- STATUS.md sync ----------

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
struct SyncState {
    /// Entry key -> hash of the entry as last applied.
    #[serde(default)]
    entries: BTreeMap<String, String>,
    /// Dismiss keys (title + files) of `new` entries the user threw away: they never come back.
    #[serde(default)]
    dismissed: Vec<String>,
    /// Dismiss key -> the ghost card made for it.
    #[serde(default)]
    new_cards: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct SyncItem {
    pub id: String,
    pub title: String,
}

/// What one STATUS.md change did, for the "Build update" chat line.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct SyncReport {
    pub slug: String,
    pub built: Vec<SyncItem>,
    pub partial: Vec<SyncItem>,
    pub in_progress: Vec<SyncItem>,
    pub new: Vec<SyncItem>,
    pub blocked: Vec<SyncItem>,
    pub warnings: Vec<String>,
}

impl SyncReport {
    pub fn changed(&self) -> bool {
        [&self.built, &self.partial, &self.in_progress, &self.new, &self.blocked].iter().any(|l| !l.is_empty())
    }
}

fn repo_rel_ok(r: &str) -> bool {
    !r.is_empty() && !r.starts_with('/') && !r.contains(':') && !r.split('/').any(|s| s.is_empty() || s == "..")
}

impl Workspace {
    fn repo_of(&self, slug: &str) -> Result<Option<PathBuf>> {
        let dir = self.existing_project_dir(slug)?;
        Ok(read_json_or_default_meta(&dir.join("project.json"), slug)?.handoff_target.filter(|t| !t.trim().is_empty()).map(PathBuf::from))
    }

    /// "Mark as built now" / "Clear needs rebuild": the saved content becomes the snapshot.
    pub fn mark_built_now(&self, slug: &str, id: &str) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        let path = Self::card_path(&dir, id)?;
        let mut card = Self::read_card_file(&path, id)?;
        mark_built(&dir, &mut card, "built", "manual")?;
        card.meta.updated = now();
        Self::write_card_file(&path, &card)?;
        Ok(card)
    }

    /// A saved build task queues its cards: status `queued`, `task` = the repo-relative task file.
    pub fn queue_cards(&self, slug: &str, ids: &[String], task: &str) -> Result<()> {
        self.set_cards_status(slug, ids, "queued", "dreamer", Some(task))
    }

    /// A build run started on these cards: `in-progress` until STATUS.md says otherwise.
    pub fn set_build_status(&self, slug: &str, ids: &[String], status: &str, source: &str) -> Result<()> {
        self.set_cards_status(slug, ids, status, source, None)
    }

    fn set_cards_status(&self, slug: &str, ids: &[String], status: &str, source: &str, task: Option<&str>) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        for id in ids {
            let path = Self::card_path(&dir, id)?;
            let mut card = Self::read_card_file(&path, id)?;
            let b = block_mut(&mut card);
            b.insert("status".into(), json!(status));
            if let Some(t) = task {
                b.insert("task".into(), json!(t));
            }
            push_history(b, status, source);
            card.meta.updated = now();
            Self::write_card_file(&path, &card)?;
        }
        Ok(())
    }

    /// Undo of the above: puts the build block, snapshot file and stage back as they were.
    pub fn restore_build(&self, slug: &str, id: &str, build: Option<Value>, snapshot: Option<String>, stage: Stage) -> Result<Card> {
        let dir = self.existing_project_dir(slug)?;
        let path = Self::card_path(&dir, id)?;
        let mut card = Self::read_card_file(&path, id)?;
        match build {
            Some(b) => card.meta.extra.insert("build".into(), b),
            None => card.meta.extra.remove("build"),
        };
        card.meta.stage = stage;
        let sp = snapshot_path(&dir, id)?;
        match snapshot {
            Some(t) => atomic_write(&sp, t.as_bytes())?,
            None => {
                let _ = fs::remove_file(&sp);
            }
        }
        card.meta.updated = now();
        Self::write_card_file(&path, &card)?;
        Ok(card)
    }

    /// (snapshot at build time, the saved content now), both in `snapshot_text` form.
    pub fn built_texts(&self, slug: &str, id: &str) -> Result<(Option<String>, String)> {
        let dir = self.existing_project_dir(slug)?;
        let card = Self::read_card_file(&Self::card_path(&dir, id)?, id)?;
        Ok((fs::read_to_string(snapshot_path(&dir, id)?).ok(), snapshot_text(&card)))
    }

    /// Recomputes drift for every card that has a snapshot (after an external edit). Returns how many changed.
    pub fn refresh_dirty_all(&self, slug: &str) -> Result<usize> {
        let dir = self.existing_project_dir(slug)?;
        let Ok(rd) = fs::read_dir(dir.join("cards")) else { return Ok(0) };
        let mut n = 0;
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".built.md") else { continue };
            let path = Self::card_path(&dir, id)?;
            let Ok(mut card) = Self::read_card_file(&path, id) else { continue };
            if refresh_dirty(&mut card) {
                Self::write_card_file(&path, &card)?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// Reads STATUS.md of the project's repo and applies the entries that changed since the last
    /// sync (build-sync.json). STATUS.md itself is never written.
    pub fn sync_status(&self, slug: &str) -> Result<SyncReport> {
        let mut report = SyncReport { slug: slug.into(), ..Default::default() };
        let Some(repo) = self.repo_of(slug)? else { return Ok(report) };
        let Ok(text) = fs::read_to_string(repo.join(STATUS_REL)) else { return Ok(report) };
        let dir = self.existing_project_dir(slug)?;
        let parsed = status::parse(&text);
        report.warnings = parsed.warnings;
        let state_path = dir.join("build-sync.json");
        let mut st: SyncState = read_json_or_default(&state_path)?;
        let before = st.clone();
        let mut by_id: HashMap<String, Card> = Self::list_cards_in(&dir).0.into_iter().map(|c| (c.meta.id.clone(), c)).collect();
        // A ghost made for a `new` entry that is gone was dismissed: remember it for good.
        let gone: Vec<String> = st.new_cards.iter().filter(|(_, id)| !by_id.contains_key(*id)).map(|(k, _)| k.clone()).collect();
        for k in gone {
            st.new_cards.remove(&k);
            st.dismissed.push(k);
        }
        for e in &parsed.entries {
            let (key, hash) = (e.key(), e.hash());
            if st.entries.get(&key) == Some(&hash) {
                continue;
            }
            let res = match &e.id {
                Some(id) => match by_id.get_mut(id) {
                    Some(card) => self.apply_entry(slug, &dir, &repo, card, e, &mut report.warnings).map(|s| {
                        let item = SyncItem { id: id.clone(), title: card.meta.title.clone() };
                        match s {
                            Some("built") => report.built.push(item),
                            Some("partial") => report.partial.push(item),
                            Some("in-progress") => report.in_progress.push(item),
                            Some("blocked") => report.blocked.push(item),
                            _ => {}
                        }
                    }),
                    None => {
                        report.warnings.push(format!("\"{}\": no card with id {id}; skipped.", e.title));
                        Ok(())
                    }
                },
                None => self.sync_new(slug, &dir, &repo, &mut st, &mut by_id, e, &mut report),
            };
            match res {
                Ok(()) => {
                    st.entries.insert(key, hash);
                }
                // Not recorded: the next change of STATUS.md tries this entry again.
                Err(err) => report.warnings.push(format!("\"{}\": {err}", e.title)),
            }
        }
        if st != before {
            write_json(&state_path, &st)?;
        }
        Ok(report)
    }

    /// Applies one entry to a known card and writes it. Returns the status that was applied.
    fn apply_entry(&self, slug: &str, dir: &Path, repo: &Path, card: &mut Card, e: &Entry, warnings: &mut Vec<String>) -> Result<Option<&'static str>> {
        let applied = e.status.as_deref().and_then(status::norm_status);
        let prev = build_status(card).map(String::from);
        let was_dirty = is_dirty(card);
        let old_commits = card.meta.extra.get("build").and_then(|b| b.get("commits")).cloned();
        let has_snapshot = card.meta.extra.get("build").and_then(|b| b.get("snapshot_hash")).is_some();
        {
            let b = block_mut(card);
            if let Some(t) = &e.task {
                b.insert("task".into(), json!(t));
            }
            if !e.commits.is_empty() {
                b.insert("commits".into(), json!(e.commits));
            }
            if !e.files.is_empty() {
                b.insert("files".into(), json!(e.files));
            }
            if let Some(n) = &e.notes {
                b.insert("notes".into(), json!(n));
            }
        }
        self.copy_evidence(slug, repo, card, &e.evidence, warnings);
        match applied {
            Some(s @ ("built" | "partial")) => {
                // A card that drifted since its build counts as rebuilt only when the commits changed.
                let rebuilt = was_dirty && !e.commits.is_empty() && old_commits != Some(json!(e.commits));
                if prev.as_deref() != Some(s) || !has_snapshot || rebuilt {
                    mark_built(dir, card, s, "status")?;
                }
            }
            Some(s) => {
                let b = block_mut(card);
                b.insert("status".into(), json!(s));
                if prev.as_deref() != Some(s) {
                    push_history(b, s, "status");
                }
                if s == "blocked" && prev.as_deref() != Some(s) {
                    let why = e.notes.as_deref().map(|n| format!(" — {}", n.lines().next().unwrap_or(""))).unwrap_or_default();
                    if let Err(err) = crate::questions::add_question(self, slug, &format!("Blocked: {}{why}", card.meta.title)) {
                        warnings.push(format!("could not add \"{}\" to the questions card: {err}", card.meta.title));
                    }
                }
            }
            None => {}
        }
        card.meta.updated = now();
        Self::write_card_file(&Self::card_path(dir, &card.meta.id)?, card)?;
        Ok(applied)
    }

    /// Copies evidence images from the repo into the project's media/ and records both paths.
    fn copy_evidence(&self, slug: &str, repo: &Path, card: &mut Card, paths: &[String], warnings: &mut Vec<String>) {
        for raw in paths {
            let rel = raw.replace('\\', "/");
            let ext = Path::new(&rel).extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if !repo_rel_ok(&rel) || !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
                warnings.push(format!("evidence \"{raw}\" is not a repo-relative png, jpg, gif or webp; skipped."));
                continue;
            }
            let have = card.meta.extra.get("build").and_then(|b| b.get("evidence")).and_then(Value::as_array).is_some_and(|l| l.iter().any(|v| v.get("repo").and_then(Value::as_str) == Some(rel.as_str())));
            if have {
                continue;
            }
            let src = repo.join(&rel);
            let bytes = match fs::metadata(&src) {
                Ok(m) if m.len() > MAX_EVIDENCE => {
                    warnings.push(format!("evidence \"{rel}\" is over 25 MB; skipped."));
                    continue;
                }
                Ok(_) => fs::read(&src),
                Err(e) => Err(e),
            };
            match bytes.map_err(|e| e.to_string()).and_then(|b| self.save_media(slug, &rel, &b).map_err(|e| e.to_string())) {
                Ok(media) => {
                    let b = block_mut(card);
                    let l = b.entry("evidence").or_insert_with(|| json!([]));
                    if let Some(l) = l.as_array_mut() {
                        l.push(json!({ "path": media, "repo": rel }));
                    }
                }
                Err(e) => warnings.push(format!("evidence \"{rel}\" could not be copied: {e}")),
            }
        }
    }

    /// A `## new · title` entry: a ghost card in the "Built outside Dreamer" frame of the open
    /// version, unless it was dismissed. An entry whose ghost still exists updates that card.
    #[allow(clippy::too_many_arguments)]
    fn sync_new(&self, slug: &str, dir: &Path, repo: &Path, st: &mut SyncState, by_id: &mut HashMap<String, Card>, e: &Entry, report: &mut SyncReport) -> Result<()> {
        let dk = e.dismiss_key();
        if st.dismissed.contains(&dk) {
            return Ok(());
        }
        if let Some(id) = st.new_cards.get(&dk).cloned() {
            if let Some(card) = by_id.get_mut(&id) {
                self.apply_entry(slug, dir, repo, card, e, &mut report.warnings)?;
            }
            return Ok(());
        }
        let done = matches!(e.status.as_deref(), Some("built" | "partial"));
        let (folder, x, y) = Self::place_in_built_frame(dir)?;
        let mut card = self.create_card(
            slug,
            NewCard {
                title: Some(e.title.clone()).filter(|t| !t.trim().is_empty()),
                body: e.notes.clone(),
                stage: Some(if done { Stage::Built } else { Stage::Mist }),
                source: Some(Source::Claude),
                ghost: Some(true),
                folder,
                x: Some(x),
                y: Some(y),
                ..Default::default()
            },
        )?;
        self.apply_entry(slug, dir, repo, &mut card, e, &mut report.warnings)?;
        report.new.push(SyncItem { id: card.meta.id.clone(), title: card.meta.title.clone() });
        st.new_cards.insert(dk, card.meta.id.clone());
        by_id.insert(card.meta.id.clone(), card);
        Ok(())
    }

    /// The open version's folder, and the next free slot inside its "Built outside Dreamer" frame
    /// (created to the right of existing content, and grown, as needed).
    fn place_in_built_frame(dir: &Path) -> Result<(Option<String>, f64, f64)> {
        let folders = Self::read_folders(dir)?;
        let folder = Self::open_version_in(dir, &folders).map(|f| f.id);
        let mut canvas = Self::read_canvas_at(dir, folder.as_deref())?;
        let mut changed = false;
        let fid = match canvas.frames.iter().find(|(_, f)| f.title.trim().eq_ignore_ascii_case(FRAME_TITLE)).map(|(id, _)| id.clone()) {
            Some(id) => id,
            None => {
                let right = canvas.cards.values().map(|p| p.x + p.w.unwrap_or(236.0)).chain(canvas.frames.values().map(|f| f.x + f.w)).fold(None, |a: Option<f64>, v| Some(a.map_or(v, |a| a.max(v))));
                let id = ulid::Ulid::generate().to_string();
                let z = canvas.frames.values().map(|f| f.z).max().unwrap_or(0) + 1;
                canvas.frames.insert(id.clone(), Frame { x: right.map_or(0.0, |r| r + 120.0), y: 0.0, w: 540.0, h: 400.0, title: FRAME_TITLE.into(), color: None, z });
                changed = true;
                id
            }
        };
        let fr = canvas.frames[&fid].clone();
        let n = canvas
            .cards
            .values()
            .filter(|p| {
                let (cx, cy) = (p.x + p.w.unwrap_or(236.0) / 2.0, p.y + p.h.unwrap_or(150.0) / 2.0);
                cx >= fr.x && cx <= fr.x + fr.w && cy >= fr.y && cy <= fr.y + fr.h
            })
            .count();
        let (col, row) = ((n % 2) as f64, (n / 2) as f64);
        let need = 56.0 + (row + 1.0) * 190.0 + 16.0;
        if need > fr.h {
            canvas.frames.get_mut(&fid).expect("frame exists").h = need;
            changed = true;
        }
        if changed {
            Self::write_canvas(dir, folder.as_deref(), &canvas)?;
        }
        Ok((folder, fr.x + 24.0 + col * 250.0, fr.y + 56.0 + row * 190.0))
    }

    // ----- <repo>/.dreamer/link.json -----

    /// The link file for the project's repo: where it goes and what it says (open version only).
    pub fn link_value(&self, slug: &str) -> Result<Option<(PathBuf, Value)>> {
        let dir = self.existing_project_dir(slug)?;
        let meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        // Nothing is written into a repo the user has not confirmed.
        let Some(repo) = meta.handoff_target.clone().filter(|t| meta.handoff_target_confirmed.as_deref() == Some(t.as_str())).map(PathBuf::from) else { return Ok(None) };
        let folders = Self::read_folders(&dir)?;
        let open = Self::open_version_in(&dir, &folders);
        let of = Self::card_versions_in(&dir)?;
        let frames = self.card_frames(slug)?;
        let mut tags: Vec<String> = Vec::new();
        let mut cards = Vec::new();
        for c in Self::list_cards_in(&dir).0 {
            let in_open = match &open {
                Some(v) => of.get(&c.meta.id) == Some(&v.id),
                None => true,
            };
            if c.meta.ghost || c.meta.kind != CardKind::Card || c.meta.role.is_some() || !in_open {
                continue;
            }
            for t in &c.meta.tags {
                if !tags.contains(t) {
                    tags.push(t.clone());
                }
            }
            cards.push(json!({
                "id": c.meta.id, "title": c.meta.title, "stage": c.meta.stage, "tags": c.meta.tags,
                "frame": frames.get(&c.meta.id), "build_status": build_status(&c), "dirty": is_dirty(&c),
            }));
        }
        tags.sort();
        let value = json!({
            "dreamer": 1,
            "workspace": self.root.display().to_string(),
            "project": { "slug": slug, "name": meta.name },
            "version": open.as_ref().map(|v| json!({ "id": v.id, "title": v.title })),
            "versions": versions_of(&folders).iter().map(|v| v.title.clone()).collect::<Vec<_>>(),
            "status_file": STATUS_REL,
            "tasks_dir": TASKS_REL,
            "outbox": OUTBOX_REL,
            "tags": tags,
            "cards": cards,
        });
        Ok(Some((repo.join(".dreamer").join("link.json"), value)))
    }

    /// Writes link.json (atomic) unless it already says the same. True when it wrote.
    pub fn write_link(&self, slug: &str) -> Result<bool> {
        let Some((path, value)) = self.link_value(slug)? else { return Ok(false) };
        let mut text = serde_json::to_string_pretty(&value).map_err(|e| AppError::Invalid(e.to_string()))?;
        text.push('\n');
        if fs::read_to_string(&path).is_ok_and(|old| old == text) {
            return Ok(false);
        }
        atomic_write(&path, text.as_bytes())?;
        Ok(true)
    }

    /// "Link repo…" confirmed: remember and confirm the folder, create the empty STATUS.md,
    /// optionally ignore `.dreamer/` in git, and write the link file.
    pub fn link_repo(&self, slug: &str, path: &str, gitignore: bool) -> Result<ProjectSummary> {
        let path = path.trim();
        self.update_project(slug, ProjectPatch { handoff_target: Some(path.into()), ..Default::default() })?;
        let sum = self.update_project(slug, ProjectPatch { handoff_target_confirmed: Some(path.into()), ..Default::default() })?;
        let repo = Path::new(path);
        crate::handoff::create_if_missing(&repo.join(STATUS_REL), STATUS_TEMPLATE)?;
        if gitignore {
            gitignore_add(repo)?;
        }
        self.write_link(slug)?;
        Ok(sum)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Workspace, String, PathBuf) {
        let d = TempDir::new().unwrap();
        let ws = Workspace::open(d.path().join("Dreamer")).unwrap();
        let p = ws.create_project("Fish").unwrap();
        let repo = d.path().join("repo");
        fs::create_dir_all(repo.join("docs/design")).unwrap();
        ws.link_repo(&p.slug, &repo.display().to_string(), true).unwrap();
        (d, ws, p.slug, repo)
    }

    fn card(ws: &Workspace, slug: &str, title: &str, body: &str) -> Card {
        ws.create_card(slug, NewCard { title: Some(title.into()), body: Some(body.into()), ..Default::default() }).unwrap()
    }

    fn built(ws: &Workspace, slug: &str, id: &str) -> Card {
        ws.update_card(slug, id, CardPatch { stage: Some(Stage::Built), ..Default::default() }).unwrap()
    }

    #[test]
    fn queueing_sets_status_and_task_and_keeps_drift() {
        let (_d, ws, slug, _) = setup();
        let c = built(&ws, &slug, &card(&ws, &slug, "Harpoon", "a rod").meta.id);
        ws.update_card(&slug, &c.meta.id, CardPatch { body: Some("a long rod".into()), ..Default::default() }).unwrap();
        ws.queue_cards(&slug, &[c.meta.id.clone()], "docs/design/tasks/x.md").unwrap();
        let c = ws.read_card(&slug, &c.meta.id).unwrap();
        assert_eq!((build_status(&c), is_dirty(&c)), (Some("queued"), true));
        assert_eq!(c.meta.extra["build"]["task"].as_str(), Some("docs/design/tasks/x.md"));
    }

    #[test]
    fn becoming_built_snapshots_and_edits_make_it_dirty_until_reverted() {
        let (_d, ws, slug, _) = setup();
        let c = card(&ws, &slug, "Harpoon", "a rod");
        let c = built(&ws, &slug, &c.meta.id);
        assert_eq!((build_status(&c), is_dirty(&c)), (Some("built"), false));
        let dir = ws.project_dir(&slug).unwrap();
        assert!(dir.join(format!("cards/{}.built.md", c.meta.id)).is_file());
        let h = c.meta.extra["build"]["history"].as_array().unwrap().clone();
        assert_eq!((h.len(), h[0]["source"].as_str()), (1, Some("manual")));
        // A saved edit drifts; the stage stays built.
        let c = ws.update_card(&slug, &c.meta.id, CardPatch { body: Some("a longer rod".into()), ..Default::default() }).unwrap();
        assert_eq!((c.meta.stage, is_dirty(&c)), (Stage::Built, true));
        // Tags and fields count too; reverting clears it.
        let c = ws.update_card(&slug, &c.meta.id, CardPatch { tags: Some(vec!["gear".into()]), ..Default::default() }).unwrap();
        assert!(is_dirty(&c));
        let c = ws.update_card(&slug, &c.meta.id, CardPatch { body: Some("a rod".into()), tags: Some(vec![]), ..Default::default() }).unwrap();
        assert!(!is_dirty(&c));
        // Marking built again re-snapshots; the diff texts show old and new.
        let c = ws.update_card(&slug, &c.meta.id, CardPatch { body: Some("a rod, v2".into()), ..Default::default() }).unwrap();
        assert!(is_dirty(&c));
        let (snap, now_text) = ws.built_texts(&slug, &c.meta.id).unwrap();
        assert!(snap.unwrap().contains("a rod\n") && now_text.contains("a rod, v2"));
        let c = ws.mark_built_now(&slug, &c.meta.id).unwrap();
        assert!(!is_dirty(&c) && ws.built_texts(&slug, &c.meta.id).unwrap().0.unwrap().contains("a rod, v2"));
    }

    #[test]
    fn a_manual_needs_rebuild_survives_refresh_until_built_again() {
        let (_d, ws, slug, _) = setup();
        let c = built(&ws, &slug, &card(&ws, &slug, "Lure", "a lure").meta.id);
        let mut b = c.meta.extra["build"].clone();
        b["dirty"] = json!(true);
        b["dirty_manual"] = json!(true);
        let snap = ws.built_texts(&slug, &c.meta.id).unwrap().0;
        let c = ws.restore_build(&slug, &c.meta.id, Some(b), snap, Stage::Built).unwrap();
        assert!(is_dirty(&c));
        ws.refresh_dirty_all(&slug).unwrap();
        let c = ws.update_card(&slug, &c.meta.id, CardPatch { tags: Some(vec![]), ..Default::default() }).unwrap();
        assert!(is_dirty(&c), "unchanged content does not clear a manual mark");
        let c = ws.mark_built_now(&slug, &c.meta.id).unwrap();
        assert!(!is_dirty(&c) && c.meta.extra["build"].get("dirty_manual").is_none());
        ws.set_build_status(&slug, std::slice::from_ref(&c.meta.id), "in-progress", "run").unwrap();
        assert_eq!(build_status(&ws.load_project(&slug).unwrap().cards.into_iter().find(|x| x.meta.id == c.meta.id).unwrap()), Some("in-progress"));
    }

    #[test]
    fn an_external_edit_is_found_by_refresh_and_partial_never_drifts() {
        let (_d, ws, slug, _) = setup();
        let c = built(&ws, &slug, &card(&ws, &slug, "Net", "a net").meta.id);
        let dir = ws.project_dir(&slug).unwrap();
        let path = dir.join(format!("cards/{}.md", c.meta.id));
        let text = fs::read_to_string(&path).unwrap().replace("a net", "a wide net");
        fs::write(&path, text).unwrap();
        assert_eq!(ws.refresh_dirty_all(&slug).unwrap(), 1);
        assert!(is_dirty(&ws.read_card(&slug, &c.meta.id).unwrap()));
        assert_eq!(ws.refresh_dirty_all(&slug).unwrap(), 0, "idempotent");
        // Revert on disk clears it.
        fs::write(&path, fs::read_to_string(&path).unwrap().replace("a wide net", "a net")).unwrap();
        assert_eq!(ws.refresh_dirty_all(&slug).unwrap(), 1);
        assert!(!is_dirty(&ws.read_card(&slug, &c.meta.id).unwrap()));
        // Partial: stays clean whatever the content does.
        let mut p = ws.read_card(&slug, &c.meta.id).unwrap();
        p.meta.extra.get_mut("build").unwrap()["status"] = json!("partial");
        p.body = "changed".into();
        assert!(!refresh_dirty(&mut p));
    }

    #[test]
    fn status_sync_updates_known_cards_adds_new_ghosts_and_remembers_dismissals() {
        let (_d, ws, slug, repo) = setup();
        let a = card(&ws, &slug, "Harpoon", "a rod");
        let b = card(&ws, &slug, "Net", "a net");
        fs::create_dir_all(repo.join("docs/design/evidence")).unwrap();
        fs::write(repo.join("docs/design/evidence/rod.png"), b"png").unwrap();
        let status = repo.join(STATUS_REL);
        assert_eq!(fs::read_to_string(&status).unwrap(), STATUS_TEMPLATE, "created empty on link");
        fs::write(
            &status,
            format!(
                "# Build status\n<!-- dreamer:status v1 -->\n## {a} · Harpoon\nstatus: built\ncommits: abc123\nfiles: src/rod.ts\nevidence: docs/design/evidence/rod.png, ../etc/x.png\n## {b} · Net\nstatus: blocked\nnotes: needs the physics decision\n## new · Fish radio\nstatus: built\nfiles: src/radio.ts\nnotes: plays shanties\n## {b}zz · Ghost\nstatus: built\n",
                a = a.meta.id,
                b = b.meta.id
            ),
        )
        .unwrap();
        let r = ws.sync_status(&slug).unwrap();
        assert_eq!((r.built.len(), r.blocked.len(), r.new.len()), (1, 1, 1), "{r:?}");
        assert!(r.warnings.iter().any(|w| w.contains("../etc/x.png")) && r.warnings.iter().any(|w| w.contains("no card with id")));
        let a2 = ws.read_card(&slug, &a.meta.id).unwrap();
        assert_eq!((a2.meta.stage, build_status(&a2), is_dirty(&a2)), (Stage::Built, Some("built"), false));
        assert_eq!(a2.meta.extra["build"]["commits"], json!(["abc123"]));
        let ev = &a2.meta.extra["build"]["evidence"][0];
        assert_eq!(ev["repo"], "docs/design/evidence/rod.png");
        assert!(ws.project_dir(&slug).unwrap().join(ev["path"].as_str().unwrap()).is_file(), "copied into media/");
        let b2 = ws.read_card(&slug, &b.meta.id).unwrap();
        assert_eq!((b2.meta.stage, build_status(&b2)), (Stage::Mist, Some("blocked")), "blocked leaves the stage alone");
        let data = ws.load_project(&slug).unwrap();
        let q = data.cards.iter().find(|c| c.meta.role.as_deref() == Some(crate::model::ROLE_CC_QUESTIONS)).expect("questions card");
        assert!(q.meta.items[0].text.contains("Blocked: Net") && q.meta.items[0].text.contains("physics decision"));
        let new = data.cards.iter().find(|c| c.meta.title == "Fish radio").unwrap();
        assert!(new.meta.ghost && new.meta.stage == Stage::Built && new.meta.source == Source::Claude);
        assert!(snapshot_path(&ws.project_dir(&slug).unwrap(), &new.meta.id).unwrap().is_file());
        let frames = ws.card_frames(&slug).unwrap();
        assert_eq!(frames.get(&new.meta.id).map(String::as_str), Some(FRAME_TITLE));
        // Nothing changed: nothing happens.
        assert!(!ws.sync_status(&slug).unwrap().changed());
        // Dismiss the ghost (trash), then change the entry's notes: it does not come back.
        ws.trash_card(&slug, &new.meta.id, "dismissed").unwrap();
        fs::write(&status, fs::read_to_string(&status).unwrap().replace("plays shanties", "plays more shanties")).unwrap();
        let r = ws.sync_status(&slug).unwrap();
        assert!(r.new.is_empty());
        assert!(!ws.load_project(&slug).unwrap().cards.iter().any(|c| c.meta.title == "Fish radio"));
        // A dirty built card is rebuilt only when the commits change.
        ws.update_card(&slug, &a.meta.id, CardPatch { body: Some("a long rod".into()), ..Default::default() }).unwrap();
        assert!(is_dirty(&ws.read_card(&slug, &a.meta.id).unwrap()));
        fs::write(&status, fs::read_to_string(&status).unwrap().replace("src/rod.ts", "src/rod.ts, src/reel.ts")).unwrap();
        ws.sync_status(&slug).unwrap();
        assert!(is_dirty(&ws.read_card(&slug, &a.meta.id).unwrap()), "same commits: still needs a rebuild");
        fs::write(&status, fs::read_to_string(&status).unwrap().replace("abc123", "abc123, def456")).unwrap();
        ws.sync_status(&slug).unwrap();
        assert!(!is_dirty(&ws.read_card(&slug, &a.meta.id).unwrap()), "new commits: rebuilt");
    }

    #[test]
    fn partial_and_in_progress_set_status_without_over_claiming() {
        let (_d, ws, slug, repo) = setup();
        let a = card(&ws, &slug, "Harpoon", "a rod");
        let b = card(&ws, &slug, "Net", "a net");
        fs::write(repo.join(STATUS_REL), format!("## {} · Harpoon\nstatus: partial\n## {} · Net\nstatus: in-progress\n", a.meta.id, b.meta.id)).unwrap();
        let r = ws.sync_status(&slug).unwrap();
        assert_eq!((r.partial.len(), r.in_progress.len()), (1, 1));
        let a2 = ws.read_card(&slug, &a.meta.id).unwrap();
        assert_eq!((a2.meta.stage, build_status(&a2), is_dirty(&a2)), (Stage::Built, Some("partial"), false));
        let b2 = ws.read_card(&slug, &b.meta.id).unwrap();
        assert_eq!((b2.meta.stage, build_status(&b2)), (Stage::Mist, Some("in-progress")));
        assert!(!ws.project_dir(&slug).unwrap().join(format!("cards/{}.built.md", b.meta.id)).exists());
    }

    #[test]
    fn link_json_lists_the_open_version_and_is_only_rewritten_on_change() {
        let (_d, ws, slug, repo) = setup();
        let a = card(&ws, &slug, "Harpoon", "a rod");
        ws.update_card(&slug, &a.meta.id, CardPatch { tags: Some(vec!["gear".into()]), ..Default::default() }).unwrap();
        built(&ws, &slug, &a.meta.id);
        card(&ws, &slug, "Net", "a net");
        // A ghost and a sticky are not cards Claude Code should reference.
        ws.create_card(&slug, NewCard { title: Some("Maybe".into()), ghost: Some(true), ..Default::default() }).unwrap();
        ws.create_card(&slug, NewCard { title: Some("Note".into()), kind: Some(CardKind::Sticky), ..Default::default() }).unwrap();
        assert!(ws.write_link(&slug).unwrap());
        let path = repo.join(".dreamer/link.json");
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((v["dreamer"].as_i64(), v["project"]["slug"].as_str(), v["project"]["name"].as_str()), (Some(1), Some(slug.as_str()), Some("Fish")));
        assert_eq!((v["status_file"].as_str(), v["tasks_dir"].as_str(), v["outbox"].as_str()), (Some("docs/design/STATUS.md"), Some("docs/design/tasks"), Some(".dreamer/outbox")));
        assert_eq!(v["tags"], json!(["gear"]));
        let ver = ws.open_version(&slug).unwrap().unwrap();
        assert_eq!((v["version"]["id"].as_str(), v["version"]["title"].as_str()), (Some(ver.id.as_str()), Some(ver.title.as_str())));
        assert_eq!(v["versions"], json!([ver.title]));
        let cards = v["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 2);
        let rod = cards.iter().find(|c| c["title"] == "Harpoon").unwrap();
        assert_eq!((rod["stage"].as_str(), rod["build_status"].as_str(), rod["dirty"].as_bool()), (Some("built"), Some("built"), Some(false)));
        let net = cards.iter().find(|c| c["title"] == "Net").unwrap();
        assert!(net["build_status"].is_null() && net["frame"].is_null());
        assert!(!ws.write_link(&slug).unwrap(), "unchanged: not rewritten");
        // Another version's cards stay out; an edit shows as dirty.
        ws.update_card(&slug, &a.meta.id, CardPatch { body: Some("changed".into()), ..Default::default() }).unwrap();
        assert!(ws.write_link(&slug).unwrap());
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["cards"].as_array().unwrap().iter().find(|c| c["title"] == "Harpoon").unwrap()["dirty"], true);
        ws.new_version(&slug, &ver.id, "v2").unwrap();
        ws.write_link(&slug).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((v["version"]["title"].as_str(), v["versions"].as_array().unwrap().len(), v["cards"].as_array().unwrap().len()), (Some("v2"), 2, 2));
    }

    #[test]
    fn gitignore_is_added_once_and_keeps_line_endings() {
        let d = TempDir::new().unwrap();
        assert!(gitignore_add(d.path()).unwrap());
        assert_eq!(fs::read_to_string(d.path().join(".gitignore")).unwrap(), ".dreamer/\n");
        assert!(!gitignore_add(d.path()).unwrap());
        fs::write(d.path().join(".gitignore"), "target\r\n/.dreamer").unwrap();
        assert!(!gitignore_add(d.path()).unwrap());
        fs::write(d.path().join(".gitignore"), "target\r\nnode_modules").unwrap();
        assert!(gitignore_add(d.path()).unwrap());
        assert_eq!(fs::read_to_string(d.path().join(".gitignore")).unwrap(), "target\r\nnode_modules\r\n.dreamer/\r\n");
    }

    #[test]
    fn restore_build_puts_the_card_back() {
        let (_d, ws, slug, _) = setup();
        let c = card(&ws, &slug, "Rod", "a rod");
        let before = ws.read_card(&slug, &c.meta.id).unwrap();
        let after = ws.mark_built_now(&slug, &c.meta.id).unwrap();
        assert_eq!(after.meta.stage, Stage::Built);
        let back = ws.restore_build(&slug, &c.meta.id, None, None, before.meta.stage).unwrap();
        assert!(back.meta.stage == Stage::Mist && !back.meta.extra.contains_key("build"));
        assert!(ws.built_texts(&slug, &c.meta.id).unwrap().0.is_none());
    }
}

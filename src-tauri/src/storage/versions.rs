//! Project versions: top-level folders with `kind: "version"` in folders.json. The root canvas
//! holds only version nodes; ordinary folders live inside a version. A new version is a copy of
//! another (new ids, `origin` lineage on every card); the one-time migration turns an older flat
//! project into versions.

use super::*;
use std::collections::HashMap;

/// The top-level version a folder sits in (itself when it is one).
pub fn top_version(folders: &[Folder], id: &str) -> Option<String> {
    let mut cur = Some(id.to_string());
    for _ in 0..=folders.len() {
        let f = folders.iter().find(|f| Some(&f.id) == cur.as_ref())?;
        if f.parent.is_none() {
            return f.is_version().then(|| f.id.clone());
        }
        cur = f.parent.clone();
    }
    None
}

/// Version folders, oldest first.
pub fn versions_of(folders: &[Folder]) -> Vec<&Folder> {
    let mut v: Vec<&Folder> = folders.iter().filter(|f| f.is_version()).collect();
    v.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)));
    v
}

/// "v1", "V 2", "Version 3", "Alpha", "beta-2", "MVP"…: titles that read as a version.
pub fn looks_like_version(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    let rest_is_num = |r: &str| {
        let r = r.trim_start_matches([' ', '-', '_', '.']);
        !r.is_empty() && r.chars().all(|c| c.is_ascii_digit() || c == '.')
    };
    if let Some(r) = t.strip_prefix("version") {
        return r.trim().is_empty() || rest_is_num(r);
    }
    if let Some(r) = t.strip_prefix('v') {
        if rest_is_num(r) {
            return true;
        }
    }
    ["alpha", "beta", "gamma", "rc", "mvp", "prototype", "demo", "release"]
        .iter()
        .any(|w| t == *w || t.strip_prefix(w).is_some_and(|r| r.trim().is_empty() || rest_is_num(r)))
}

/// The version title appears in `text` as a whole word (case-insensitive).
pub fn mentions(text: &str, title: &str) -> bool {
    let (t, w) = (text.to_lowercase(), title.trim().to_lowercase());
    if w.is_empty() {
        return false;
    }
    let word = |c: char| c.is_alphanumeric() || c == '_';
    t.match_indices(&w).any(|(i, _)| {
        let before = t[..i].chars().next_back();
        let after = t[i + w.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

fn new_folder_id() -> String {
    format!("fd{}", ulid::Ulid::generate().to_string().to_lowercase())
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let p = e.path();
        let to = dst.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &to)?;
        } else {
            fs::copy(&p, &to)?;
        }
    }
    Ok(())
}

/// Right edge and top of everything on a canvas (None when empty).
fn right_edge(c: &Canvas) -> Option<(f64, f64)> {
    let boxes = c
        .cards
        .values()
        .map(|p| (p.x, p.y, p.w.unwrap_or(236.0)))
        .chain(c.folders.values().map(|p| (p.x, p.y, p.w.unwrap_or(220.0))))
        .chain(c.frames.values().map(|f| (f.x, f.y, f.w)));
    boxes.fold(None, |acc, (x, y, w)| match acc {
        None => Some((x + w, y)),
        Some((r, t)) => Some((r.max(x + w), t.min(y))),
    })
}

fn left_top(c: &Canvas) -> Option<(f64, f64)> {
    let pts = c.cards.values().map(|p| (p.x, p.y)).chain(c.folders.values().map(|p| (p.x, p.y))).chain(c.frames.values().map(|f| (f.x, f.y)));
    pts.fold(None, |acc, (x, y)| Some(acc.map_or((x, y), |(a, b): (f64, f64)| (a.min(x), b.min(y)))))
}

impl Workspace {
    /// The open version of a project dir: `last_version` when it is a version, else the newest.
    pub(crate) fn open_version_in(dir: &Path, folders: &[Folder]) -> Option<Folder> {
        let meta = read_json_or_default_meta(&dir.join("project.json"), "").ok()?;
        let vs = versions_of(folders);
        meta.last_version.as_deref().and_then(|id| vs.iter().find(|f| f.id == id)).or(vs.last()).map(|f| (*f).clone())
    }

    pub fn open_version(&self, slug: &str) -> Result<Option<Folder>> {
        let dir = self.existing_project_dir(slug)?;
        Ok(Self::open_version_in(&dir, &Self::read_folders(&dir)?))
    }

    /// Versions, oldest first.
    pub fn list_versions(&self, slug: &str) -> Result<Vec<Folder>> {
        Ok(versions_of(&self.folders(slug)?).into_iter().cloned().collect())
    }

    /// Card id -> the version it is in (cards outside any version are left out).
    pub(crate) fn card_versions_in(dir: &Path) -> Result<HashMap<String, String>> {
        let folders = Self::read_folders(dir)?;
        let mut out = HashMap::new();
        for f in &folders {
            let Some(v) = top_version(&folders, &f.id) else { continue };
            for id in Self::read_canvas_at(dir, Some(&f.id))?.cards.into_keys() {
                out.entry(id).or_insert_with(|| v.clone());
            }
        }
        Ok(out)
    }

    pub fn card_versions(&self, slug: &str) -> Result<HashMap<String, String>> {
        Self::card_versions_in(&self.existing_project_dir(slug)?)
    }

    /// A version by id or title (case-insensitive).
    pub fn resolve_version(&self, slug: &str, key: &str) -> Result<Folder> {
        let k = key.trim();
        self.list_versions(slug)?
            .into_iter()
            .find(|f| f.id == k || f.title.trim().eq_ignore_ascii_case(k))
            .ok_or_else(|| AppError::NotFound(format!("version {k:?}")))
    }

    /// Copies what the migration rewrites (and the cards, for safety) to `<project>/.backup-<date>/`.
    /// A backup already made that day is kept as it is.
    pub(crate) fn backup_project(dir: &Path) -> Result<PathBuf> {
        let b = dir.join(format!(".backup-{}", chrono::Local::now().format("%Y-%m-%d")));
        if b.exists() {
            return Ok(b);
        }
        let io = |e: std::io::Error| AppError::io(format!("back up the project to {}", b.display()), e);
        fs::create_dir_all(&b).map_err(io)?;
        for f in ["project.json", "folders.json", "canvas.json"] {
            if dir.join(f).is_file() {
                fs::copy(dir.join(f), b.join(f)).map_err(io)?;
            }
        }
        for d in ["canvases", "cards"] {
            if dir.join(d).is_dir() {
                copy_dir(&dir.join(d), &b.join(d)).map_err(io)?;
            }
        }
        if dir.join("trash/trash.json").is_file() {
            fs::create_dir_all(b.join("trash")).map_err(io)?;
            fs::copy(dir.join("trash/trash.json"), b.join("trash/trash.json")).map_err(io)?;
        }
        let design = dir.join("design");
        if design.join("index.json").is_file() {
            fs::create_dir_all(b.join("design")).map_err(io)?;
            fs::copy(design.join("index.json"), b.join("design/index.json")).map_err(io)?;
        }
        if let Ok(rd) = fs::read_dir(&design) {
            for e in rd.flatten().filter(|e| e.path().join("manifest.json").is_file()) {
                let to = b.join("design").join(e.file_name());
                fs::create_dir_all(&to).map_err(io)?;
                fs::copy(e.path().join("manifest.json"), to.join("manifest.json")).map_err(io)?;
            }
        }
        Ok(b)
    }

    /// What the one-time "Treat these folders as versions?" dialog lists: the root's top-level
    /// folders (none are versions yet), each with a suggestion. None when there is nothing to ask.
    pub(crate) fn pending_migration(slug: &str, folders: &[Folder]) -> Option<Value> {
        if slug == INBOX_SLUG || folders.iter().any(|f| f.is_version()) {
            return None;
        }
        let top: Vec<Value> = folders
            .iter()
            .filter(|f| f.parent.is_none())
            .map(|f| serde_json::json!({ "id": f.id, "title": f.name(), "suggested": looks_like_version(&f.title) }))
            .collect();
        (!top.is_empty()).then(|| serde_json::json!({ "folders": top }))
    }

    /// The one-time migration to versions (a backup is made first). Without top-level folders the
    /// whole root goes into a new "v1" (positions kept). With them, `chosen` (from the dialog; None =
    /// not answered yet, nothing happens) become versions, and everything else at the root goes into
    /// the first chosen version, or a new "v1" when none was chosen. The handoff pack's
    /// `design/v<N>/` become revisions `design/v1/r<N>/`. True when something was migrated.
    pub fn migrate_versions(&self, slug: &str, chosen: Option<Vec<String>>) -> Result<bool> {
        if slug == INBOX_SLUG {
            return Ok(false);
        }
        let dir = self.existing_project_dir(slug)?;
        let (mut folders, _) = Self::clean_folders(Self::read_folders(&dir)?);
        if folders.iter().any(|f| f.is_version()) {
            return Ok(false);
        }
        let mut top: Vec<&Folder> = folders.iter().filter(|f| f.parent.is_none()).collect();
        top.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)));
        let top: Vec<String> = top.into_iter().map(|f| f.id.clone()).collect();
        let chosen: Vec<String> = match chosen {
            None if !top.is_empty() => return Ok(false),
            None => Vec::new(),
            Some(c) => top.iter().filter(|t| c.contains(t)).cloned().collect(),
        };
        Self::backup_project(&dir)?;
        let stamp = now();
        let mut root = Self::read_canvas(&dir)?;
        for f in folders.iter_mut().filter(|f| chosen.contains(&f.id)) {
            f.kind = Some(KIND_VERSION.into());
            f.updated = stamp.clone();
        }
        let leftover_folders: Vec<String> = top.iter().filter(|t| !chosen.contains(t)).cloned().collect();
        let mut moved = Canvas { viewport: root.viewport, cards: std::mem::take(&mut root.cards), frames: std::mem::take(&mut root.frames), ..Canvas::default() };
        for id in &leftover_folders {
            if let Some(p) = root.folders.remove(id) {
                moved.folders.insert(id.clone(), p);
            }
        }
        let (target, target_title) = match chosen.first() {
            Some(id) => {
                let mut tc = Self::read_canvas_at(&dir, Some(id))?;
                // Into an existing version: the root's things go to the right of what is there.
                let (dx, dy) = match (right_edge(&tc), left_top(&moved)) {
                    (Some((r, t)), Some((l, mt))) => (r + 120.0 - l, t - mt),
                    _ => (0.0, 0.0),
                };
                let z0 = tc.max_z();
                for (k, mut p) in moved.cards {
                    p.x += dx;
                    p.y += dy;
                    p.z = p.z.map(|z| z + z0);
                    tc.cards.insert(k, p);
                }
                for (k, mut p) in moved.folders {
                    p.x += dx;
                    p.y += dy;
                    tc.folders.insert(k, p);
                }
                for (k, mut f) in moved.frames {
                    f.x += dx;
                    f.y += dy;
                    tc.frames.insert(k, f);
                }
                Self::write_canvas(&dir, Some(id), &tc)?;
                (id.clone(), folders.iter().find(|f| &f.id == id).map(Folder::name).unwrap_or_default())
            }
            None => {
                let id = new_folder_id();
                folders.push(Folder { id: id.clone(), title: "v1".into(), parent: None, created: stamp.clone(), updated: stamp.clone(), kind: Some(KIND_VERSION.into()), ..Default::default() });
                Self::write_canvas(&dir, Some(&id), &moved)?;
                (id, "v1".to_string())
            }
        };
        for f in folders.iter_mut().filter(|f| leftover_folders.contains(&f.id)) {
            f.parent = Some(target.clone());
        }
        if !root.folders.contains_key(&target) {
            let p = Self::next_free_pos(&root);
            root.folders.insert(target.clone(), p);
        }
        Self::write_canvas(&dir, None, &root)?;
        Self::write_folders(&dir, &folders)?;
        let mut meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
        meta.last_version = versions_of(&folders).last().map(|f| f.id.clone());
        write_json(&dir.join("project.json"), &meta)?;
        crate::handoff::migrate_design(&dir, &target, &target_title)?;
        Ok(true)
    }

    /// A new, empty project starts with version "v1".
    pub(crate) fn first_version(dir: &Path) -> Result<()> {
        let stamp = now();
        let id = new_folder_id();
        let f = Folder { id: id.clone(), title: "v1".into(), parent: None, created: stamp.clone(), updated: stamp, kind: Some(KIND_VERSION.into()), ..Default::default() };
        Self::write_canvas(dir, Some(&id), &Canvas { viewport: Viewport { x: 300.0, y: 110.0, zoom: 1.0 }, ..Canvas::default() })?;
        Self::write_folders(dir, &[f])?;
        let mut root = Self::read_canvas(dir)?;
        root.folders.insert(id.clone(), Pos::at(0.0, 0.0));
        Self::write_canvas(dir, None, &root)?;
        let mut meta = read_json_or_default_meta(&dir.join("project.json"), "")?;
        meta.last_version = Some(id);
        write_json(&dir.join("project.json"), &meta)
    }

    /// "New version from <from>": copies that version's canvases, frames, nested folders and kept
    /// cards (new ids, `origin` set, links remapped, attachments pointing at the same media files,
    /// variants and artifact files copied) in one go. Ghosts, proposals, chat threads and trash are
    /// not copied. The card files and canvases are written first; folders.json is the commit
    /// point, and a failure before it removes everything written. Opens the new version.
    /// Returns `{ version, cards: {old: new} }`.
    pub fn new_version(&self, slug: &str, from: &str, title: &str) -> Result<Value> {
        let dir = self.existing_project_dir(slug)?;
        let mut folders = Self::read_folders(&dir)?;
        if !folders.iter().any(|f| f.id == from && f.is_version()) {
            return Err(AppError::NotFound(format!("version {from}")));
        }
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 80 {
            return Err(AppError::Invalid("a version needs a name (up to 80 characters)".into()));
        }
        if folders.iter().any(|f| f.is_version() && f.title.trim().eq_ignore_ascii_case(title)) {
            return Err(AppError::Invalid(format!("there is already a version named “{title}”")));
        }
        let sub = Self::subtree(&folders, from);
        let fmap: BTreeMap<String, String> = sub.iter().map(|id| (id.clone(), new_folder_id())).collect();
        let canvases: BTreeMap<String, Canvas> = sub.iter().map(|id| Ok((id.clone(), Self::read_canvas_at(&dir, Some(id))?))).collect::<Result<_>>()?;
        let (cards, _) = Self::list_cards_in(&dir);
        let by_id: HashMap<&str, &Card> = cards.iter().map(|c| (c.meta.id.as_str(), c)).collect();
        let mut cmap: BTreeMap<String, String> = BTreeMap::new();
        for c in canvases.values() {
            for id in c.cards.keys() {
                if by_id.get(id.as_str()).is_some_and(|c| !c.meta.ghost) {
                    cmap.insert(id.clone(), ulid::Ulid::generate().to_string());
                }
            }
        }
        let stamp = now();
        let mut written: Vec<PathBuf> = Vec::new();
        let res = (|| -> Result<()> {
            for (old, new) in &cmap {
                let mut c = by_id[old.as_str()].clone();
                c.meta.id = new.clone();
                c.meta.origin = Some(Origin { card: old.clone(), version: from.to_string() });
                for l in &mut c.meta.links {
                    if let Some(n) = cmap.get(&l.to) {
                        l.to = n.clone();
                    }
                }
                for a in &mut c.meta.attachments {
                    a.set_id(ulid::Ulid::generate().to_string());
                }
                if let Some(Value::Object(b)) = &mut c.meta.branch {
                    if let Some(n) = b.get("of").and_then(Value::as_str).and_then(|o| cmap.get(o)) {
                        b.insert("of".into(), Value::String(n.clone()));
                    }
                }
                c.meta.extra.remove("merged_from");
                c.meta.created = stamp.clone();
                c.meta.updated = stamp.clone();
                let path = Self::card_path(&dir, new)?;
                written.push(path.clone());
                Self::write_card_file(&path, &c)?;
                // The copy keeps its build snapshot, so "Needs rebuild" carries over.
                let snap = dir.join("cards").join(format!("{old}.built.md"));
                if snap.is_file() {
                    let to = dir.join("cards").join(format!("{new}.built.md"));
                    written.push(to.clone());
                    fs::copy(&snap, &to).map_err(|e| AppError::io("copy the build snapshot", e))?;
                }
                let variants = dir.join("cards").join(format!("{old}.variants"));
                if variants.is_dir() {
                    let to = dir.join("cards").join(format!("{new}.variants"));
                    written.push(to.clone());
                    copy_dir(&variants, &to).map_err(|e| AppError::io("copy variants", e))?;
                }
                let art = dir.join("artifacts").join(old);
                if c.meta.kind == CardKind::Artifact && art.is_dir() {
                    let to = dir.join("artifacts").join(new);
                    written.push(to.clone());
                    copy_dir(&art, &to).map_err(|e| AppError::io("copy the artifact's files", e))?;
                    let meta = to.join("artifact.json");
                    if let Some(mut v) = fs::read_to_string(&meta).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                        for k in ["id", "source_card", "sourceCard"] {
                            if let Some(n) = v.get(k).and_then(Value::as_str).and_then(|o| if o == old { Some(new.clone()) } else { cmap.get(o).cloned() }) {
                                v[k] = Value::String(n);
                            }
                        }
                        write_json(&meta, &v)?;
                    }
                }
            }
            for (old_f, c) in &canvases {
                let mut n = Canvas { viewport: c.viewport, ..Canvas::default() };
                for (id, p) in &c.cards {
                    if let Some(new) = cmap.get(id) {
                        n.cards.insert(new.clone(), *p);
                    }
                }
                for (id, p) in &c.folders {
                    if let Some(new) = fmap.get(id) {
                        n.folders.insert(new.clone(), *p);
                    }
                }
                for f in c.frames.values() {
                    n.frames.insert(format!("f{}", ulid::Ulid::generate().to_string().to_lowercase()), f.clone());
                }
                let path = Self::canvas_path(&dir, Some(&fmap[old_f]))?;
                written.push(path.clone());
                write_json(&path, &n)?;
            }
            let mut add: Vec<Folder> = Vec::new();
            for f in folders.iter().filter(|f| sub.contains(&f.id)) {
                let mut n = f.clone();
                n.id = fmap[&f.id].clone();
                n.parent = f.parent.as_ref().and_then(|p| fmap.get(p).cloned());
                n.created = stamp.clone();
                n.updated = stamp.clone();
                if f.id == from {
                    n.title = title.to_string();
                    n.kind = Some(KIND_VERSION.into());
                    n.created_from = Some(from.to_string());
                    n.parent = None;
                }
                add.push(n);
            }
            let new_id = fmap[from].clone();
            folders.extend(add);
            Self::write_folders(&dir, &folders)?;
            // Committed. The node goes to the right of the version nodes already on the root.
            let mut root = Self::read_canvas(&dir)?;
            let (x, y) = root.folders.values().fold(None, |acc: Option<(f64, f64)>, p| Some(acc.map_or((p.x, p.y), |(x, y)| (x.max(p.x), y.min(p.y))))).map(|(x, y)| (x + 220.0 + 60.0, y)).unwrap_or((0.0, 0.0));
            root.folders.insert(new_id.clone(), Pos::at(x, y));
            Self::write_canvas(&dir, None, &root)?;
            let mut meta = read_json_or_default_meta(&dir.join("project.json"), slug)?;
            meta.last_version = Some(new_id);
            write_json(&dir.join("project.json"), &meta)
        })();
        if let Err(e) = res {
            for p in written {
                let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            }
            return Err(e);
        }
        let version = folders.iter().find(|f| f.id == fmap[from]).cloned();
        Ok(serde_json::json!({ "version": version, "cards": cmap }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ws() -> (TempDir, Workspace) {
        let d = TempDir::new().unwrap();
        let ws = Workspace::open(d.path().join("Dreamer")).unwrap();
        (d, ws)
    }

    fn card(ws: &Workspace, slug: &str, title: &str, folder: Option<&str>) -> Card {
        ws.create_card(slug, NewCard { title: Some(title.into()), folder: folder.map(str::to_string), ..Default::default() }).unwrap()
    }

    /// An older project: everything flat on the root (no versions).
    fn legacy(ws: &Workspace, name: &str) -> (String, PathBuf) {
        let p = ws.create_project(name).unwrap();
        let dir = ws.project_dir(&p.slug).unwrap();
        fs::remove_file(dir.join("folders.json")).unwrap();
        fs::remove_dir_all(dir.join("canvases")).unwrap();
        let mut meta = read_json_or_default_meta(&dir.join("project.json"), &p.slug).unwrap();
        meta.last_version = None;
        write_json(&dir.join("project.json"), &meta).unwrap();
        write_json(&dir.join("canvas.json"), &Canvas::default()).unwrap();
        (p.slug, dir)
    }

    #[test]
    fn titles_and_words() {
        for t in ["v1", "V2", "v 3", "Version 2", "version", "Alpha", "beta-2", "MVP", "v1.5"] {
            assert!(looks_like_version(t), "{t}");
        }
        for t in ["Enemies", "Visuals", "vibes", "Story beats", "alphabet"] {
            assert!(!looks_like_version(t), "{t}");
        }
        assert!(mentions("Copy that into V1 please", "v1"));
        assert!(mentions("v1, then", "v1"));
        assert!(!mentions("the v10 build", "v1"));
        assert!(!mentions("nothing here", "v1"));
    }

    #[test]
    fn new_projects_start_with_v1_and_cards_land_in_the_open_version() {
        let (_d, ws) = ws();
        let p = ws.create_project("Fresh").unwrap();
        let vs = ws.list_versions(&p.slug).unwrap();
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].title, "v1");
        let c = card(&ws, &p.slug, "A", None);
        let data = ws.load_project(&p.slug).unwrap();
        assert!(data.canvas.cards.is_empty(), "the root holds only versions");
        assert!(data.canvases[&vs[0].id].cards.contains_key(&c.meta.id));
        assert_eq!(data.meta.last_version.as_deref(), Some(vs[0].id.as_str()));
        assert!(ws.trash_folder(&p.slug, &vs[0].id).is_err(), "the only version can't be deleted");
    }

    #[test]
    fn migration_wraps_a_flat_root_into_v1_and_backs_up_first() {
        let (_d, ws) = ws();
        let (slug, dir) = legacy(&ws, "Old");
        let a = card(&ws, &slug, "A", None);
        let mut root = Workspace::read_canvas(&dir).unwrap();
        root.cards.get_mut(&a.meta.id).unwrap().x = 512.0;
        root.frames.insert("f1".into(), Frame { x: 1.0, y: 2.0, w: 300.0, h: 200.0, title: "F".into(), color: None, z: 1 });
        Workspace::write_canvas(&dir, None, &root).unwrap();
        // An old handoff pack: design/v1, design/v2.
        for n in [1, 2] {
            fs::create_dir_all(dir.join(format!("design/v{n}"))).unwrap();
            fs::write(dir.join(format!("design/v{n}/manifest.json")), format!("{{\"version\":{n}}}")).unwrap();
            fs::write(dir.join(format!("design/v{n}/00-overview.md")), "x").unwrap();
        }
        fs::write(dir.join("design/index.json"), r#"{"versions":[{"version":1},{"version":2}]}"#).unwrap();

        let data = ws.load_project(&slug).unwrap();
        assert!(data.version_migration.is_none());
        let vs = ws.list_versions(&slug).unwrap();
        assert_eq!(vs.len(), 1);
        let v1 = &vs[0];
        assert_eq!(v1.title, "v1");
        assert!(data.canvas.cards.is_empty() && data.canvas.frames.is_empty());
        assert_eq!(data.canvases[&v1.id].cards[&a.meta.id].x, 512.0, "positions kept");
        assert!(data.canvases[&v1.id].frames.contains_key("f1"));
        let backup = fs::read_dir(&dir).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with(".backup-")).unwrap().path();
        assert!(backup.join(format!("cards/{}.md", a.meta.id)).is_file());
        assert!(backup.join("canvas.json").is_file() && backup.join("design/index.json").is_file());
        // Handoff: design/v<N> -> design/v1/r<N>.
        assert!(dir.join("design/v1/r1/00-overview.md").is_file() && dir.join("design/v1/r2/manifest.json").is_file());
        assert!(!dir.join("design/v2").exists());
        let idx = crate::handoff::read_index(&dir);
        assert!(idx.versions.iter().all(|e| e.dir == "v1" && e.version_id == v1.id));
        let m: Value = serde_json::from_str(&fs::read_to_string(dir.join("design/v1/r2/manifest.json")).unwrap()).unwrap();
        assert_eq!((m["revision"].clone(), m["project_version"]["title"].clone()), (serde_json::json!(2), serde_json::json!("v1")));
        // Once only.
        assert!(!ws.migrate_versions(&slug, None).unwrap());
    }

    #[test]
    fn migration_with_folders_waits_for_the_dialog() {
        let (_d, ws) = ws();
        let (slug, dir) = legacy(&ws, "Folders");
        let stamp = now();
        let fold = |id: &str, title: &str, created: &str| Folder { id: id.into(), title: title.into(), parent: None, created: created.into(), updated: stamp.clone(), ..Default::default() };
        Workspace::write_folders(&dir, &[fold("fa", "V1", "2020-01-01"), fold("fb", "Version 2", "2020-02-01"), fold("fc", "Enemies", "2020-03-01")]).unwrap();
        let loose = card(&ws, &slug, "Loose", None);
        let inside = card(&ws, &slug, "In v2", Some("fb"));
        let data = ws.load_project(&slug).unwrap();
        let pending = data.version_migration.expect("asks");
        let sugg: Vec<bool> = pending["folders"].as_array().unwrap().iter().map(|f| f["suggested"].as_bool().unwrap()).collect();
        assert_eq!(sugg, vec![true, true, false]);
        assert!(ws.list_versions(&slug).unwrap().is_empty(), "nothing happens before the answer");

        assert!(ws.migrate_versions(&slug, Some(vec!["fb".into(), "fa".into()])).unwrap());
        let data = ws.load_project(&slug).unwrap();
        let vs: Vec<String> = ws.list_versions(&slug).unwrap().into_iter().map(|f| f.id).collect();
        assert_eq!(vs, vec!["fa", "fb"]);
        // Leftovers (the loose card and the unchecked folder) go into the first checked version.
        assert!(data.canvases["fa"].cards.contains_key(&loose.meta.id));
        assert!(data.canvases["fa"].folders.contains_key("fc"));
        assert_eq!(data.folders.iter().find(|f| f.id == "fc").unwrap().parent.as_deref(), Some("fa"));
        assert!(data.canvases["fb"].cards.contains_key(&inside.meta.id));
        assert_eq!(data.canvas.folders.keys().cloned().collect::<Vec<_>>(), vec!["fa", "fb"]);
        assert_eq!(data.meta.last_version.as_deref(), Some("fb"), "the newest opens");
    }

    #[test]
    fn new_version_copies_with_lineage_and_remapped_links() {
        let (_d, ws) = ws();
        let p = ws.create_project("Copy").unwrap();
        let slug = p.slug;
        let v1 = ws.list_versions(&slug).unwrap().remove(0);
        let dir = ws.project_dir(&slug).unwrap();
        // A nested folder with a card, a frame, an image, a link, a role card, a ghost and a proposal.
        let mut folders = Workspace::read_folders(&dir).unwrap();
        folders.push(Folder { id: "fdsub".into(), title: "Sub".into(), parent: Some(v1.id.clone()), created: now(), updated: now(), ..Default::default() });
        Workspace::write_folders(&dir, &folders).unwrap();
        let b = card(&ws, &slug, "B", Some("fdsub"));
        let a = ws
            .create_card(&slug, NewCard {
                title: Some("A".into()),
                links: Some(vec![Link { to: b.meta.id.clone(), label: None }, Link { to: "01ELSEWHERE".into(), label: None }]),
                attachments: Some(vec![Attachment::Image { id: "i1".into(), path: "media/x.png".into(), caption: None }]),
                role: Some("tech".into()),
                ..Default::default()
            })
            .unwrap();
        fs::write(dir.join("media/x.png"), b"png").unwrap();
        let ghost = ws.create_card(&slug, NewCard { title: Some("G".into()), ghost: Some(true), ..Default::default() }).unwrap();
        ws.write_proposal(&slug, &a.meta.id, &serde_json::json!({ "title": "x" })).unwrap();
        let mut c1 = Workspace::read_canvas_at(&dir, Some(&v1.id)).unwrap();
        c1.frames.insert("f1".into(), Frame { x: 0.0, y: 0.0, w: 500.0, h: 400.0, title: "Core".into(), color: None, z: 1 });
        Workspace::write_canvas(&dir, Some(&v1.id), &c1).unwrap();

        assert!(ws.new_version(&slug, &v1.id, " V1 ").is_err(), "names are unique");
        let out = ws.new_version(&slug, &v1.id, "v2").unwrap();
        let v2 = out["version"]["id"].as_str().unwrap().to_string();
        let map: BTreeMap<String, String> = serde_json::from_value(out["cards"].clone()).unwrap();
        assert_eq!(map.len(), 2, "ghosts are not copied");
        assert!(!map.contains_key(&ghost.meta.id));
        let data = ws.load_project(&slug).unwrap();
        assert_eq!(data.meta.last_version.as_deref(), Some(v2.as_str()));
        let v2f = data.folders.iter().find(|f| f.id == v2).unwrap();
        assert!(v2f.is_version() && v2f.created_from.as_deref() == Some(v1.id.as_str()));
        let na = data.cards.iter().find(|c| c.meta.id == map[&a.meta.id]).unwrap();
        assert_eq!(na.meta.origin, Some(Origin { card: a.meta.id.clone(), version: v1.id.clone() }));
        assert_eq!(na.meta.links[0].to, map[&b.meta.id], "links inside the version follow the copy");
        assert_eq!(na.meta.links[1].to, "01ELSEWHERE");
        assert_eq!(na.meta.role.as_deref(), Some("tech"), "roles are per version");
        assert_eq!(na.meta.attachments[0].key(), "media/x.png");
        assert!(data.proposals.get(&na.meta.id).is_none());
        let sub2 = data.folders.iter().find(|f| f.parent.as_deref() == Some(v2.as_str())).unwrap();
        assert_eq!(sub2.title, "Sub");
        assert!(data.canvases[&sub2.id].cards.contains_key(&map[&b.meta.id]));
        assert_eq!(data.canvases[&v2].frames.len(), 1);
        assert!(!data.canvases[&v2].frames.contains_key("f1"), "frames get new ids");
        assert!(data.canvas.folders.contains_key(&v2));
        let versions = ws.card_versions(&slug).unwrap();
        assert_eq!(versions[&map[&b.meta.id]], v2);
        assert_eq!(versions[&b.meta.id], v1.id);

        // Deleting the copy (and emptying the Trash) never breaks v1's media.
        ws.delete_card(&slug, &na.meta.id).unwrap();
        ws.empty_trash(&slug).unwrap();
        assert!(dir.join("media/x.png").is_file(), "still used by v1");
        ws.delete_card(&slug, &a.meta.id).unwrap();
        ws.empty_trash(&slug).unwrap();
        assert!(!dir.join("media/x.png").exists(), "gone once no version uses it");

        // Undo of "new version" = the version to Trash; restoring brings it back whole.
        ws.trash_folder(&slug, &v2).unwrap();
        assert_eq!(ws.list_versions(&slug).unwrap().len(), 1);
        ws.restore_item(&slug, &v2).unwrap();
        assert!(ws.load_project(&slug).unwrap().canvases[&sub2.id].cards.contains_key(&map[&b.meta.id]));
    }

    #[test]
    fn new_version_from_a_copy_chains_origin() {
        let (_d, ws) = ws();
        let slug = ws.create_project("Chain").unwrap().slug;
        let v1 = ws.list_versions(&slug).unwrap().remove(0);
        let a = card(&ws, &slug, "A", None);
        let v2 = ws.new_version(&slug, &v1.id, "v2").unwrap()["version"]["id"].as_str().unwrap().to_string();
        let a2 = ws.card_versions(&slug).unwrap().into_iter().find(|(_, v)| *v == v2).unwrap().0;
        let out = ws.new_version(&slug, &v2, "v3").unwrap();
        let a3: String = out["cards"][&a2].as_str().unwrap().into();
        assert_eq!(ws.read_card(&slug, &a3).unwrap().meta.origin.unwrap().card, a2);
        assert_eq!(ws.read_card(&slug, &a2).unwrap().meta.origin.unwrap().card, a.meta.id);
    }
}

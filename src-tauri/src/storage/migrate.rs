//! The one-time move to layout 2: one canvas per project. Runs at workspace load while
//! workspace.json has no `"layout": 2`. A full backup comes first; then the Inbox becomes an
//! ordinary project, a project's open version becomes its canvas (other versions go to
//! `archive/versions/<title>/` as they are), and every folder becomes a frame. Every step can run
//! again after a crash: the original root canvas is kept in `canvases/.layout1-root.json` until
//! the project is done, and files are copied before originals are removed. Step f (`strip_cards`)
//! also runs on workspaces already at layout 2.

use super::*;
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub const LAYOUT: u64 = 2;
const PAD: f64 = 40.0;
const GAP: f64 = 120.0;
// Mirror CARD_W / CARD_H in src/components/cardGeometry.ts.
const CARD_W: f64 = 236.0;
const CARD_H: f64 = 150.0;
const ORIG_ROOT: &str = ".layout1-root.json";

type Rect = (f64, f64, f64, f64);

#[derive(Deserialize, Clone, Default)]
struct OldFolder {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    created: String,
    #[serde(default)]
    kind: Option<String>,
}

impl OldFolder {
    fn name(&self) -> String {
        if self.title.trim().is_empty() { "Untitled folder".into() } else { self.title.trim().to_string() }
    }
}

#[derive(Deserialize, Default)]
struct Tiles {
    #[serde(default)]
    folders: BTreeMap<String, Pos>,
}

/// A folder laid out in its own coordinates: its frame's top-left is (0, 0).
struct Block {
    w: f64,
    h: f64,
    cards: Vec<(String, Pos)>,
    frames: Vec<Frame>,
}

fn io_err(what: &str, p: &Path, e: std::io::Error) -> String {
    format!("{what} {}: {e}", p.display())
}

fn read_value(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
}

fn write_value(path: &Path, v: &Value) -> std::result::Result<(), String> {
    write_json(path, v).map_err(|e| e.to_string())
}

/// A layout-1 canvas file: the canvas plus its folder tiles. Missing or unreadable = empty.
fn read_old(path: &Path) -> (Canvas, Tiles) {
    let v = read_value(path).unwrap_or(Value::Null);
    let mut c: Canvas = serde_json::from_value(v.clone()).unwrap_or_default();
    c.sanitize();
    (c, serde_json::from_value(v).unwrap_or_default())
}

/// Copies a tree; at the top level, names for which `skip` is true are left out.
fn copy_tree(src: &Path, dst: &Path, skip: &dyn Fn(&str) -> bool) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if skip(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            copy_tree(&p, &dst.join(&name), &|_| false)?;
        } else {
            fs::copy(&p, dst.join(&name))?;
        }
    }
    Ok(())
}

fn copy_any(src: &Path, dst: &Path) -> std::result::Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(p) = dst.parent() {
        fs::create_dir_all(p).map_err(|e| io_err("create", p, e))?;
    }
    let r = if src.is_dir() { copy_tree(src, dst, &|_| false) } else { fs::copy(src, dst).map(|_| ()) };
    r.map_err(|e| io_err("copy", src, e))
}

fn remove_any(p: &Path) -> std::result::Result<(), String> {
    let r = if p.is_dir() { retry_io(|| fs::remove_dir_all(p)) } else if p.exists() { retry_io(|| fs::remove_file(p)) } else { Ok(()) };
    r.map_err(|e| io_err("remove", p, e))
}

fn walk_files(d: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk_files(&p, out);
            } else {
                out.push(p);
            }
        }
    }
}

fn card_rect(p: &Pos) -> Rect {
    (p.x, p.y, p.w.unwrap_or(CARD_W), p.h.unwrap_or(CARD_H))
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

/// (min x, min y, max x, max y) of the rects.
fn bounds(rs: &[Rect]) -> Option<(f64, f64, f64, f64)> {
    rs.iter().fold(None, |acc, r| {
        let (x0, y0, x1, y1) = (r.0, r.1, r.0 + r.2, r.1 + r.3);
        Some(acc.map_or((x0, y0, x1, y1), |(a, b, c, d): (f64, f64, f64, f64)| (a.min(x0), b.min(y0), c.max(x1), d.max(y1))))
    })
}

/// Places blocks among `taken`: each where its folder tile was, or (when that overlaps, or the
/// tile is unknown) in a row to the right of the content with GAP between. Returns top-lefts.
fn place(taken: &mut Vec<Rect>, kids: &[(Option<Pos>, &Block)]) -> Vec<(f64, f64)> {
    let mut row: Option<(f64, f64)> = None;
    let mut out = Vec::new();
    for (tile, b) in kids {
        let at = tile.map(|t| (t.x, t.y)).filter(|&(x, y)| !taken.iter().any(|r| overlaps(*r, (x, y, b.w, b.h))));
        let at = at.unwrap_or_else(|| {
            let (x, y) = row.unwrap_or_else(|| bounds(taken).map_or((0.0, 0.0), |(_, y0, x1, _)| (x1 + GAP, y0)));
            row = Some((x + b.w + GAP, y));
            (x, y)
        });
        taken.push((at.0, at.1, b.w, b.h));
        out.push(at);
    }
    out
}

struct Tree<'a> {
    dir: &'a Path,
    folders: &'a [OldFolder],
    /// Folder id -> parent (None = top level, also for a missing or looping parent).
    parent: HashMap<&'a str, Option<&'a str>>,
}

impl<'a> Tree<'a> {
    fn new(dir: &'a Path, folders: &'a [OldFolder]) -> Self {
        let ids: HashSet<&str> = folders.iter().map(|f| f.id.as_str()).collect();
        let raw: HashMap<&str, Option<&str>> = folders.iter().map(|f| (f.id.as_str(), f.parent.as_deref().filter(|p| ids.contains(p)))).collect();
        let parent = folders
            .iter()
            .map(|f| {
                let mut cur = raw[f.id.as_str()];
                let mut steps = 0;
                while let Some(c) = cur {
                    if c == f.id || steps > folders.len() {
                        return (f.id.as_str(), None);
                    }
                    cur = raw[c];
                    steps += 1;
                }
                (f.id.as_str(), raw[f.id.as_str()])
            })
            .collect();
        Tree { dir, folders, parent }
    }

    fn children(&self, of: Option<&str>) -> Vec<&'a OldFolder> {
        let mut v: Vec<&OldFolder> = self.folders.iter().filter(|f| self.parent.get(f.id.as_str()).copied().flatten() == of).collect();
        v.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)));
        v
    }

    fn subtree(&self, id: &str) -> Vec<&'a OldFolder> {
        let mut out: Vec<&OldFolder> = self.folders.iter().filter(|f| f.id == id).collect();
        let mut i = 0;
        while i < out.len() {
            let cur = out[i].id.as_str();
            out.extend(self.children(Some(cur)));
            i += 1;
        }
        out
    }

    fn canvas(&self, id: Option<&str>) -> (Canvas, Tiles) {
        let cdir = self.dir.join("canvases");
        read_old(&match id {
            None => cdir.join(ORIG_ROOT),
            Some(f) => cdir.join(format!("{f}.json")),
        })
    }

    /// Lays out folder `f` (path `path`) with its sub-folders as nested frames. Cards already in
    /// `seen` stay where they are; z of nested frames grows with depth.
    fn block(&self, f: &OldFolder, path: &str, z: i64, seen: &mut HashSet<String>, log: &mut Vec<String>) -> Block {
        let (c, tiles) = self.canvas(Some(&f.id));
        let cards: Vec<(String, Pos)> = c.cards.into_iter().filter(|(id, _)| seen.insert(id.clone())).collect();
        let mut taken: Vec<Rect> = cards.iter().map(|(_, p)| card_rect(p)).collect();
        let kids: Vec<(Option<Pos>, Block)> = self
            .children(Some(&f.id))
            .into_iter()
            .map(|k| (tiles.folders.get(&k.id).copied(), self.block(k, &format!("{path} / {}", k.name()), z + 1, seen, log)))
            .collect();
        let refs: Vec<(Option<Pos>, &Block)> = kids.iter().map(|(t, b)| (*t, b)).collect();
        let at = place(&mut taken, &refs);
        let (x0, y0, x1, y1) = bounds(&taken).unwrap_or((0.0, 0.0, 160.0, 80.0));
        let (ox, oy) = (PAD - x0, PAD - y0);
        let mut out = Block { w: x1 - x0 + 2.0 * PAD, h: y1 - y0 + 2.0 * PAD, cards: Vec::new(), frames: Vec::new() };
        log.push(format!("  folder \"{path}\" -> frame ({} cards)", cards.len()));
        out.frames.push(Frame { x: 0.0, y: 0.0, w: out.w, h: out.h, title: path.to_string(), color: f.color.clone(), z });
        out.cards.extend(cards.into_iter().map(|(id, mut p)| {
            p.x += ox;
            p.y += oy;
            (id, p)
        }));
        for ((bx, by), (_, k)) in at.into_iter().zip(kids) {
            out.cards.extend(k.cards.into_iter().map(|(id, mut p)| {
                p.x += bx + ox;
                p.y += by + oy;
                (id, p)
            }));
            out.frames.extend(k.frames.into_iter().map(|mut fr| {
                fr.x += bx + ox;
                fr.y += by + oy;
                fr
            }));
        }
        out
    }
}

/// A version title as a folder name (letters, digits, '-', '_', '.'; spaces become '-').
fn dir_name(title: &str) -> String {
    let s: String = title.trim().chars().map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' }).collect();
    let s = s.trim_matches(['-', '.']).chars().take(60).collect::<String>();
    if s.is_empty() { "version".into() } else { s }
}

fn free_name(taken: &HashSet<String>, base: &str) -> String {
    (1..).map(|n| if n == 1 { base.to_string() } else { format!("{base}-{n}") }).find(|n| !taken.contains(&n.to_lowercase())).unwrap()
}

/// Migrates one project dir to layout 2. A project without folders.json or canvases/ is done.
fn migrate_project(dir: &Path, log: &mut Vec<String>) -> std::result::Result<(), String> {
    let fpath = dir.join("folders.json");
    let cdir = dir.join("canvases");
    if !fpath.exists() && !cdir.exists() {
        return Ok(());
    }
    let slug = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    log.push(format!("project {slug}:"));
    // The original root canvas, kept until the project is done so a re-run starts from it.
    let orig = cdir.join(ORIG_ROOT);
    if !orig.exists() {
        fs::create_dir_all(&cdir).map_err(|e| io_err("create", &cdir, e))?;
        if dir.join("canvas.json").is_file() {
            fs::copy(dir.join("canvas.json"), &orig).map_err(|e| io_err("copy", &dir.join("canvas.json"), e))?;
        }
    }
    let raw: Vec<Value> = read_value(&fpath).and_then(|v| v.get("folders").cloned()).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let folders: Vec<OldFolder> = raw.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).filter(|f: &OldFolder| check_id(&f.id).is_ok()).collect();
    let tree = Tree::new(dir, &folders);
    let mut meta = read_value(&dir.join("project.json")).unwrap_or_else(|| json!({}));
    let versions: Vec<&OldFolder> = tree.children(None).into_iter().filter(|f| f.kind.as_deref() == Some("version")).collect();
    let last = meta.get("last_version").and_then(Value::as_str).map(str::to_string);
    let open = last.as_deref().and_then(|l| versions.iter().find(|v| v.id == l)).or(versions.last()).copied();

    // The new root: the open version's canvas (plus anything left on the old root), else the old root.
    let (mut root, root_tiles) = tree.canvas(None);
    let (top, tiles) = match open {
        Some(v) => {
            let (vc, vt) = tree.canvas(Some(&v.id));
            log.push(format!("  version \"{}\" (open) -> the project canvas", v.name()));
            root.viewport = vc.viewport;
            root.cards.extend(vc.cards);
            root.frames.extend(vc.frames);
            (tree.children(Some(&v.id)), vt)
        }
        None => (tree.children(None), root_tiles),
    };
    let mut seen: HashSet<String> = root.cards.keys().cloned().collect();
    let z0 = root.frames.values().map(|f| f.z).max().unwrap_or(0) + 1;
    let blocks: Vec<(Option<Pos>, Block)> = top.iter().map(|f| (tiles.folders.get(&f.id).copied(), tree.block(f, &f.name(), z0, &mut seen, log))).collect();
    let mut taken: Vec<Rect> = root.cards.values().map(card_rect).chain(root.frames.values().map(|f| (f.x, f.y, f.w, f.h))).collect();
    let refs: Vec<(Option<Pos>, &Block)> = blocks.iter().map(|(t, b)| (*t, b)).collect();
    let at = place(&mut taken, &refs);
    for ((bx, by), (_, b)) in at.into_iter().zip(blocks) {
        for (id, mut p) in b.cards {
            p.x += bx;
            p.y += by;
            root.cards.insert(id, p);
        }
        for mut f in b.frames {
            f.x += bx;
            f.y += by;
            root.frames.insert(format!("f{}", ulid::Ulid::generate().to_string().to_lowercase()), f);
        }
    }

    // Other versions: copied whole to archive/versions/<title>/ (originals removed below).
    let mut gone: Vec<String> = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    let (live_cards, _) = Workspace::list_cards_in(dir);
    let mut media = Vec::new();
    walk_files(&dir.join("media"), &mut media);
    for v in versions.iter().filter(|v| Some(v.id.as_str()) != open.map(|o| o.id.as_str())) {
        let name = free_name(&used, &dir_name(&v.name()));
        used.insert(name.to_lowercase());
        let adir = dir.join("archive").join("versions").join(&name);
        let sub = tree.subtree(&v.id);
        let ids: HashSet<&str> = sub.iter().map(|f| f.id.as_str()).collect();
        let mut cards: Vec<String> = Vec::new();
        for f in &sub {
            let src = cdir.join(format!("{}.json", f.id));
            let to = if f.id == v.id { adir.join("canvas.json") } else { adir.join("canvases").join(format!("{}.json", f.id)) };
            copy_any(&src, &to)?;
            for id in tree.canvas(Some(&f.id)).0.cards.into_keys() {
                if !seen.contains(&id) && !cards.contains(&id) && !gone.contains(&id) {
                    cards.push(id);
                }
            }
        }
        let subset: Vec<&Value> = raw.iter().filter(|r| r.get("id").and_then(Value::as_str).is_some_and(|i| ids.contains(i))).collect();
        write_value(&adir.join("folders.json"), &json!({ "folders": subset }))?;
        let mut text = String::new();
        for id in &cards {
            for f in [format!("{id}.md"), format!("{id}.built.md"), format!("{id}.proposal.json"), format!("{id}.variants")] {
                copy_any(&dir.join("cards").join(&f), &adir.join("cards").join(&f))?;
            }
            copy_any(&dir.join("artifacts").join(id), &adir.join("artifacts").join(id))?;
            let mut files = vec![adir.join("cards").join(format!("{id}.md"))];
            walk_files(&adir.join("cards").join(format!("{id}.variants")), &mut files);
            for p in files {
                text.push_str(&fs::read_to_string(&p).unwrap_or_default());
            }
        }
        // Media the archived cards mention: copied along (media/ keeps its own until the Trash sweep).
        for p in &media {
            let Ok(rel) = p.strip_prefix(dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if text.contains(&rel) {
                copy_any(p, &adir.join(&rel))?;
            }
        }
        log.push(format!("  version \"{}\" -> archive/versions/{name} ({} cards)", v.name(), cards.len()));
        gone.extend(cards);
    }
    let kept: HashSet<&str> = live_cards.iter().map(|c| c.meta.id.as_str()).filter(|id| !gone.iter().any(|g| g == id)).collect();
    root.cards.retain(|id, _| kept.contains(id.as_str()));

    // Trashed folders become their cards (restorable one by one onto the canvas).
    let tpath = dir.join("trash").join("trash.json");
    if let Some(mut t) = read_value(&tpath) {
        if let Some(items) = t.get_mut("items").and_then(Value::as_array_mut) {
            let mut out = Vec::new();
            for it in items.drain(..) {
                if it.get("kind").and_then(Value::as_str) != Some("folder") {
                    out.push(it);
                    continue;
                }
                let fid = it.get("id").and_then(Value::as_str).unwrap_or_default();
                let bundle = read_value(&dir.join("trash").join(format!("{fid}.folder.json"))).unwrap_or(Value::Null);
                let ids: Vec<String> = bundle.get("cards").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
                let mut n = 0;
                for c in ids {
                    let p = dir.join("trash").join(format!("{c}.md"));
                    let Some(card) = fs::read_to_string(&p).ok().and_then(|t| parse_card(&t, &c).ok()) else { continue };
                    out.push(json!({ "id": c, "title": card.meta.title, "stage": card.meta.stage, "reason": "deleted", "deleted_at": it.get("deleted_at").filter(|v| v.is_string()).cloned().unwrap_or_else(|| json!(now())), "pos": null }));
                    n += 1;
                }
                log.push(format!("  trashed folder \"{}\" -> {n} trashed cards", it.get("title").and_then(Value::as_str).unwrap_or_default()));
            }
            *items = out;
            write_value(&tpath, &t)?;
        }
    }

    root.sanitize();
    write_json(&dir.join("canvas.json"), &root).map_err(|e| e.to_string())?;
    if let Some(m) = meta.as_object_mut() {
        m.remove("last_version");
        m.remove("nudge_off");
    }
    write_value(&dir.join("project.json"), &meta)?;
    // Committed: the new canvas is written. Now the originals go.
    for id in &gone {
        for f in [format!("{id}.md"), format!("{id}.built.md"), format!("{id}.proposal.json"), format!("{id}.variants")] {
            remove_any(&dir.join("cards").join(f))?;
        }
        remove_any(&dir.join("artifacts").join(id))?;
    }
    remove_any(&fpath)?;
    remove_any(&cdir)?;
    Ok(())
}

/// Step f (idempotent; marked by `"stripped": true` in workspace.json): features that left the app
/// become plain cards. A sticky becomes a Mist card (its body is kept, its colour dropped); a
/// label becomes a Mist card titled with its text; the Claude Code questions card becomes a plain
/// checklist (role cleared, import bookkeeping dropped); build blocks and snapshots (`*.built.md`) go.
fn strip_cards(root: &Path, log: &mut Vec<String>) -> std::result::Result<(), String> {
    let wpath = root.join("workspace.json");
    let mut settings = read_value(&wpath).unwrap_or_else(|| json!({}));
    if settings.get("stripped").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let mut changed = 0;
    for pdir in fs::read_dir(root.join("projects")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        for f in fs::read_dir(pdir.join("cards")).into_iter().flatten().flatten().map(|e| e.path()) {
            let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if name.ends_with(".built.md") {
                remove_any(&f)?;
            } else if name.ends_with(".md") && !name.starts_with('.') {
                if let Ok(text) = fs::read_to_string(&f) {
                    if let Some(out) = strip_card_text(&text) {
                        atomic_write(&f, out.as_bytes()).map_err(|e| e.to_string())?;
                        changed += 1;
                    }
                }
            }
        }
    }
    log.push(format!("step f: {changed} cards converted"));
    settings["stripped"] = json!(true);
    write_value(&wpath, &settings)
}

/// The card file's text after step f, or None when nothing changes.
fn strip_card_text(text: &str) -> Option<String> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let (fm, body) = match rest.find("\n---\n") {
        Some(i) => (&rest[..i], &rest[i + 5..]),
        None => (rest.strip_suffix("\n---")?, ""),
    };
    let mut y: serde_yaml::Value = serde_yaml::from_str(fm).ok()?;
    let m = y.as_mapping_mut()?;
    let key = |k: &str| serde_yaml::Value::String(k.into());
    let kind = m.get(key("kind")).and_then(|v| v.as_str()).unwrap_or_default().trim().to_lowercase();
    let mut changed = false;
    if kind == "sticky" || kind == "label" {
        m.remove(key("kind"));
        m.remove(key("color"));
        m.insert(key("stage"), key("mist"));
        if kind == "label" {
            if let Some(serde_yaml::Value::Mapping(f)) = m.get_mut(key("fields")) {
                f.remove(key("size"));
            }
        }
        if kind == "label" && m.get(key("title")).and_then(|v| v.as_str()).is_none_or(|t| t.trim().is_empty()) {
            let first = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Untitled");
            m.insert(key("title"), key(first));
        }
        changed = true;
    }
    if m.get(key("role")).and_then(|v| v.as_str()) == Some("cc-questions") {
        m.remove(key("role"));
        changed = true;
    }
    changed |= m.remove(key("dismissed_sources")).is_some();
    // The card's build block (what Claude Code built, drift hash): the stage stays, the tracking goes.
    changed |= m.remove(key("build")).is_some();
    // The long-paste "Split into cards" offer is gone with the local model.
    if let Some(serde_yaml::Value::Mapping(f)) = m.get_mut(key("fields")) {
        changed |= f.remove(key("split_offer")).is_some();
    }
    if let Some(serde_yaml::Value::Sequence(items)) = m.get_mut(key("items")) {
        for it in items {
            if let Some(im) = it.as_mapping_mut() {
                changed |= im.remove(key("source")).is_some();
            }
        }
    }
    if !changed {
        return None;
    }
    let mut out = String::from("---\n");
    out.push_str(&serde_yaml::to_string(&y).ok()?);
    out.push_str("---\n");
    out.push_str(body);
    Some(out)
}

/// Runs the migration unless workspace.json already says layout 2. Err = the read-only banner text.
pub(super) fn run(root: &Path) -> std::result::Result<(), String> {
    let wpath = root.join("workspace.json");
    let settings = read_value(&wpath).unwrap_or_else(|| json!({}));
    if settings.get("layout").and_then(Value::as_u64) == Some(LAYOUT) {
        return strip_cards(root, &mut Vec::new());
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M").to_string();
    let backup = (1..).map(|n| root.join(if n == 1 { format!(".backup-{stamp}") } else { format!(".backup-{stamp}-{n}") })).find(|p| !p.exists()).unwrap();
    if let Err(e) = copy_tree(root, &backup, &|n| n.starts_with(".backup-")) {
        let _ = fs::remove_dir_all(&backup);
        return Err(format!("Migration failed, your data is untouched: could not back up the workspace to {} ({e})", backup.display()));
    }
    let mut log = vec![format!("{} layout 2 migration; backup in {}", now(), backup.display())];
    let res = migrate_all(root, settings, &mut log).and_then(|()| strip_cards(root, &mut log));
    if let Err(e) = &res {
        log.push(format!("FAILED: {e}"));
    }
    let lpath = root.join("migration-2.log");
    let old = fs::read_to_string(&lpath).unwrap_or_default();
    let _ = atomic_write(&lpath, format!("{old}{}\n", log.join("\n")).as_bytes());
    res.map_err(|e| format!("Migration stopped partway: {e}. Your workspace as it was before is in {}.", backup.display()))
}

fn migrate_all(root: &Path, mut settings: Value, log: &mut Vec<String>) -> std::result::Result<(), String> {
    let wpath = root.join("workspace.json");
    let projects = root.join("projects");
    let inbox = root.join("inbox");
    if inbox.join("project.json").is_file() {
        let slug = (1..).map(|n| if n == 1 { "inbox-ideas".to_string() } else { format!("inbox-ideas-{n}") }).find(|s| !projects.join(s).exists()).unwrap();
        retry_io(|| fs::rename(&inbox, projects.join(&slug))).map_err(|e| io_err("move", &inbox, e))?;
        let mpath = projects.join(&slug).join("project.json");
        let mut m = read_value(&mpath).unwrap_or_else(|| json!({}));
        m["name"] = json!("Inbox");
        write_value(&mpath, &m)?;
        if settings.get("last_project").and_then(Value::as_str) == Some("inbox") {
            settings["last_project"] = json!(slug);
        }
        write_value(&wpath, &settings)?;
        log.push(format!("inbox -> projects/{slug} (an ordinary project named Inbox)"));
    }
    let mut dirs: Vec<PathBuf> = fs::read_dir(&projects).map_err(|e| io_err("list", &projects, e))?.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))).collect();
    dirs.sort();
    for d in dirs {
        migrate_project(&d, log)?;
    }
    settings["layout"] = json!(LAYOUT);
    write_value(&wpath, &settings)?;
    log.push("done".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use tempfile::TempDir;

    fn w(p: &Path, v: Value) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
    }

    fn card(dir: &Path, id: &str, title: &str, links: &[&str], body: &str) {
        let links: String = links.iter().map(|l| format!("\n  - to: {l}\n    kind: related")).collect();
        let links = if links.is_empty() { " []".to_string() } else { links };
        fs::create_dir_all(dir.join("cards")).unwrap();
        fs::write(dir.join("cards").join(format!("{id}.md")), format!("---\nid: {id}\ntitle: {title}\nlinks:{links}\n---\n{body}\n")).unwrap();
    }

    fn pos(x: f64, y: f64) -> Value {
        json!({ "x": x, "y": y })
    }

    /// A layout-1 workspace: a project with versions v1 (archived) and v2 (open) holding nested
    /// folders Combat / Bosses, and an Inbox with one folder.
    fn fixture() -> (TempDir, PathBuf) {
        let t = TempDir::new().unwrap();
        let root = t.path().to_path_buf();
        w(&root.join("workspace.json"), json!({ "version": 1, "theme": "pink", "hotkey": "x", "last_project": "inbox" }));
        let p = root.join("projects").join("game");
        w(&p.join("project.json"), json!({ "name": "Game", "last_version": "fdv2" }));
        w(&p.join("folders.json"), json!({ "folders": [
            { "id": "fdv1", "title": "v1", "kind": "version", "created": "1" },
            { "id": "fdv2", "title": "v2", "kind": "version", "created": "2", "created_from": "fdv1" },
            { "id": "fdcombat", "title": "Combat", "parent": "fdv2", "color": "#f00" },
            { "id": "fdbosses", "title": "Bosses", "parent": "fdcombat" },
            { "id": "fdold", "title": "Old stuff", "parent": "fdv1" },
        ]}));
        w(&p.join("canvas.json"), json!({ "version": 3, "folders": { "fdv1": pos(0.0, 0.0), "fdv2": pos(300.0, 0.0) } }));
        w(&p.join("canvases/fdv1.json"), json!({ "version": 3, "cards": { "01OLDA": pos(0.0, 0.0) }, "folders": { "fdold": pos(400.0, 0.0) } }));
        w(&p.join("canvases/fdold.json"), json!({ "version": 3, "cards": { "01OLDB": pos(0.0, 0.0) } }));
        w(&p.join("canvases/fdv2.json"), json!({ "version": 3, "viewport": { "x": 5.0, "y": 6.0, "zoom": 1.5 }, "cards": { "01ROOT": pos(0.0, 0.0) }, "folders": { "fdcombat": pos(1000.0, 0.0) } }));
        w(&p.join("canvases/fdcombat.json"), json!({ "version": 3, "cards": { "01SWORD": pos(100.0, 100.0), "01SHIELD": pos(400.0, 100.0) }, "folders": { "fdbosses": pos(100.0, 400.0) } }));
        w(&p.join("canvases/fdbosses.json"), json!({ "version": 3, "cards": { "01DRAGON": pos(0.0, 0.0) } }));
        card(&p, "01OLDA", "Old A", &[], "![](media/old.png)");
        card(&p, "01OLDB", "Old B", &[], "");
        card(&p, "01ROOT", "Root", &["01DRAGON"], "");
        card(&p, "01SWORD", "Sword", &["01SHIELD"], "");
        card(&p, "01SHIELD", "Shield", &[], "");
        card(&p, "01DRAGON", "Dragon", &["01ROOT"], "");
        fs::create_dir_all(p.join("media")).unwrap();
        fs::write(p.join("media/old.png"), b"png").unwrap();
        fs::create_dir_all(p.join("artifacts/01OLDA")).unwrap();
        fs::write(p.join("artifacts/01OLDA/artifact.json"), b"{}").unwrap();
        w(&p.join("trash/trash.json"), json!({ "items": [] }));
        let i = root.join("inbox");
        w(&i.join("project.json"), json!({ "name": "Inbox" }));
        w(&i.join("folders.json"), json!({ "folders": [{ "id": "fdideas", "title": "Ideas" }] }));
        w(&i.join("canvas.json"), json!({ "version": 3, "cards": { "01LOOSE": pos(0.0, 0.0) }, "folders": { "fdideas": pos(100.0, 0.0) } }));
        w(&i.join("canvases/fdideas.json"), json!({ "version": 3, "cards": { "01IDEA": pos(0.0, 0.0) } }));
        card(&i, "01LOOSE", "Loose", &[], "");
        card(&i, "01IDEA", "Idea", &[], "");
        w(&i.join("trash/trash.json"), json!({ "items": [{ "id": "fdgone", "title": "Gone", "kind": "folder", "stage": "mist", "reason": "deleted", "deleted_at": "t", "pos": null }] }));
        w(&i.join("trash/fdgone.folder.json"), json!({ "cards": ["01TRASHED"] }));
        fs::write(i.join("trash/01TRASHED.md"), "---\nid: 01TRASHED\ntitle: Trashed\n---\n").unwrap();
        (t, root)
    }

    fn inside(f: &Frame, p: &Pos) -> bool {
        let (cx, cy) = (p.x + CARD_W / 2.0, p.y + CARD_H / 2.0);
        cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h
    }

    /// The topmost frame a card sits in (what card_frames reports).
    fn frame_of<'a>(c: &'a Canvas, id: &str) -> Option<&'a str> {
        let p = c.cards.get(id)?;
        let mut fs: Vec<&Frame> = c.frames.values().filter(|f| inside(f, p)).collect();
        fs.sort_by_key(|f| -f.z);
        fs.first().map(|f| f.title.as_str())
    }

    #[test]
    fn versions_folders_and_inbox_become_one_canvas_each() {
        let (_t, root) = fixture();
        let ws = Workspace::open(&root).unwrap();
        assert_eq!(ws.read_only(), None);
        assert!(root.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".backup-")));
        assert!(root.join("migration-2.log").is_file());

        let g = root.join("projects/game");
        assert!(!g.join("folders.json").exists() && !g.join("canvases").exists());
        let c: Canvas = serde_json::from_str(&fs::read_to_string(g.join("canvas.json")).unwrap()).unwrap();
        assert_eq!(c.viewport.zoom, 1.5, "the open version's camera");
        let ids: BTreeSet<&str> = c.cards.keys().map(String::as_str).collect();
        assert_eq!(ids, BTreeSet::from(["01ROOT", "01SWORD", "01SHIELD", "01DRAGON"]));
        assert_eq!(frame_of(&c, "01SWORD"), Some("Combat"));
        assert_eq!(frame_of(&c, "01SHIELD"), Some("Combat"));
        assert_eq!(frame_of(&c, "01DRAGON"), Some("Combat / Bosses"));
        assert_eq!(frame_of(&c, "01ROOT"), None);
        let combat = c.frames.values().find(|f| f.title == "Combat").unwrap();
        assert_eq!(combat.color.as_deref(), Some("#f00"));
        assert_eq!((combat.x, combat.y), (1000.0, 0.0), "the frame sits where the folder tile was");
        // Relative layout kept: Shield is still 300px right of Sword.
        assert_eq!(c.cards["01SHIELD"].x - c.cards["01SWORD"].x, 300.0);
        // Links survive.
        let dragon = ws.read_card("game", "01DRAGON").unwrap();
        assert_eq!(dragon.meta.links[0].to, "01ROOT");

        // The other version is archived untouched; its cards left cards/.
        let a = g.join("archive/versions/v1");
        assert!(a.join("canvas.json").is_file() && a.join("canvases/fdold.json").is_file() && a.join("folders.json").is_file());
        assert!(a.join("cards/01OLDA.md").is_file() && a.join("cards/01OLDB.md").is_file());
        assert!(a.join("media/old.png").is_file() && a.join("artifacts/01OLDA/artifact.json").is_file());
        assert!(!g.join("cards/01OLDA.md").exists() && !g.join("artifacts/01OLDA").exists());
        let meta = read_value(&g.join("project.json")).unwrap();
        assert!(meta.get("last_version").is_none());

        // Inbox: an ordinary project.
        assert!(!root.join("inbox").exists());
        let list = ws.list_projects().unwrap();
        let inbox = list.iter().find(|p| p.slug == "inbox-ideas").unwrap();
        assert_eq!(inbox.name, "Inbox");
        let d = ws.load_project("inbox-ideas").unwrap();
        assert_eq!(frame_of(&d.canvas, "01IDEA"), Some("Ideas"));
        assert!(d.canvas.cards.contains_key("01LOOSE"));
        let trash = ws.list_trash("inbox-ideas").unwrap();
        assert_eq!(trash.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["01TRASHED"], "a trashed folder becomes its cards");
        assert_eq!(ws.get_settings().unwrap().last_project.as_deref(), Some("inbox-ideas"));
        assert_eq!(ws.get_settings().unwrap().extra.get("layout"), Some(&json!(2)));
    }

    #[test]
    fn a_lost_workspace_json_still_migrates() {
        let (_t, root) = fixture();
        fs::remove_file(root.join("workspace.json")).unwrap();
        fs::remove_dir_all(root.join("inbox")).unwrap();
        Workspace::open(&root).unwrap();
        assert!(!root.join("projects/game/folders.json").exists(), "folders became frames");
        assert!(root.join("projects/game/archive/versions/v1").is_dir());
    }

    #[test]
    fn second_run_is_a_no_op() {
        let (_t, root) = fixture();
        Workspace::open(&root).unwrap();
        let canvas = fs::read_to_string(root.join("projects/game/canvas.json")).unwrap();
        let backups = |r: &Path| r.read_dir().unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".backup-")).count();
        assert_eq!(backups(&root), 1);
        Workspace::open(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join("projects/game/canvas.json")).unwrap(), canvas);
        assert_eq!(backups(&root), 1, "no second backup");
    }

    #[test]
    fn a_rerun_after_a_crash_starts_from_the_original_root() {
        let (_t, root) = fixture();
        let g = root.join("projects/game");
        let mut log = Vec::new();
        migrate_project(&g, &mut log).unwrap();
        let once: Canvas = serde_json::from_str(&fs::read_to_string(g.join("canvas.json")).unwrap()).unwrap();
        // Pretend the last removals never happened.
        let (_t2, again) = fixture();
        let g2 = again.join("projects/game");
        fs::create_dir_all(g2.join("canvases")).unwrap();
        fs::copy(g2.join("canvas.json"), g2.join("canvases").join(ORIG_ROOT)).unwrap();
        fs::write(g2.join("canvas.json"), fs::read_to_string(g.join("canvas.json")).unwrap()).unwrap();
        migrate_project(&g2, &mut log).unwrap();
        let twice: Canvas = serde_json::from_str(&fs::read_to_string(g2.join("canvas.json")).unwrap()).unwrap();
        assert_eq!(once.frames.len(), twice.frames.len(), "frames are not doubled");
        assert_eq!(once.cards, twice.cards);
    }

    #[test]
    fn overlapping_frames_go_in_a_row_right_of_the_content() {
        let t = TempDir::new().unwrap();
        let p = t.path().join("p");
        w(&p.join("project.json"), json!({ "name": "P" }));
        w(&p.join("folders.json"), json!({ "folders": [{ "id": "fda", "title": "A", "created": "1" }, { "id": "fdb", "title": "B", "created": "2" }] }));
        // Both tiles sit on top of the root card.
        w(&p.join("canvas.json"), json!({ "version": 3, "cards": { "01R": pos(0.0, 0.0) }, "folders": { "fda": pos(10.0, 10.0), "fdb": pos(20.0, 20.0) } }));
        w(&p.join("canvases/fda.json"), json!({ "version": 3, "cards": { "01A": pos(0.0, 0.0) } }));
        w(&p.join("canvases/fdb.json"), json!({ "version": 3, "cards": { "01B": pos(0.0, 0.0) } }));
        for id in ["01R", "01A", "01B"] {
            card(&p, id, id, &[], "");
        }
        migrate_project(&p, &mut Vec::new()).unwrap();
        let c: Canvas = serde_json::from_str(&fs::read_to_string(p.join("canvas.json")).unwrap()).unwrap();
        let a = c.frames.values().find(|f| f.title == "A").unwrap();
        let b = c.frames.values().find(|f| f.title == "B").unwrap();
        assert_eq!((a.x, a.y), (CARD_W + GAP, 0.0));
        assert_eq!(b.x, a.x + a.w + GAP);
        assert_eq!((a.w, a.h), (CARD_W + 2.0 * PAD, CARD_H + 2.0 * PAD), "card bounds + padding");
        assert_eq!(frame_of(&c, "01A"), Some("A"));
        assert_eq!(frame_of(&c, "01B"), Some("B"));
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_backup_leaves_everything_untouched_and_read_only() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_t, root) = fixture();
        let before = fs::read_to_string(root.join("projects/game/folders.json")).unwrap();
        // A file locked by another program can't be copied, so the backup fails.
        let _lock = fs::OpenOptions::new().read(true).write(true).share_mode(0).open(root.join("projects/game/cards/01ROOT.md")).unwrap();
        let ws = Workspace::open(&root).unwrap();
        assert!(ws.read_only().unwrap().starts_with("Migration failed, your data is untouched"));
        assert_eq!(fs::read_to_string(root.join("projects/game/folders.json")).unwrap(), before);
        assert!(root.join("inbox/project.json").is_file());
        assert!(!root.read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".backup-")), "the partial backup is removed");
        assert!(ws.create_project("New").is_err(), "read-only");
        assert!(ws.list_projects().is_ok(), "reads still work");
    }

    #[test]
    fn step_f_converts_stickies_labels_and_the_questions_card_once() {
        let (_d, root) = fixture();
        let cards = root.join("projects/game/cards");
        fs::create_dir_all(&cards).unwrap();
        let w = |name: &str, text: &str| fs::write(cards.join(name), text).unwrap();
        w("S.md", "---
title: Note
kind: sticky
color: butter
---
remember this
");
        w("L.md", "---
title: Combat
kind: label
fields:
  size: l
---
");
        w("Q.md", "---
title: From Claude Code
kind: checklist
role: cc-questions
dismissed_sources: ['- [ ] x']
items:
- {id: a, text: q, question: true, source: '- [ ] q'}
---
");
        w("B.md", "---
title: Built one
stage: built
build: {status: built}
fields:
  size: big
---
body
");
        w("P.md", "---
title: Plain
stage: lucid
---
body
");
        w("S.built.md", "snapshot");
        let mut log = Vec::new();
        strip_cards(&root, &mut log).unwrap();
        let read = |n: &str| fs::read_to_string(cards.join(n)).unwrap();
        let (s, l, q, b) = (read("S.md"), read("L.md"), read("Q.md"), read("B.md"));
        assert!(!s.contains("sticky") && !s.contains("color") && s.contains("stage: mist") && s.contains("remember this"), "{s}");
        assert!(!l.contains("label") && !l.contains("size") && l.contains("title: Combat") && l.contains("stage: mist"), "{l}");
        assert!(!q.contains("cc-questions") && !q.contains("dismissed_sources") && !q.contains("source:") && q.contains("kind: checklist"), "{q}");
        assert!(!b.contains("build:") && b.contains("stage: built") && b.contains("size: big"), "a plain card keeps its own fields: {b}");
        assert_eq!(read("P.md"), "---
title: Plain
stage: lucid
---
body
", "untouched cards are not rewritten");
        assert!(!cards.join("S.built.md").exists());
        // Marked done: a second run changes nothing, even for a file that would qualify.
        w("S2.md", "---
title: Later
kind: sticky
---
");
        strip_cards(&root, &mut log).unwrap();
        assert!(read("S2.md").contains("sticky"));
        assert_eq!(read_value(&root.join("workspace.json")).unwrap()["stripped"], json!(true));
    }
}

//! Visual artifacts: themes (style guides), character designs, concept art and HTML mockups.
//!
//! An artifact is a card of kind `artifact` (`fields.artifactType`) plus a folder of plain files:
//!
//! ```text
//! <project>/artifacts/<card id>/
//!   artifact.json        type, title, themeId, artMode, currentVersion, approvedVersion,
//!                        versions[] (files with their SpriteCook asset ids), suggestions[]
//!   v<N>/                the version's files (hero.png, turnaround.png, index.html, assets/...),
//!                        brief.md (the brief and the exact prompts) and meta.json (model, job ids,
//!                        credits, parent version)
//! ```
//!
//! Versions are never overwritten by iteration: feedback makes v<N+1> with `parent` set. Claude
//! writes through the artifact tools (sidecar -> Rust), never to files directly.

use crate::error::{AppError, Result};
use crate::model::{Card, CardKind, Link, NewCard, Source};
use crate::storage::{atomic_write, now, write_json, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const TYPES: [&str; 4] = ["theme", "character", "concept", "mockup"];

/// "pixel" (with a pixel size) or "hd".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtMode {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_size: Option<u32>,
}

impl ArtMode {
    fn check(self) -> Result<ArtMode> {
        match self.mode.as_str() {
            "pixel" => Ok(ArtMode { mode: self.mode, pixel_size: Some(self.pixel_size.unwrap_or(32).clamp(8, 512)) }),
            "hd" => Ok(ArtMode { mode: self.mode, pixel_size: None }),
            m => Err(AppError::Invalid(format!("art mode must be pixel or hd, not {m:?}"))),
        }
    }
    pub fn label(&self) -> String {
        match (self.mode.as_str(), self.pixel_size) {
            ("pixel", Some(n)) => format!("pixel {n}px"),
            ("pixel", None) => "pixel".into(),
            _ => "HD".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Swatch {
    pub name: String,
    pub hex: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Fonts {
    #[serde(default)]
    pub heading: String,
    #[serde(default)]
    pub body: String,
}

/// What a theme artifact defines (per version): the style anchor other artifacts inherit.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpec {
    #[serde(default)]
    pub palette: Vec<Swatch>,
    #[serde(default)]
    pub fonts: Fonts,
    #[serde(default)]
    pub mood: Vec<String>,
    #[serde(default)]
    pub dos: Vec<String>,
    #[serde(default)]
    pub donts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art_mode: Option<ArtMode>,
    /// The key art file in this version (e.g. "key-art.png").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_art_asset_id: Option<String>,
    /// SpriteCook private preset saved from it (save_private_preset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
}

/// One file of a version, with the SpriteCook asset it came from (kept for later edits).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionFile {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// hero, turnaround, expression, pose, animation, concept, key-art, ui-kit, notes, html, ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub n: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    pub created: String,
    #[serde(default)]
    pub files: Vec<VersionFile>,
    /// Theme artifacts: the spec this version defines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeSpec>,
    /// Credits SpriteCook reported for this version (all turns that built it).
    #[serde(default)]
    pub credits: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub label: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub est_credits: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMeta {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    /// A theme picked for this artifact (None = the project's active theme).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_id: Option<String>,
    /// Overrides the theme's art mode for this artifact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art_mode: Option<ArtMode>,
    /// The version shown and iterated on (0 = nothing generated yet).
    #[serde(default)]
    pub current_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_version: Option<u32>,
    #[serde(default)]
    pub versions: Vec<Version>,
    #[serde(default)]
    pub suggestions: Vec<Suggestion>,
    /// The card it was visualized from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_card: Option<String>,
    #[serde(default)]
    pub brief: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl ArtifactMeta {
    pub fn version(&self, n: u32) -> Option<&Version> {
        self.versions.iter().find(|v| v.n == n)
    }
    fn version_mut(&mut self, n: u32) -> Option<&mut Version> {
        self.versions.iter_mut().find(|v| v.n == n)
    }
    /// The version other artifacts inherit from (themes) and handoff uses: approved, else current.
    pub fn settled_version(&self) -> Option<&Version> {
        self.approved_version.and_then(|n| self.version(n)).or_else(|| self.version(self.current_version))
    }
}

pub fn check_type(t: &str) -> Result<&'static str> {
    TYPES.iter().find(|x| **x == t).copied().ok_or_else(|| AppError::Invalid(format!("artifact type must be one of {}, not {t:?}", TYPES.join(", "))))
}

fn dir_of(ws: &Workspace, slug: &str, id: &str) -> Result<PathBuf> {
    crate::storage::check_id(id)?;
    Ok(ws.existing_project_dir(slug)?.join("artifacts").join(id))
}

fn version_dir(dir: &Path, n: u32) -> PathBuf {
    dir.join(format!("v{n}"))
}

/// The artifact's metadata. A card whose folder is missing (copied by hand, restored from git)
/// gets one derived from the card.
pub fn read(ws: &Workspace, slug: &str, id: &str) -> Result<ArtifactMeta> {
    let dir = dir_of(ws, slug, id)?;
    match fs::read_to_string(dir.join("artifact.json")) {
        Ok(t) => serde_json::from_str(t.trim_start_matches('\u{feff}')).map_err(|e| AppError::Parse { context: format!("artifacts/{id}/artifact.json"), message: e.to_string() }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let card = ws.read_card(slug, id)?;
            if card.meta.kind != CardKind::Artifact {
                return Err(AppError::Invalid(format!("card {id} is not an artifact")));
            }
            let kind = card.meta.fields.get("artifactType").and_then(Value::as_str).and_then(|t| check_type(t).ok()).unwrap_or("concept");
            Ok(ArtifactMeta { kind: kind.into(), title: card.meta.title, brief: card.body, ..Default::default() })
        }
        Err(e) => Err(AppError::io(format!("read artifacts/{id}/artifact.json"), e)),
    }
}

fn write(ws: &Workspace, slug: &str, id: &str, meta: &ArtifactMeta) -> Result<()> {
    write_json(&dir_of(ws, slug, id)?.join("artifact.json"), meta)
}

/// Read, change, write.
pub fn modify<T>(ws: &Workspace, slug: &str, id: &str, f: impl FnOnce(&mut ArtifactMeta) -> Result<T>) -> Result<T> {
    let mut meta = read(ws, slug, id)?;
    let out = f(&mut meta)?;
    write(ws, slug, id, &meta)?;
    Ok(out)
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewArtifact {
    #[serde(rename = "type")]
    pub kind: String,
    pub title: Option<String>,
    #[serde(default)]
    pub brief: String,
    pub source_card: Option<String>,
    pub theme_id: Option<String>,
    /// Claude's proposal (deepen / grill): a ghost card, nothing generated until it is kept.
    #[serde(default)]
    pub ghost: bool,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

pub fn default_title(kind: &str) -> &'static str {
    match kind {
        "theme" => "Theme",
        "character" => "Character",
        "mockup" => "Mockup",
        _ => "Concept art",
    }
}

/// Creates the artifact card (kind artifact, the brief as its body, linked to its source card) and
/// its folder with artifact.json. No version yet: the first artifact turn makes v1.
pub fn create(ws: &Workspace, slug: &str, new: NewArtifact) -> Result<Card> {
    let kind = check_type(new.kind.trim())?;
    if let Some(src) = &new.source_card {
        crate::storage::check_id(src)?;
        ws.read_card(slug, src)?;
    }
    if let Some(t) = &new.theme_id {
        crate::storage::check_id(t)?;
    }
    let title = new.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(|t| t.chars().take(120).collect::<String>()).unwrap_or_else(|| default_title(kind).into());
    let mut fields = BTreeMap::new();
    fields.insert("artifactType".to_string(), json!(kind));
    let card = ws.create_card(
        slug,
        NewCard {
            title: Some(title.clone()),
            body: Some(new.brief.clone()),
            kind: Some(CardKind::Artifact),
            fields: Some(fields),
            links: new.source_card.as_ref().map(|s| vec![Link { to: s.clone(), label: Some("visualizes".into()) }]),
            source: Some(if new.ghost { Source::Claude } else { Source::User }),
            ghost: Some(new.ghost),
            x: new.x,
            y: new.y,
            ..Default::default()
        },
    )?;
    let meta = ArtifactMeta { kind: kind.into(), title, theme_id: new.theme_id, brief: new.brief, source_card: new.source_card, ..Default::default() };
    write(ws, slug, &card.meta.id, &meta)?;
    Ok(card)
}

/// Starts the version a turn writes into. `add`: a part added to the current version (e.g. a
/// turnaround next to the hero); otherwise a new version whose parent is the current one. The
/// brief (and the prompts) go to brief.md; nothing that exists is overwritten.
pub fn begin_version(ws: &Workspace, slug: &str, id: &str, add: bool, brief: &str, model: Option<&str>) -> Result<u32> {
    let dir = dir_of(ws, slug, id)?;
    modify(ws, slug, id, |meta| {
        let stamp = now();
        if add && meta.current_version > 0 && meta.version(meta.current_version).is_some() {
            let n = meta.current_version;
            let path = version_dir(&dir, n).join("brief.md");
            let old = fs::read_to_string(&path).unwrap_or_default();
            atomic_write(&path, format!("{}\n\n## Added {stamp}\n\n{}\n", old.trim_end(), brief.trim()).as_bytes())?;
            return Ok(n);
        }
        let n = meta.versions.iter().map(|v| v.n).max().unwrap_or(0) + 1;
        let parent = (meta.current_version > 0).then_some(meta.current_version);
        let vdir = version_dir(&dir, n);
        if vdir.exists() {
            return Err(AppError::Invalid(format!("artifacts/{id}/v{n} already exists")));
        }
        atomic_write(&vdir.join("brief.md"), format!("# v{n}\n\n{}\n", brief.trim()).as_bytes())?;
        write_json(&vdir.join("meta.json"), &json!({ "version": n, "parent": parent, "created": stamp, "model": model, "jobs": [], "credits": 0 }))?;
        // A new version starts as a copy of its parent (files and, for a theme, the spec), so it is
        // complete on its own; the turn then replaces what it changes. The parent stays untouched.
        let base = parent.and_then(|p| meta.version(p)).cloned();
        let mut files = Vec::new();
        if let Some(b) = &base {
            for f in &b.files {
                if let Ok(bytes) = fs::read(version_dir(&dir, b.n).join(&f.file)) {
                    atomic_write(&vdir.join(&f.file), &bytes)?;
                    files.push(f.clone());
                }
            }
        }
        let theme = base.and_then(|v| v.theme);
        meta.versions.push(Version { n, parent, created: stamp, files, theme, credits: 0.0 });
        meta.current_version = n;
        Ok(n)
    })
}

/// The version a tool call writes into: the current one, or a fresh v1 if none exists yet.
fn working_version(ws: &Workspace, slug: &str, id: &str) -> Result<u32> {
    let meta = read(ws, slug, id)?;
    if meta.current_version > 0 && meta.version(meta.current_version).is_some() {
        return Ok(meta.current_version);
    }
    begin_version(ws, slug, id, false, &meta.brief, None)
}

/// A file name inside a version: letters, digits, `.`, `_`, `-`, optionally under `assets/`.
/// brief.md and meta.json are Dreamer's own.
pub fn check_file_name(name: &str) -> Result<String> {
    let name = name.trim().replace('\\', "/");
    let (sub, base) = match name.split_once('/') {
        Some(("assets", b)) => ("assets/", b),
        Some(_) => return Err(AppError::Invalid(format!("{name:?}: files go in the version folder or its assets/ folder"))),
        None => ("", name.as_str()),
    };
    let ok = !base.is_empty() && base.len() <= 80 && !base.starts_with('.') && base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return Err(AppError::Invalid(format!("{name:?} is not a valid file name (letters, digits, . _ -)")));
    }
    if sub.is_empty() && matches!(base, "brief.md" | "meta.json") {
        return Err(AppError::Invalid(format!("{base} is written by Dreamer")));
    }
    Ok(format!("{sub}{base}"))
}

/// Writes one file into the working version. In an approved version an existing file is never
/// replaced: the new one gets a free name instead. Returns the file name used.
pub fn save_file(ws: &Workspace, slug: &str, id: &str, name: &str, bytes: &[u8], asset_id: Option<&str>, role: Option<&str>) -> Result<(u32, String)> {
    let mut name = check_file_name(name)?;
    let n = working_version(ws, slug, id)?;
    let dir = dir_of(ws, slug, id)?;
    let vdir = version_dir(&dir, n);
    let approved = read(ws, slug, id)?.approved_version == Some(n);
    if approved && vdir.join(&name).exists() {
        name = free_name(&vdir, &name);
    }
    atomic_write(&vdir.join(&name), bytes)?;
    modify(ws, slug, id, |meta| {
        let v = meta.version_mut(n).ok_or_else(|| AppError::NotFound(format!("version {n}")))?;
        let entry = VersionFile { file: name.clone(), asset_id: asset_id.map(str::to_string).filter(|a| !a.is_empty()), role: role.map(str::to_string).filter(|r| !r.is_empty()) };
        match v.files.iter_mut().find(|f| f.file == name) {
            Some(f) => *f = entry,
            None => v.files.push(entry),
        }
        Ok(())
    })?;
    Ok((n, name))
}

fn free_name(dir: &Path, name: &str) -> String {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    (2..).map(|i| format!("{stem}-{i}{ext}")).find(|n| !dir.join(n).exists()).expect("unbounded")
}

/// Copies an image of another artifact (a project sprite) into this artifact's working version
/// under assets/, for a mockup to use. Returns the new file name.
pub fn copy_asset(ws: &Workspace, slug: &str, id: &str, from: &str, file: &str, as_name: Option<&str>) -> Result<(u32, String)> {
    let src_meta = read(ws, slug, from)?;
    let file = check_file_name(file)?;
    let (vn, entry) = src_meta
        .versions
        .iter()
        .rev()
        .find_map(|v| v.files.iter().find(|f| f.file == file).map(|f| (v.n, f.clone())))
        .ok_or_else(|| AppError::NotFound(format!("{file} in artifact {from}")))?;
    let bytes = fs::read(version_dir(&dir_of(ws, slug, from)?, vn).join(&file)).map_err(|e| AppError::io(format!("read {file}"), e))?;
    let base = as_name.map(str::to_string).unwrap_or_else(|| file.rsplit('/').next().unwrap_or(&file).to_string());
    let target = if base.starts_with("assets/") { base } else { format!("assets/{base}") };
    save_file(ws, slug, id, &target, &bytes, entry.asset_id.as_deref(), Some("sprite"))
}

/// Merges what a finished turn reports into the working version's meta.json: model, SpriteCook job
/// ids, credits (added up), and the credits in artifact.json's version entry.
pub fn record_turn(ws: &Workspace, slug: &str, id: &str, model: Option<&str>, jobs: &[String], credits: f64) -> Result<()> {
    let meta = read(ws, slug, id)?;
    let n = meta.current_version;
    if n == 0 || meta.version(n).is_none() {
        return Ok(());
    }
    let path = version_dir(&dir_of(ws, slug, id)?, n).join("meta.json");
    let mut m: serde_json::Map<String, Value> = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        m.insert("model".into(), json!(model));
    }
    let mut all: Vec<Value> = m.get("jobs").and_then(Value::as_array).cloned().unwrap_or_default();
    for j in jobs {
        if !all.iter().any(|x| x.as_str() == Some(j)) {
            all.push(json!(j));
        }
    }
    m.insert("jobs".into(), Value::Array(all));
    let total = m.get("credits").and_then(Value::as_f64).unwrap_or(0.0) + credits;
    m.insert("credits".into(), json!(total));
    m.insert("updated".into(), json!(now()));
    write_json(&path, &Value::Object(m))?;
    if credits > 0.0 {
        modify(ws, slug, id, |meta| {
            if let Some(v) = meta.version_mut(n) {
                v.credits += credits;
            }
            Ok(())
        })?;
    }
    Ok(())
}

/// The 2-5 next-step chips (replaced after every turn).
pub fn set_suggestions(ws: &Workspace, slug: &str, id: &str, list: Vec<Suggestion>) -> Result<()> {
    let list: Vec<Suggestion> = list
        .into_iter()
        .filter(|s| !s.label.trim().is_empty() && !s.prompt.trim().is_empty())
        .map(|s| Suggestion { label: s.label.trim().chars().take(40).collect(), prompt: s.prompt.trim().chars().take(1000).collect(), est_credits: s.est_credits.filter(|c| c.is_finite() && *c >= 0.0) })
        .take(5)
        .collect();
    modify(ws, slug, id, |meta| {
        meta.suggestions = list;
        Ok(())
    })
}

/// Changes from the artifact's header and menus. `theme_id: ""` / `art_mode: null` clear the
/// override; `approved_version: 0` clears the approval.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPatch {
    pub theme_id: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub art_mode: Option<Option<ArtMode>>,
    pub current_version: Option<u32>,
    pub approved_version: Option<u32>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<ArtMode>>, D::Error> {
    Option::<ArtMode>::deserialize(d).map(Some)
}

pub fn update(ws: &Workspace, slug: &str, id: &str, patch: ArtifactPatch) -> Result<ArtifactMeta> {
    modify(ws, slug, id, |meta| {
        if let Some(t) = patch.theme_id {
            if t.is_empty() {
                meta.theme_id = None;
            } else {
                crate::storage::check_id(&t)?;
                if t == id {
                    return Err(AppError::Invalid("a theme can't inherit from itself".into()));
                }
                meta.theme_id = Some(t);
            }
        }
        if let Some(m) = patch.art_mode {
            meta.art_mode = m.map(ArtMode::check).transpose()?;
        }
        if let Some(n) = patch.current_version {
            if meta.version(n).is_none() {
                return Err(AppError::NotFound(format!("version {n}")));
            }
            meta.current_version = n;
        }
        if let Some(n) = patch.approved_version {
            if n == 0 {
                meta.approved_version = None;
            } else if meta.version(n).is_none() {
                return Err(AppError::NotFound(format!("version {n}")));
            } else {
                meta.approved_version = Some(n);
            }
        }
        Ok(meta.clone())
    })
}

/// Reads one file of a version (the UI's previews, the handoff copy).
pub fn read_file(ws: &Workspace, slug: &str, id: &str, n: u32, file: &str) -> Result<Vec<u8>> {
    let file = check_file_name(file)?;
    let path = version_dir(&dir_of(ws, slug, id)?, n).join(&file);
    fs::read(&path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { AppError::NotFound(format!("{file} in v{n}")) } else { AppError::io(format!("read {}", path.display()), e) })
}

/// brief.md and meta.json of a version (the full-size view).
pub fn version_info(ws: &Workspace, slug: &str, id: &str, n: u32) -> Result<Value> {
    let vdir = version_dir(&dir_of(ws, slug, id)?, n);
    let brief = fs::read_to_string(vdir.join("brief.md")).unwrap_or_default();
    let meta: Value = fs::read_to_string(vdir.join("meta.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let notes = fs::read_to_string(vdir.join("notes.md")).unwrap_or_default();
    Ok(json!({ "brief": brief, "meta": meta, "notes": notes }))
}

// ---------- project-level state (project.json) ----------

/// The project's active theme (an artifact id), if it still exists as a theme.
pub fn active_theme(ws: &Workspace, slug: &str) -> Option<String> {
    let id = ws.project_meta(slug).ok()?.extra.get("active_theme").and_then(Value::as_str)?.to_string();
    (read(ws, slug, &id).ok()?.kind == "theme").then_some(id)
}

pub fn set_active_theme(ws: &Workspace, slug: &str, id: Option<&str>) -> Result<()> {
    if let Some(id) = id {
        if read(ws, slug, id)?.kind != "theme" {
            return Err(AppError::Invalid("only a theme artifact can be the active theme".into()));
        }
    }
    ws.set_project_extra(slug, "active_theme", id.map(|i| json!(i)))
}

/// The SpriteCook project this Dreamer project mirrors to (created lazily by Claude).
pub fn spritecook_project(ws: &Workspace, slug: &str) -> Option<String> {
    ws.project_meta(slug).ok()?.extra.get("spritecook_project").and_then(Value::as_str).map(str::to_string)
}

pub fn set_spritecook_project(ws: &Workspace, slug: &str, project_id: &str) -> Result<()> {
    let p = project_id.trim();
    if p.is_empty() || p.len() > 100 || p.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::Invalid("not a SpriteCook project id".into()));
    }
    ws.set_project_extra(slug, "spritecook_project", Some(json!(p)))
}

/// The theme an artifact inherits: its own pick, else the project's active theme (never itself).
pub struct Inherited {
    pub id: String,
    pub title: String,
    pub version: u32,
    pub spec: ThemeSpec,
}

pub fn inherited_theme(ws: &Workspace, slug: &str, id: &str, meta: &ArtifactMeta) -> Option<Inherited> {
    let tid = meta.theme_id.clone().or_else(|| active_theme(ws, slug)).filter(|t| t != id)?;
    let theme = read(ws, slug, &tid).ok().filter(|m| m.kind == "theme")?;
    let title = ws.read_card(slug, &tid).map(|c| c.meta.title).unwrap_or(theme.title.clone());
    let v = theme.settled_version()?;
    Some(Inherited { id: tid, title, version: v.n, spec: v.theme.clone().unwrap_or_default() })
}

/// The art mode an artifact generates in: its override, else its theme's (for a theme: its own).
pub fn effective_art_mode(meta: &ArtifactMeta, theme: Option<&Inherited>) -> Option<ArtMode> {
    meta.art_mode.clone().or_else(|| if meta.kind == "theme" { meta.settled_version().and_then(|v| v.theme.as_ref()).and_then(|t| t.art_mode.clone()) } else { theme.and_then(|t| t.spec.art_mode.clone()) })
}

/// Every artifact of the project with its type (folders without a card are skipped).
pub fn list(ws: &Workspace, slug: &str) -> Vec<(String, ArtifactMeta)> {
    let Ok(dir) = ws.existing_project_dir(slug) else { return Vec::new() };
    let Ok(rd) = fs::read_dir(dir.join("artifacts")) else { return Vec::new() };
    let mut out: Vec<(String, ArtifactMeta)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|id| crate::storage::check_id(id).is_ok() && ws.read_card(slug, id).is_ok())
        .filter_map(|id| read(ws, slug, &id).ok().map(|m| (id, m)))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Image files of the project's other artifacts (current or approved version): sprites a mockup can use.
pub fn project_images(ws: &Workspace, slug: &str, except: &str) -> Vec<Value> {
    let is_image = |f: &str| matches!(f.rsplit('.').next().map(str::to_ascii_lowercase).as_deref(), Some("png" | "webp" | "gif" | "jpg" | "jpeg"));
    list(ws, slug)
        .into_iter()
        .filter(|(id, _)| id != except)
        .flat_map(|(id, m)| {
            let title = ws.read_card(slug, &id).map(|c| c.meta.title).unwrap_or_default();
            m.settled_version()
                .map(|v| v.files.iter().filter(|f| is_image(&f.file)).map(|f| json!({ "artifact": id, "title": title, "file": f.file, "role": f.role })).collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .collect()
}

// ---------- handoff ----------

/// What the handoff pack gets from the artifacts: the approved versions' files (copied to
/// `assets/<artifact-slug>/...`), the 05-assets.md sections (artifacts + the active theme's style
/// guide) and a short note for Claude's generation prompt.
#[derive(Default)]
pub struct HandoffPart {
    pub assets: Vec<(String, PathBuf)>,
    pub section: String,
    pub prompt_note: String,
}

fn unique_slug(title: &str, used: &mut Vec<String>) -> String {
    let base = { let s = crate::storage::slugify(title); if s.is_empty() { "artifact".to_string() } else { s } };
    let mut s = base.clone();
    let mut i = 2;
    while used.contains(&s) {
        s = format!("{base}-{i}");
        i += 1;
    }
    used.push(s.clone());
    s
}

pub fn handoff(ws: &Workspace, slug: &str) -> HandoffPart {
    let Ok(dir) = ws.existing_project_dir(slug) else { return HandoffPart::default() };
    let mut used = Vec::new();
    let mut part = HandoffPart::default();
    let mut lines: Vec<String> = Vec::new();
    let mut slugs: BTreeMap<String, String> = BTreeMap::new();
    let active = active_theme(ws, slug);
    for (id, meta) in list(ws, slug) {
        let Ok(card) = ws.read_card(slug, &id) else { continue };
        if card.meta.ghost {
            continue;
        }
        let title = card.meta.title.trim().to_string();
        let aslug = unique_slug(&title, &mut used);
        slugs.insert(id.clone(), aslug.clone());
        // Unapproved artifacts are ignored.
        let Some(n) = meta.approved_version else { continue };
        let Some(v) = meta.version(n) else { continue };
        let vdir = version_dir(&dir.join("artifacts").join(&id), n);
        let mut files = Vec::new();
        for f in &v.files {
            let name = format!("{aslug}/{}", f.file);
            part.assets.push((name.clone(), vdir.join(&f.file)));
            files.push(format!("assets/{name}"));
        }
        let theme = inherited_theme(ws, slug, &id, &meta).map(|t| t.title).unwrap_or_else(|| if meta.kind == "theme" { "(this theme)".into() } else { "none".into() });
        let brief = card.body.trim().lines().filter(|l| !l.trim().is_empty()).take(3).collect::<Vec<_>>().join(" ");
        let cover = files.iter().find(|f| f.ends_with("/hero.png") || f.ends_with("/key-art.png") || f.ends_with("/concept.png")).or_else(|| files.iter().find(|f| [".png", ".webp", ".jpg", ".gif"].iter().any(|x| f.ends_with(x))));
        let mut entry = format!("### {title}\n\n- Type: {}\n- Version: v{n} (approved)\n- Theme: {theme}\n- Brief: {}\n- Files: {}\n", meta.kind, if brief.is_empty() { "(none)".into() } else { brief }, files.iter().map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", "));
        if let Some(c) = cover {
            entry.push_str(&format!("\n![{title}]({c})\n"));
        }
        lines.push(entry);
        part.prompt_note.push_str(&format!("\n- \"{title}\" ({}, v{n}): files under assets/{aslug}/{}", meta.kind, cover.map(|c| format!(", main image {c}")).unwrap_or_default()));
    }
    if !lines.is_empty() {
        part.section.push_str("\n\n## Artifacts (approved)\n\nVisual artifacts the user approved in Dreamer. Unapproved versions are not part of the pack.\n\n");
        part.section.push_str(&lines.join("\n"));
    }
    // The active theme is the style guide (its approved version, else the current one).
    if let Some(tid) = active {
        if let (Ok(meta), Ok(card)) = (read(ws, slug, &tid), ws.read_card(slug, &tid)) {
            if let Some(v) = meta.settled_version() {
                let t = v.theme.clone().unwrap_or_default();
                let aslug = slugs.get(&tid).cloned().unwrap_or_else(|| unique_slug(&card.meta.title, &mut used));
                let mut s = format!("\n\n## Style guide: {}\n\n", card.meta.title.trim());
                s.push_str(&format!("From the project's active theme (v{}{}).\n", v.n, if meta.approved_version == Some(v.n) { ", approved" } else { ", not approved yet" }));
                if !t.palette.is_empty() {
                    s.push_str("\n| Swatch | Hex |\n|---|---|\n");
                    for sw in &t.palette {
                        s.push_str(&format!("| {} | `{}` |\n", sw.name, sw.hex));
                    }
                }
                s.push_str(&format!("\n- Fonts: headings {}, body {}\n", if t.fonts.heading.is_empty() { "TBD" } else { &t.fonts.heading }, if t.fonts.body.is_empty() { "TBD" } else { &t.fonts.body }));
                s.push_str(&format!("- Art mode: {}\n", t.art_mode.as_ref().map(ArtMode::label).unwrap_or_else(|| "TBD".into())));
                if !t.mood.is_empty() {
                    s.push_str(&format!("- Mood: {}\n", t.mood.join(", ")));
                }
                if !t.dos.is_empty() {
                    s.push_str(&format!("- Do: {}\n", t.dos.join("; ")));
                }
                if !t.donts.is_empty() {
                    s.push_str(&format!("- Don't: {}\n", t.donts.join("; ")));
                }
                if let Some(k) = &t.key_art {
                    let name = format!("{aslug}/{k}");
                    if !part.assets.iter().any(|(n, _)| n == &name) {
                        part.assets.push((name.clone(), version_dir(&dir.join("artifacts").join(&tid), v.n).join(k)));
                    }
                    s.push_str(&format!("\n![Key art](assets/{name})\n"));
                }
                part.prompt_note.push_str(&format!("\nThe active theme \"{}\" is the style guide (palette, fonts, art mode, do/don't); refer to it for art direction.", card.meta.title.trim()));
                part.section.push_str(&s);
            }
        }
    }
    part
}

/// Deletes the folders of artifacts whose card is gone for good (Trash emptied).
pub fn sweep(project_dir: &Path, live: &dyn Fn(&str) -> bool) {
    let Ok(rd) = fs::read_dir(project_dir.join("artifacts")) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        if crate::storage::check_id(&name).is_ok() && !live(&name) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// What the UI shows for one artifact: artifact.json plus what it inherits.
pub fn view(ws: &Workspace, slug: &str, id: &str) -> Result<Value> {
    let meta = read(ws, slug, id)?;
    let theme = inherited_theme(ws, slug, id, &meta);
    let mode = effective_art_mode(&meta, theme.as_ref());
    let active = active_theme(ws, slug);
    let mut v = serde_json::to_value(&meta).map_err(|e| AppError::Parse { context: "artifact".into(), message: e.to_string() })?;
    v["id"] = json!(id);
    v["inherited"] = theme.map(|t| json!({ "id": t.id, "title": t.title, "version": t.version, "spec": t.spec })).unwrap_or(Value::Null);
    v["effectiveArtMode"] = json!(mode);
    v["isActiveTheme"] = json!(active.as_deref() == Some(id));
    v["activeTheme"] = json!(active);
    Ok(v)
}

/// Every theme artifact of the project (the theme pickers).
pub fn themes(ws: &Workspace, slug: &str) -> Vec<Value> {
    let active = active_theme(ws, slug);
    list(ws, slug)
        .into_iter()
        .filter(|(_, m)| m.kind == "theme")
        .filter_map(|(id, m)| {
            let card = ws.read_card(slug, &id).ok().filter(|c| !c.meta.ghost)?;
            Some(json!({ "id": id, "title": card.meta.title, "active": active.as_deref() == Some(id.as_str()), "versions": m.versions.len(), "spec": m.settled_version().and_then(|v| v.theme.clone()) }))
        })
        .collect()
}

// ---------- HTML artifacts (mockups, theme style guides) ----------

/// The sandbox policy written into every HTML artifact before anything else: no network at all,
/// only inline code and data: URLs (the version's own files, inlined below).
pub const HTML_CSP: &str = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

fn mime_of(file: &str) -> &'static str {
    match file.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("css") => "text/css",
        Some("js") => "text/javascript",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// A reference that points into the version folder ("assets/x.png", "./style.css").
fn local_ref(r: &str) -> Option<String> {
    let r = r.trim();
    let r = r.split(['?', '#']).next().unwrap_or("");
    if r.is_empty() || r.contains(':') || r.starts_with("//") || r.starts_with('/') {
        return None;
    }
    check_file_name(r.trim_start_matches("./")).ok()
}

/// Replaces local references in `src="…"`, `href="…"` and `url(…)` with data: URLs of the
/// version's files. Anything else (http links included) stays as written; the CSP blocks it.
fn inline_refs(text: &str, load: &dyn Fn(&str) -> Option<String>, depth: u8) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        // The next attribute or url( opener.
        let hit = ["src=", "href=", "url("].iter().filter_map(|k| rest.find(k).map(|i| (i, *k))).min_by_key(|(i, _)| *i);
        let Some((i, key)) = hit else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..i + key.len()]);
        rest = &rest[i + key.len()..];
        let (quote, body_start) = match rest.chars().next() {
            Some(q @ ('"' | '\'')) => (Some(q), 1),
            _ if key == "url(" => (None, 0),
            _ => continue,
        };
        let body = &rest[body_start..];
        let end = match quote {
            Some(q) => body.find(q),
            None => body.find(')'),
        };
        let Some(end) = end else { continue };
        let target = &body[..end];
        match local_ref(target).and_then(|f| {
            let data = load(&f)?;
            Some((f, data))
        }) {
            Some((f, data)) => {
                let data = if depth > 0 && f.ends_with(".css") {
                    // url(...) inside a stylesheet resolves against the version folder too.
                    use base64::Engine;
                    let css = base64::engine::general_purpose::STANDARD.decode(data.rsplit(',').next().unwrap_or("")).ok().map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                    format!("data:text/css;base64,{}", base64::engine::general_purpose::STANDARD.encode(inline_refs(&css, load, depth - 1)))
                } else {
                    data
                };
                if let Some(q) = quote {
                    out.push(q);
                }
                out.push_str(&data);
            }
            None => {
                if let Some(q) = quote {
                    out.push(q);
                }
                out.push_str(target);
            }
        }
        rest = &body[end..];
    }
}

/// An HTML version ready for the sandboxed iframe: the CSP meta first, then the theme's CSS
/// variables (`extra_head` = fonts from the UI), with every local file inlined as a data: URL.
pub fn render_html(ws: &Workspace, slug: &str, id: &str, n: u32, extra_head: &str) -> Result<String> {
    let meta = read(ws, slug, id)?;
    let v = meta.version(n).ok_or_else(|| AppError::NotFound(format!("version {n}")))?;
    let page = v.files.iter().find(|f| f.file == "index.html").or_else(|| v.files.iter().find(|f| f.file.ends_with(".html"))).ok_or_else(|| AppError::NotFound(format!("an HTML file in v{n}")))?;
    let vdir = version_dir(&dir_of(ws, slug, id)?, n);
    let html = String::from_utf8_lossy(&fs::read(vdir.join(&page.file)).map_err(|e| AppError::io(format!("read {}", page.file), e))?).into_owned();
    let inherited = inherited_theme(ws, slug, id, &meta);
    let own = (meta.kind == "theme").then(|| v.theme.clone()).flatten();
    let mode = effective_art_mode(&meta, inherited.as_ref());
    let css = theme_css(own.as_ref().or(inherited.as_ref().map(|t| &t.spec)), mode.as_ref());
    let load = |f: &str| -> Option<String> {
        use base64::Engine;
        let bytes = fs::read(vdir.join(f)).ok()?;
        Some(format!("data:{};base64,{}", mime_of(f), base64::engine::general_purpose::STANDARD.encode(bytes)))
    };
    let body = inline_refs(&html, &load, 1);
    let head = format!("<meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{HTML_CSP}\"><style>{css} img {{ image-rendering: var(--image-rendering, auto); }}</style>{extra_head}");
    // The policy must come before anything that could run or load: right after <head>, or first.
    let lower = body.to_ascii_lowercase();
    let at = lower.find("<head").and_then(|i| lower[i..].find('>').map(|j| i + j + 1));
    Ok(match at {
        Some(i) => format!("{}{head}{}", &body[..i], &body[i..]),
        None => format!("<!doctype html><html><head>{head}</head><body>{body}</body></html>"),
    })
}

// ---------- what Claude sees and does in an artifact turn ----------

/// The artifact block at the top of every artifact turn: the artifact, its versions and files
/// (with SpriteCook asset ids), what it inherits, SpriteCook's state and the credit cap.
pub fn context_block(ws: &Workspace, slug: &str, id: &str, cap: u32, spritecook_key: bool) -> Result<String> {
    let meta = read(ws, slug, id)?;
    let card = ws.read_card(slug, id)?;
    let theme = inherited_theme(ws, slug, id, &meta);
    let mode = effective_art_mode(&meta, theme.as_ref());
    let mut out = format!("[Artifact] id {id} · type {} · \"{}\"", meta.kind, card.meta.title.trim());
    if let Some(src) = meta.source_card.as_deref().and_then(|s| ws.read_card(slug, s).ok()) {
        out.push_str(&format!("\nVisualizes card \"{}\" (id {}).", src.meta.title.trim(), src.meta.id));
    }
    let brief = if card.body.trim().is_empty() { meta.brief.trim() } else { card.body.trim() };
    if !brief.is_empty() {
        out.push_str(&format!("\nBrief: {}", crate::ctx::cap_for_claude(brief, 2000)));
    }
    if meta.versions.is_empty() {
        out.push_str("\nVersions: none yet (this turn makes v1).");
    } else {
        out.push_str(&format!("\nCurrent version: v{}{}", meta.current_version, meta.approved_version.map(|a| format!(" · approved: v{a}")).unwrap_or_default()));
        for v in &meta.versions {
            let files: Vec<String> = v
                .files
                .iter()
                .map(|f| format!("{}{}{}", f.file, f.role.as_deref().map(|r| format!(" [{r}]")).unwrap_or_default(), f.asset_id.as_deref().map(|a| format!(" asset {a}")).unwrap_or_default()))
                .collect();
            out.push_str(&format!("\n- v{}{}: {}", v.n, v.parent.map(|p| format!(" (from v{p})")).unwrap_or_default(), if files.is_empty() { "no files".into() } else { files.join("; ") }));
        }
        if let Some(t) = meta.version(meta.current_version).and_then(|v| v.theme.as_ref()) {
            out.push_str(&format!("\nThis theme's spec (v{}): {}", meta.current_version, serde_json::to_string(t).unwrap_or_default()));
        }
    }
    match &theme {
        Some(t) => {
            out.push_str(&format!("\n[Theme] \"{}\" (id {}, v{}){}", t.title.trim(), t.id, t.version, if meta.theme_id.is_some() { " picked for this artifact" } else { " = the project's active theme" }));
            if !t.spec.palette.is_empty() {
                out.push_str(&format!("\nPalette: {}", t.spec.palette.iter().map(|s| format!("{} {}", s.name, s.hex)).collect::<Vec<_>>().join(", ")));
            }
            if !t.spec.fonts.heading.is_empty() || !t.spec.fonts.body.is_empty() {
                out.push_str(&format!("\nFonts: heading {} · body {}", t.spec.fonts.heading, t.spec.fonts.body));
            }
            if !t.spec.mood.is_empty() {
                out.push_str(&format!("\nMood: {}", t.spec.mood.join(", ")));
            }
            if !t.spec.dos.is_empty() || !t.spec.donts.is_empty() {
                out.push_str(&format!("\nDo: {} · Don't: {}", t.spec.dos.join("; "), t.spec.donts.join("; ")));
            }
            match (&t.spec.preset_id, &t.spec.key_art_asset_id) {
                (None, None) => out.push_str("\nStyle reference: none saved yet (no key art / preset)."),
                (p, k) => out.push_str(&format!(
                    "\nStyle reference for every image: preset {} · key art asset {} (apply the preset's settings and pass the key art in style_asset_ids).",
                    p.as_deref().unwrap_or("none"),
                    k.as_deref().unwrap_or("none")
                )),
            }
        }
        None if meta.kind != "theme" => out.push_str("\n[Theme] none: the project has no active theme, so choose a fitting style from the cards and say so in the notes."),
        None => {}
    }
    out.push_str(&format!(
        "\nArt mode: {}{}",
        mode.as_ref().map(ArtMode::label).unwrap_or_else(|| "not set (pick one that fits; a theme sets it)".into()),
        if meta.art_mode.is_some() { " (override for this artifact)" } else { "" }
    ));
    if meta.kind == "mockup" {
        let imgs = project_images(ws, slug, id);
        if !imgs.is_empty() {
            out.push_str("\nProject sprites you can copy in with copy_asset (artifact id · file):");
            for i in imgs.iter().take(40) {
                out.push_str(&format!(
                    "\n- {} · {} ({}{})",
                    i["artifact"].as_str().unwrap_or(""),
                    i["file"].as_str().unwrap_or(""),
                    i["title"].as_str().unwrap_or(""),
                    i["role"].as_str().map(|r| format!(", {r}")).unwrap_or_default()
                ));
            }
        }
    }
    if meta.kind == "mockup" || meta.kind == "theme" {
        out.push_str("\nCSS tokens injected into HTML: --color-<swatch-name>, --font-heading, --font-body, --pixel-size.");
    }
    out.push_str(&format!(
        "\n[SpriteCook] {} · project: {} · paid calls this turn before the user is asked: {cap}",
        if spritecook_key { "available" } else { "NOT configured (no API key): image steps cannot run" },
        spritecook_project(ws, slug).as_deref().unwrap_or("none yet (create_project, then set_spritecook_project)")
    ));
    if !meta.suggestions.is_empty() {
        out.push_str(&format!("\nChips shown now: {}", meta.suggestions.iter().map(|s| s.label.as_str()).collect::<Vec<_>>().join(", ")));
    }
    Ok(out)
}

/// Hosts an image may be downloaded from: SpriteCook's, or the configured server's.
fn allowed_host(url: &reqwest::Url, server: &str) -> bool {
    let Some(host) = url.host_str() else { return false };
    let server_host = reqwest::Url::parse(server).ok().and_then(|u| u.host_str().map(str::to_string));
    url.scheme() == "https" && (host == "spritecook.ai" || host.ends_with(".spritecook.ai") || server_host.as_deref() == Some(host))
}

const MAX_DOWNLOAD: usize = 60 * 1024 * 1024;

fn ext_for(content_type: &str) -> Option<&'static str> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    Some(match ct.as_str() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/jpeg" | "image/jpg" => "jpg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "application/json" => "json",
        _ => return None,
    })
}

/// Downloads a SpriteCook asset URL (signed links from generate / check_job_status / get_asset_metadata).
fn download(url: &str, server: &str) -> Result<(Vec<u8>, &'static str)> {
    let u = reqwest::Url::parse(url).map_err(|_| AppError::Invalid(format!("not a URL: {url}")))?;
    if !allowed_host(&u, server) {
        return Err(AppError::Invalid("only SpriteCook asset links (https://...spritecook.ai) can be saved".into()));
    }
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|e| AppError::Invalid(format!("http client: {e}")))?;
        let resp = client.get(u).send().await.map_err(|e| AppError::Invalid(format!("download failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Invalid(format!("download failed: HTTP {} (the link may have expired; get a fresh one with get_asset_metadata)", resp.status().as_u16())));
        }
        let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let ext = ext_for(&ct).ok_or_else(|| AppError::Invalid(format!("not an image or video ({ct})")))?;
        if resp.content_length().is_some_and(|n| n as usize > MAX_DOWNLOAD) {
            return Err(AppError::Invalid("the file is over 60 MB".into()));
        }
        let bytes = resp.bytes().await.map_err(|e| AppError::Invalid(format!("download failed: {e}")))?;
        if bytes.len() > MAX_DOWNLOAD {
            return Err(AppError::Invalid("the file is over 60 MB".into()));
        }
        Ok((bytes.to_vec(), ext))
    })
}

/// `name` with the extension the downloaded type needs.
fn with_ext(name: &str, ext: &str) -> String {
    let base = name.trim();
    match base.rsplit_once('.') {
        Some((_, e)) if e.eq_ignore_ascii_case(ext) || (ext == "jpg" && e.eq_ignore_ascii_case("jpeg")) => base.to_string(),
        Some((stem, e)) if e.len() <= 4 => format!("{stem}.{ext}"),
        _ => format!("{base}.{ext}"),
    }
}

fn str_of<'a>(input: &'a Value, k: &str) -> Option<&'a str> {
    input.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// One artifact tool call from Claude (sidecar -> Rust). `id` is the artifact of the thread the
/// turn runs in, so Claude can only ever write into the artifact it is working on.
pub fn run_tool(state: &crate::state::AppState, slug: &str, id: &str, tool: &str, input: &Value) -> Result<Value> {
    let ws = || state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()));
    match tool {
        "artifact_start_version" => {
            let add = str_of(input, "mode") == Some("add");
            let mut brief = str_of(input, "brief").unwrap_or_default().to_string();
            if let Some(p) = input.get("prompts").and_then(Value::as_array).filter(|a| !a.is_empty()) {
                brief.push_str("\n\n### Prompts sent\n");
                for x in p.iter().filter_map(Value::as_str) {
                    brief.push_str(&format!("\n- {}", x.trim()));
                }
            }
            let n = begin_version(&*ws()?, slug, id, add, &brief, None)?;
            Ok(json!({ "version": n, "mode": if add { "add" } else { "new" } }))
        }
        "artifact_save_image" => {
            let url = str_of(input, "url").ok_or_else(|| AppError::Invalid("url is required (sprite_url / spritesheet_url from SpriteCook)".into()))?;
            let name = str_of(input, "name").unwrap_or("image");
            let server = ws()?.get_settings().map(|s| s.spritecook_url).unwrap_or_default();
            // The download runs without the workspace lock.
            let (bytes, ext) = download(url, &server)?;
            let (n, file) = save_file(&*ws()?, slug, id, &with_ext(name, ext), &bytes, str_of(input, "asset_id"), str_of(input, "role"))?;
            Ok(json!({ "version": n, "file": file, "bytes": bytes.len() }))
        }
        "artifact_write_file" => {
            let name = str_of(input, "name").ok_or_else(|| AppError::Invalid("name is required".into()))?;
            let content = input.get("content").and_then(Value::as_str).unwrap_or_default();
            if content.len() > 2_000_000 {
                return Err(AppError::Invalid("the file is over 2 MB".into()));
            }
            let lower = name.to_ascii_lowercase();
            if ![".html", ".css", ".js", ".md", ".json", ".svg", ".txt"].iter().any(|x| lower.ends_with(x)) {
                return Err(AppError::Invalid("write_file takes text files (.html .css .js .md .json .svg .txt); save images with save_image".into()));
            }
            let (n, file) = save_file(&*ws()?, slug, id, name, content.as_bytes(), None, str_of(input, "role"))?;
            Ok(json!({ "version": n, "file": file }))
        }
        "artifact_copy_asset" => {
            let from = str_of(input, "from_artifact").ok_or_else(|| AppError::Invalid("from_artifact is required".into()))?;
            let file = str_of(input, "file").ok_or_else(|| AppError::Invalid("file is required".into()))?;
            let (n, file) = copy_asset(&*ws()?, slug, id, from, file, str_of(input, "name"))?;
            Ok(json!({ "version": n, "file": file }))
        }
        "artifact_set_spritecook_project" => {
            let p = str_of(input, "project_id").ok_or_else(|| AppError::Invalid("project_id is required".into()))?;
            set_spritecook_project(&*ws()?, slug, p)?;
            Ok(json!({ "ok": true }))
        }
        "artifact_set_theme" => set_theme_spec(&*ws()?, slug, id, input),
        "artifact_suggest_next" => {
            let list: Vec<Suggestion> = input
                .get("suggestions")
                .cloned()
                .map(|v| serde_json::from_value(v).map_err(|e| AppError::Invalid(format!("suggestions: {e}"))))
                .transpose()?
                .unwrap_or_default();
            if !(2..=5).contains(&list.len()) {
                return Err(AppError::Invalid("give 2-5 suggestions".into()));
            }
            set_suggestions(&*ws()?, slug, id, list)?;
            Ok(json!({ "ok": true }))
        }
        other => Err(AppError::Invalid(format!("unknown artifact tool {other:?}"))),
    }
}

fn is_hex(s: &str) -> bool {
    let h = s.strip_prefix('#').unwrap_or("");
    matches!(h.len(), 3 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit())
}

fn str_list(input: &Value, k: &str, max: usize) -> Option<Vec<String>> {
    input.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().chars().take(200).collect::<String>()).filter(|s| !s.is_empty()).take(max).collect())
}

/// A font name a style guide may use: web-safe families plus the two Dreamer bundles.
pub const FONTS: [&str; 14] = [
    "Playfair Display", "Nunito", "Georgia", "Times New Roman", "Palatino", "Garamond", "Arial", "Helvetica", "Verdana", "Trebuchet MS", "Tahoma", "Courier New", "Lucida Console", "Impact",
];

/// set_theme: the theme spec of the working version. Only the given keys change (a key art file
/// must exist in the version).
pub fn set_theme_spec(ws: &Workspace, slug: &str, id: &str, input: &Value) -> Result<Value> {
    if read(ws, slug, id)?.kind != "theme" {
        return Err(AppError::Invalid("set_theme is for theme artifacts".into()));
    }
    let n = working_version(ws, slug, id)?;
    let vdir = version_dir(&dir_of(ws, slug, id)?, n);
    let spec = modify(ws, slug, id, |meta| {
        let v = meta.version_mut(n).ok_or_else(|| AppError::NotFound(format!("version {n}")))?;
        let mut t = v.theme.clone().unwrap_or_default();
        if let Some(p) = input.get("palette").and_then(Value::as_array) {
            let mut out = Vec::new();
            for s in p.iter().take(16) {
                let name = s.get("name").and_then(Value::as_str).unwrap_or("").trim();
                let hex = s.get("hex").and_then(Value::as_str).unwrap_or("").trim();
                if name.is_empty() || !is_hex(hex) {
                    return Err(AppError::Invalid(format!("palette entries need a name and a #hex colour (got {name:?} {hex:?})")));
                }
                out.push(Swatch { name: name.chars().take(40).collect(), hex: hex.to_ascii_lowercase() });
            }
            t.palette = out;
        }
        if let Some(f) = input.get("fonts") {
            for (k, slot) in [("heading", &mut t.fonts.heading), ("body", &mut t.fonts.body)] {
                if let Some(name) = f.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                    let known = FONTS.iter().find(|x| x.eq_ignore_ascii_case(name)).ok_or_else(|| AppError::Invalid(format!("font {name:?} is not available; use one of: {}", FONTS.join(", "))))?;
                    *slot = known.to_string();
                }
            }
        }
        if let Some(l) = str_list(input, "mood", 12) {
            t.mood = l;
        }
        if let Some(l) = str_list(input, "dos", 12) {
            t.dos = l;
        }
        if let Some(l) = str_list(input, "donts", 12) {
            t.donts = l;
        }
        if let Some(m) = input.get("art_mode").filter(|v| !v.is_null()) {
            let m: ArtMode = serde_json::from_value(json!({ "mode": m.get("mode"), "pixelSize": m.get("pixel_size").or(m.get("pixelSize")) })).map_err(|e| AppError::Invalid(format!("art_mode: {e}")))?;
            t.art_mode = Some(m.check()?);
        }
        if let Some(k) = input.get("key_art").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            let k = check_file_name(k)?;
            if !vdir.join(&k).is_file() {
                return Err(AppError::NotFound(format!("{k} in v{n}: save the key art with save_image first")));
            }
            t.key_art = Some(k);
        }
        for (k, slot) in [("key_art_asset_id", &mut t.key_art_asset_id), ("preset_id", &mut t.preset_id)] {
            if let Some(x) = input.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                *slot = Some(x.chars().take(100).collect());
            }
        }
        v.theme = Some(t.clone());
        Ok(t)
    })?;
    Ok(json!({ "version": n, "theme": spec }))
}

/// `--color-<name>` for a swatch name ("Rust red" -> "rust-red").
fn css_ident(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn css_font(name: &str) -> String {
    let fallback = if ["Courier New", "Lucida Console"].contains(&name) { "monospace" } else if ["Playfair Display", "Georgia", "Times New Roman", "Palatino", "Garamond"].contains(&name) { "serif" } else { "sans-serif" };
    if name.is_empty() { fallback.into() } else { format!("\"{name}\", {fallback}") }
}

/// The CSS custom properties an HTML artifact gets from its theme (a theme page: from itself).
pub fn theme_css(spec: Option<&ThemeSpec>, mode: Option<&ArtMode>) -> String {
    let mut vars: Vec<String> = Vec::new();
    if let Some(t) = spec {
        for (i, s) in t.palette.iter().enumerate() {
            let id = css_ident(&s.name);
            if !id.is_empty() {
                vars.push(format!("--color-{id}: {};", s.hex));
            }
            vars.push(format!("--palette-{}: {};", i + 1, s.hex));
        }
        vars.push(format!("--font-heading: {};", css_font(&t.fonts.heading)));
        vars.push(format!("--font-body: {};", css_font(&t.fonts.body)));
    }
    if let Some(m) = mode {
        vars.push(format!("--pixel-size: {}px;", m.pixel_size.unwrap_or(1)));
        vars.push(format!("--art-mode: {};", m.mode));
        if m.mode == "pixel" {
            vars.push("--image-rendering: pixelated;".into());
        }
    }
    format!(":root {{ {} }}", vars.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    const INBOX_SLUG: &str = "ideas";
    use tempfile::TempDir;

    fn ws() -> (TempDir, Workspace) {
        let dir = TempDir::new().unwrap();
        let ws = Workspace::open(dir.path().join("Dreamer")).unwrap();
        (dir, ws)
    }

    fn new(kind: &str) -> NewArtifact {
        NewArtifact { kind: kind.into(), title: Some(format!("A {kind}")), brief: "the brief".into(), ..Default::default() }
    }

    #[test]
    fn create_makes_an_artifact_card_and_its_folder() {
        let (_d, ws) = ws();
        let src = ws.create_card(INBOX_SLUG, NewCard { title: Some("Fish priest".into()), ..Default::default() }).unwrap();
        let card = create(&ws, INBOX_SLUG, NewArtifact { source_card: Some(src.meta.id.clone()), ..new("character") }).unwrap();
        assert_eq!(card.meta.kind, CardKind::Artifact);
        assert_eq!(card.meta.fields.get("artifactType"), Some(&json!("character")));
        assert_eq!(card.meta.links, vec![Link { to: src.meta.id.clone(), label: Some("visualizes".into()) }]);
        let meta = read(&ws, INBOX_SLUG, &card.meta.id).unwrap();
        assert_eq!((meta.kind.as_str(), meta.current_version, meta.source_card.as_deref()), ("character", 0, Some(src.meta.id.as_str())));
        assert!(create(&ws, INBOX_SLUG, new("poster")).is_err(), "unknown type");
        // The card round-trips as kind artifact.
        assert_eq!(ws.read_card(INBOX_SLUG, &card.meta.id).unwrap().meta.kind, CardKind::Artifact);
    }

    #[test]
    fn feedback_makes_a_new_version_and_never_touches_the_old_one() {
        let (_d, ws) = ws();
        let id = create(&ws, INBOX_SLUG, new("character")).unwrap().meta.id;
        // A file before any version starts v1 by itself.
        let (n, f) = save_file(&ws, INBOX_SLUG, &id, "hero.png", b"v1-hero", Some("asset-1"), Some("hero")).unwrap();
        assert_eq!((n, f.as_str()), (1, "hero.png"));
        // An add-on lands in v1.
        assert_eq!(begin_version(&ws, INBOX_SLUG, &id, true, "turnaround", None).unwrap(), 1);
        save_file(&ws, INBOX_SLUG, &id, "turnaround.png", b"turn", Some("asset-2"), Some("turnaround")).unwrap();
        // Feedback: v2 with parent 1.
        assert_eq!(begin_version(&ws, INBOX_SLUG, &id, false, "bigger hat", Some("sonnet")).unwrap(), 2);
        save_file(&ws, INBOX_SLUG, &id, "hero.png", b"v2-hero", Some("asset-3"), Some("hero")).unwrap();
        assert_eq!(read_file(&ws, INBOX_SLUG, &id, 1, "hero.png").unwrap(), b"v1-hero");
        assert_eq!(read_file(&ws, INBOX_SLUG, &id, 2, "hero.png").unwrap(), b"v2-hero");
        assert_eq!(read_file(&ws, INBOX_SLUG, &id, 2, "turnaround.png").unwrap(), b"turn", "v2 starts as a copy of v1");
        let meta = read(&ws, INBOX_SLUG, &id).unwrap();
        assert_eq!(meta.current_version, 2);
        assert_eq!(meta.version(2).unwrap().parent, Some(1));
        assert_eq!(meta.version(1).unwrap().files.iter().map(|f| f.asset_id.clone().unwrap()).collect::<Vec<_>>(), vec!["asset-1", "asset-2"]);
        let info = version_info(&ws, INBOX_SLUG, &id, 1).unwrap();
        assert!(info["brief"].as_str().unwrap().contains("turnaround"));
        record_turn(&ws, INBOX_SLUG, &id, Some("claude-sonnet"), &["job-1".into()], 3.0).unwrap();
        record_turn(&ws, INBOX_SLUG, &id, None, &["job-1".into(), "job-2".into()], 2.0).unwrap();
        let m2 = version_info(&ws, INBOX_SLUG, &id, 2).unwrap()["meta"].clone();
        assert_eq!((m2["parent"].as_u64(), m2["credits"].as_f64(), m2["jobs"].as_array().unwrap().len()), (Some(1), Some(5.0), 2));
        assert_eq!(read(&ws, INBOX_SLUG, &id).unwrap().version(2).unwrap().credits, 5.0);
    }

    #[test]
    fn approved_versions_keep_their_files() {
        let (_d, ws) = ws();
        let id = create(&ws, INBOX_SLUG, new("concept")).unwrap().meta.id;
        save_file(&ws, INBOX_SLUG, &id, "concept.png", b"a", None, None).unwrap();
        update(&ws, INBOX_SLUG, &id, ArtifactPatch { approved_version: Some(1), ..Default::default() }).unwrap();
        let (_, name) = save_file(&ws, INBOX_SLUG, &id, "concept.png", b"b", None, None).unwrap();
        assert_eq!(name, "concept-2.png");
        assert_eq!(read_file(&ws, INBOX_SLUG, &id, 1, "concept.png").unwrap(), b"a");
        assert!(update(&ws, INBOX_SLUG, &id, ArtifactPatch { approved_version: Some(9), ..Default::default() }).is_err());
        update(&ws, INBOX_SLUG, &id, ArtifactPatch { approved_version: Some(0), ..Default::default() }).unwrap();
        assert_eq!(read(&ws, INBOX_SLUG, &id).unwrap().approved_version, None);
    }

    #[test]
    fn file_names_stay_inside_the_version() {
        for bad in ["../x.png", "a/b.png", "brief.md", "meta.json", ".hidden", "sp ace.png", ""] {
            assert!(check_file_name(bad).is_err(), "{bad}");
        }
        assert_eq!(check_file_name("assets/btn_9.png").unwrap(), "assets/btn_9.png");
        assert_eq!(check_file_name("assets\\x.png").unwrap(), "assets/x.png");
        assert_eq!(check_file_name("index.html").unwrap(), "index.html");
    }

    #[test]
    fn spritecook_project_and_suggestions_are_stored() {
        let (_d, ws) = ws();
        assert_eq!(spritecook_project(&ws, INBOX_SLUG), None);
        set_spritecook_project(&ws, INBOX_SLUG, "proj-123").unwrap();
        assert_eq!(spritecook_project(&ws, INBOX_SLUG).as_deref(), Some("proj-123"));
        assert!(set_spritecook_project(&ws, INBOX_SLUG, "has space").is_err());
        let id = create(&ws, INBOX_SLUG, new("character")).unwrap().meta.id;
        let s = |l: &str| Suggestion { label: l.into(), prompt: format!("do {l}"), est_credits: Some(1.0) };
        set_suggestions(&ws, INBOX_SLUG, &id, vec![s("a"), s("b"), s("c"), s("d"), s("e"), s("f"), Suggestion { label: " ".into(), prompt: "x".into(), est_credits: None }]).unwrap();
        assert_eq!(read(&ws, INBOX_SLUG, &id).unwrap().suggestions.len(), 5);
    }

    fn theme(ws: &Workspace, title: &str, hex: &str, mode: &str) -> String {
        let id = create(ws, INBOX_SLUG, NewArtifact { title: Some(title.into()), ..new("theme") }).unwrap().meta.id;
        save_file(ws, INBOX_SLUG, &id, "key-art.png", b"art", Some(&format!("ka-{title}")), Some("key-art")).unwrap();
        set_theme_spec(
            ws,
            INBOX_SLUG,
            &id,
            &json!({ "palette": [{ "name": "Rust red", "hex": hex }], "fonts": { "heading": "playfair display", "body": "Nunito" }, "mood": ["oily"], "art_mode": { "mode": mode, "pixel_size": 16 }, "key_art": "key-art.png", "key_art_asset_id": format!("ka-{title}"), "preset_id": format!("p-{title}") }),
        )
        .unwrap();
        id
    }

    #[test]
    fn two_themes_the_active_one_is_inherited_and_overrides_win() {
        let (_d, ws) = ws();
        let a = theme(&ws, "Rust", "#AA3322", "pixel");
        let b = theme(&ws, "Neon", "#00ffcc", "hd");
        let ch = create(&ws, INBOX_SLUG, new("character")).unwrap().meta.id;
        let meta = || read(&ws, INBOX_SLUG, &ch).unwrap();
        assert!(inherited_theme(&ws, INBOX_SLUG, &ch, &meta()).is_none(), "no active theme yet");
        set_active_theme(&ws, INBOX_SLUG, Some(&a)).unwrap();
        let t = inherited_theme(&ws, INBOX_SLUG, &ch, &meta()).unwrap();
        assert_eq!((t.id.as_str(), t.spec.palette[0].hex.as_str(), t.spec.fonts.heading.as_str()), (a.as_str(), "#aa3322", "Playfair Display"));
        assert_eq!(effective_art_mode(&meta(), Some(&t)).unwrap().label(), "pixel 16px");
        let block = context_block(&ws, INBOX_SLUG, &ch, 4, true).unwrap();
        assert!(block.contains("preset p-Rust") && block.contains("key art asset ka-Rust") && block.contains("active theme"), "{block}");
        // Switching the active theme changes what it inherits.
        set_active_theme(&ws, INBOX_SLUG, Some(&b)).unwrap();
        assert_eq!(inherited_theme(&ws, INBOX_SLUG, &ch, &meta()).unwrap().id, b);
        // A per-artifact theme and art mode win over the active theme.
        update(&ws, INBOX_SLUG, &ch, ArtifactPatch { theme_id: Some(a.clone()), art_mode: Some(Some(ArtMode { mode: "hd".into(), pixel_size: Some(4) })), ..Default::default() }).unwrap();
        let t = inherited_theme(&ws, INBOX_SLUG, &ch, &meta()).unwrap();
        assert_eq!(t.id, a);
        assert_eq!(effective_art_mode(&meta(), Some(&t)).unwrap(), ArtMode { mode: "hd".into(), pixel_size: None });
        assert!(context_block(&ws, INBOX_SLUG, &ch, 4, false).unwrap().contains("NOT configured"));
        // CSS tokens for HTML artifacts.
        let css = theme_css(Some(&t.spec), Some(&ArtMode { mode: "pixel".into(), pixel_size: Some(16) }));
        assert!(css.contains("--color-rust-red: #aa3322;") && css.contains("--font-heading: \"Playfair Display\", serif;") && css.contains("--pixel-size: 16px;"), "{css}");
        // Only themes can be active; bad input is refused.
        assert!(set_active_theme(&ws, INBOX_SLUG, Some(&ch)).is_err());
        assert!(set_theme_spec(&ws, INBOX_SLUG, &a, &json!({ "palette": [{ "name": "x", "hex": "red" }] })).is_err());
        assert!(set_theme_spec(&ws, INBOX_SLUG, &a, &json!({ "fonts": { "heading": "Comic Sans Pro" } })).is_err());
        assert!(set_theme_spec(&ws, INBOX_SLUG, &a, &json!({ "key_art": "missing.png" })).is_err());
        assert_eq!(themes(&ws, INBOX_SLUG).len(), 2);
        // A new theme version keeps the parent's spec until changed.
        begin_version(&ws, INBOX_SLUG, &a, false, "warmer", None).unwrap();
        assert_eq!(read(&ws, INBOX_SLUG, &a).unwrap().version(2).unwrap().theme.as_ref().unwrap().palette[0].hex, "#aa3322");
    }

    #[test]
    fn html_is_sandboxed_and_self_contained() {
        let (_d, ws) = ws();
        let t = theme(&ws, "Rust", "#aa3322", "pixel");
        set_active_theme(&ws, INBOX_SLUG, Some(&t)).unwrap();
        let id = create(&ws, INBOX_SLUG, new("mockup")).unwrap().meta.id;
        save_file(&ws, INBOX_SLUG, &id, "assets/btn.png", b"PNG", None, Some("ui-kit")).unwrap();
        save_file(&ws, INBOX_SLUG, &id, "style.css", b".b { background: url(assets/btn.png); }", None, None).unwrap();
        let page = "<html><head><script>window.x = 1</script><link rel=\"stylesheet\" href=\"style.css\"></head><body><img src='assets/btn.png'><img src=\"https://evil.example/x.png\"><a href=\"#top\">t</a></body></html>";
        save_file(&ws, INBOX_SLUG, &id, "index.html", page.as_bytes(), None, Some("html")).unwrap();
        let out = render_html(&ws, INBOX_SLUG, &id, 1, "").unwrap();
        let csp = out.find("Content-Security-Policy").unwrap();
        assert!(csp < out.find("<script").unwrap(), "the policy comes before any script");
        assert!(out.contains("default-src 'none'") && out.contains("connect-src 'none'"));
        assert!(out.contains("src='data:image/png;base64,UE5H'"), "local image inlined: {out}");
        assert!(out.contains("href=\"data:text/css;base64,"), "stylesheet inlined");
        assert!(out.contains("https://evil.example/x.png"), "remote refs are left for the CSP to block");
        assert!(out.contains("--color-rust-red: #aa3322;"), "theme tokens injected");
        assert!(out.contains("href=\"#top\""));
        // The stylesheet's own url() was inlined too.
        let css_b64 = out.split("href=\"data:text/css;base64,").nth(1).unwrap().split('"').next().unwrap();
        use base64::Engine;
        let css = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(css_b64).unwrap()).unwrap();
        assert!(css.contains("url(data:image/png;base64,UE5H)"), "{css}");
        // A fragment without <head> still gets the policy first.
        save_file(&ws, INBOX_SLUG, &id, "index.html", b"<div>hi</div>", None, None).unwrap();
        assert!(render_html(&ws, INBOX_SLUG, &id, 1, "").unwrap().starts_with("<!doctype html><html><head><meta charset"));
    }

    #[test]
    fn handoff_takes_only_approved_versions_and_the_active_theme() {
        let (_d, ws) = ws();
        let t = theme(&ws, "Rust lake", "#aa3322", "pixel");
        set_active_theme(&ws, INBOX_SLUG, Some(&t)).unwrap();
        let ch = create(&ws, INBOX_SLUG, NewArtifact { title: Some("Fish priest".into()), ..new("character") }).unwrap().meta.id;
        save_file(&ws, INBOX_SLUG, &ch, "hero.png", b"v1", None, Some("hero")).unwrap();
        begin_version(&ws, INBOX_SLUG, &ch, false, "bigger hat", None).unwrap();
        save_file(&ws, INBOX_SLUG, &ch, "hero.png", b"v2", None, Some("hero")).unwrap();
        let other = create(&ws, INBOX_SLUG, NewArtifact { title: Some("Docks".into()), ..new("concept") }).unwrap().meta.id;
        save_file(&ws, INBOX_SLUG, &other, "concept.png", b"c", None, None).unwrap();
        // Nothing approved: no artifact section, but the active theme is the style guide.
        let p = handoff(&ws, INBOX_SLUG);
        assert!(!p.section.contains("## Artifacts"));
        assert!(p.section.contains("## Style guide: Rust lake") && p.section.contains("| Rust red | `#aa3322` |") && p.section.contains("Art mode: pixel 16px"), "{}", p.section);
        assert_eq!(p.assets.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["rust-lake/key-art.png"]);
        // Approve v1 of the character only.
        update(&ws, INBOX_SLUG, &ch, ArtifactPatch { approved_version: Some(1), ..Default::default() }).unwrap();
        let p = handoff(&ws, INBOX_SLUG);
        assert!(p.section.contains("### Fish priest") && p.section.contains("v1 (approved)") && p.section.contains("Theme: Rust lake"));
        assert!(p.section.contains("`assets/fish-priest/hero.png`") && !p.section.contains("Docks"), "unapproved artifacts are ignored");
        let hero = p.assets.iter().find(|(n, _)| n == "fish-priest/hero.png").unwrap();
        assert_eq!(fs::read(&hero.1).unwrap(), b"v1", "the approved version, not the current one");
        assert!(p.prompt_note.contains("Fish priest"));
    }

    #[test]
    fn copy_asset_brings_a_project_sprite_into_a_mockup() {
        let (_d, ws) = ws();
        let ch = create(&ws, INBOX_SLUG, new("character")).unwrap().meta.id;
        save_file(&ws, INBOX_SLUG, &ch, "hero.png", b"sprite", Some("a1"), Some("hero")).unwrap();
        let mock = create(&ws, INBOX_SLUG, new("mockup")).unwrap().meta.id;
        let imgs = project_images(&ws, INBOX_SLUG, &mock);
        assert_eq!(imgs.len(), 1);
        let (n, name) = copy_asset(&ws, INBOX_SLUG, &mock, &ch, "hero.png", Some("player.png")).unwrap();
        assert_eq!((n, name.as_str()), (1, "assets/player.png"));
        assert_eq!(read_file(&ws, INBOX_SLUG, &mock, 1, "assets/player.png").unwrap(), b"sprite");
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    #[default]
    Mist,
    Reverie,
    Lucid,
    Dream,
    /// Built in the repo (a `build` block in the frontmatter tracks what and whether it drifted).
    Built,
}

/// Lenient: case-insensitive, and unknown values fall back to Mist (files may be hand-edited).
impl<'de> Deserialize<'de> for Stage {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.trim().to_lowercase().as_str() {
            "reverie" => Stage::Reverie,
            "lucid" => Stage::Lucid,
            "dream" => Stage::Dream,
            "built" => Stage::Built,
            _ => Stage::Mist,
        })
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    User,
    Claude,
}

impl<'de> Deserialize<'de> for Source {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(if s.trim().eq_ignore_ascii_case("claude") { Source::Claude } else { Source::User })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Link {
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// What a card is on the canvas. Lenient like `Stage`: missing or unknown = `Card`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    #[default]
    Card,
    Sticky,
    Label,
    Checklist,
    Image,
    Clip,
    /// A visual artifact (theme, character, concept, mockup); its files live in artifacts/<id>/.
    Artifact,
}

impl<'de> Deserialize<'de> for CardKind {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.trim().to_lowercase().as_str() {
            "sticky" => CardKind::Sticky,
            "label" => CardKind::Label,
            "checklist" => CardKind::Checklist,
            "image" => CardKind::Image,
            "clip" => CardKind::Clip,
            "artifact" => CardKind::Artifact,
            _ => CardKind::Card,
        })
    }
}

/// Card roles (at most one live card per role per project): the project's "Tech & constraints"
/// card, and the "Project decisions" card the handoff gap interview writes answers into.
pub const ROLE_TECH: &str = "tech";
pub const ROLE_DECISIONS: &str = "decisions";
/// The checklist card holding questions Claude Code left in the repo's docs/design/QUESTIONS.md.
pub const ROLE_CC_QUESTIONS: &str = "cc-questions";
pub const ROLES: [&str; 3] = [ROLE_TECH, ROLE_DECISIONS, ROLE_CC_QUESTIONS];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ChecklistItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub done: bool,
    /// An open question rather than a to-do.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub question: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// The raw QUESTIONS.md line this item was imported from (cc-questions card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Something attached to a card. Paths are relative to the project dir and always under `media/`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Attachment {
    Image {
        #[serde(default)]
        id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caption: Option<String>,
    },
    Clip {
        #[serde(default)]
        id: String,
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        site: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        favicon: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thumb: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        excerpt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caption: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fetched_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fetch_error: Option<String>,
    },
}

impl Attachment {
    pub fn id(&self) -> &str {
        match self {
            Attachment::Image { id, .. } | Attachment::Clip { id, .. } => id,
        }
    }
    pub fn set_id(&mut self, new: String) {
        match self {
            Attachment::Image { id, .. } | Attachment::Clip { id, .. } => *id = new,
        }
    }
    /// What makes two attachments "the same thing" when merging: the image path or the clip url.
    pub fn key(&self) -> &str {
        match self {
            Attachment::Image { path, .. } => path,
            Attachment::Clip { url, .. } => url,
        }
    }
    /// Every project-relative file this attachment points at.
    pub fn media_paths(&self) -> Vec<&str> {
        match self {
            Attachment::Image { path, .. } => vec![path.as_str()],
            Attachment::Clip { favicon, thumb, excerpt, .. } => [favicon, thumb, excerpt].into_iter().flatten().map(String::as_str).collect(),
        }
    }
    /// Media paths must stay inside the project's `media/` folder; a clip needs a url.
    pub fn validate(&self) -> std::result::Result<(), String> {
        for p in self.media_paths() {
            let ok = p.starts_with("media/") && !p.contains('\\') && !p.split('/').any(|s| s == ".." || s.is_empty());
            if !ok {
                return Err(format!("attachment path must be under media/: {p:?}"));
            }
        }
        if let Attachment::Clip { url, .. } = self {
            if url.trim().is_empty() {
                return Err("a clip needs a url".into());
            }
        }
        Ok(())
    }
}

/// Concatenates attachment lists, keeping the first of any with the same path/url and giving
/// missing or duplicate ids a fresh one.
pub fn merge_attachments<'a>(lists: impl IntoIterator<Item = &'a [Attachment]>) -> Vec<Attachment> {
    let mut out: Vec<Attachment> = Vec::new();
    for a in lists.into_iter().flatten() {
        if out.iter().any(|o| std::mem::discriminant(o) == std::mem::discriminant(a) && o.key() == a.key()) {
            continue;
        }
        let mut a = a.clone();
        if a.id().is_empty() || out.iter().any(|o| o.id() == a.id()) {
            a.set_id(ulid::Ulid::generate().to_string());
        }
        out.push(a);
    }
    out
}

/// `update_attachment`'s patch: a JSON object merged over the attachment. `null` clears an optional
/// key; `id` and `type` can't be changed.
pub fn patch_attachment(att: &Attachment, patch: &Value) -> std::result::Result<Attachment, String> {
    let Value::Object(p) = patch else { return Err("attachment patch must be an object".into()) };
    let mut v = serde_json::to_value(att).map_err(|e| e.to_string())?;
    let obj = v.as_object_mut().expect("attachments serialize to objects");
    for (k, val) in p {
        if k == "id" || k == "type" {
            continue;
        }
        if val.is_null() {
            obj.remove(k);
        } else {
            obj.insert(k.clone(), val.clone());
        }
    }
    let out: Attachment = serde_json::from_value(v).map_err(|e| format!("invalid attachment patch: {e}"))?;
    out.validate()?;
    Ok(out)
}

/// One file for `save_media`.
#[derive(Deserialize, Debug)]
pub struct MediaUpload {
    pub name_hint: String,
    pub bytes: Vec<u8>,
}

/// Lenient list reader: entries that don't parse are skipped instead of failing the whole card.
fn lenient_list<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(d: D) -> std::result::Result<Vec<T>, D::Error> {
    let raw = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

/// Card file frontmatter. Unknown keys are preserved in `extra` so external edits are never lost.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Frontmatter {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub kind: CardKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub stage: Stage,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, Value>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub source: Source,
    #[serde(default)]
    pub ghost: bool,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<Value>,
    #[serde(default, deserialize_with = "lenient_list", skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<ChecklistItem>,
    /// QUESTIONS.md lines whose items were deleted from the cc-questions card: never re-imported.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dismissed_sources: Vec<String>,
    /// Display order; the first image is the cover.
    #[serde(default, deserialize_with = "lenient_list")]
    pub attachments: Vec<Attachment>,
    /// The card this one was copied from (a new project version, or "Apply to" in Compare). Set on
    /// copy, never changed after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// The bundle and ref this card was imported from (a re-sent bundle updates it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<ImportRef>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Where an imported card came from (`.dreamer.md` bundle id + the card's ref in it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ImportRef {
    pub bundle_id: String,
    #[serde(rename = "ref")]
    pub r#ref: String,
    #[serde(default)]
    pub source: String,
}

/// A card's lineage: the card it was copied from and the version (folder id) that card was in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Origin {
    pub card: String,
    #[serde(default)]
    pub version: String,
}

impl Frontmatter {
    /// Round-2 cards kept one image/clip in `fields.image` / `fields.url` / `fields.clip_title`.
    /// They're exposed as attachments (image first, then clip, ahead of any others) and the keys
    /// leave `fields`, so the next write drops them. Ids are fixed so repeated reads agree.
    pub fn migrate_legacy_fields(&mut self) {
        let str_field = |f: &BTreeMap<String, Value>, k: &str| f.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let mut legacy: Vec<(Vec<&str>, Attachment)> = Vec::new();
        if let Some(path) = str_field(&self.fields, "image") {
            legacy.push((vec!["image"], Attachment::Image { id: "legacy-image".into(), path, caption: None }));
        }
        if let Some(url) = str_field(&self.fields, "url") {
            let title = str_field(&self.fields, "clip_title");
            let keys = if self.fields.contains_key("clip_title") { vec!["url", "clip_title"] } else { vec!["url"] };
            let clip = Attachment::Clip {
                id: "legacy-clip".into(),
                url,
                title,
                description: None,
                site: None,
                favicon: None,
                thumb: None,
                excerpt: None,
                caption: None,
                fetched_at: None,
                fetch_error: None,
            };
            legacy.push((keys, clip));
        }
        let mut front = Vec::new();
        for (keys, att) in legacy {
            if att.validate().is_err() {
                continue; // not something we understand: leave it in fields
            }
            for k in keys {
                self.fields.remove(k);
            }
            if !self.attachments.iter().any(|a| std::mem::discriminant(a) == std::mem::discriminant(&att) && a.key() == att.key()) {
                front.push(att);
            }
        }
        if !front.is_empty() {
            front.append(&mut self.attachments);
            self.attachments = front;
        }
    }
}

/// A card as the UI sees it: frontmatter fields plus the markdown body.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Card {
    #[serde(flatten)]
    pub meta: Frontmatter,
    #[serde(default)]
    pub body: String,
}

#[derive(Deserialize, Debug, Default)]
pub struct NewCard {
    pub title: Option<String>,
    pub body: Option<String>,
    pub stage: Option<Stage>,
    pub tags: Option<Vec<String>>,
    pub fields: Option<BTreeMap<String, Value>>,
    pub links: Option<Vec<Link>>,
    pub source: Option<Source>,
    pub ghost: Option<bool>,
    pub branch: Option<Value>,
    /// Ids of the cards a merge ghost would replace (stored as frontmatter `merged_from`).
    #[serde(default)]
    pub merged_from: Option<Vec<String>>,
    pub kind: Option<CardKind>,
    pub role: Option<String>,
    pub color: Option<String>,
    pub items: Option<Vec<ChecklistItem>>,
    pub attachments: Option<Vec<Attachment>>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The folder whose canvas the card lands on (None = the open version, or the root without versions).
    #[serde(default)]
    pub folder: Option<String>,
    /// Lineage of a card copied across versions (Compare's "Apply to").
    #[serde(default)]
    pub origin: Option<Origin>,
    #[serde(default)]
    pub import: Option<ImportRef>,
    /// A bundle's build block, kept in the frontmatter as-is.
    #[serde(default)]
    pub build: Option<Value>,
}

#[derive(Deserialize, Debug, Default)]
pub struct CardPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub stage: Option<Stage>,
    pub tags: Option<Vec<String>>,
    pub fields: Option<BTreeMap<String, Value>>,
    pub links: Option<Vec<Link>>,
    pub ghost: Option<bool>,
    pub kind: Option<CardKind>,
    /// `Some("")` clears it.
    pub role: Option<String>,
    /// `Some("")` clears it.
    pub color: Option<String>,
    pub items: Option<Vec<ChecklistItem>>,
    pub dismissed_sources: Option<Vec<String>>,
    pub attachments: Option<Vec<Attachment>>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
impl Default for Viewport {
    fn default() -> Self {
        Viewport { x: 0.0, y: 0.0, zoom: 1.0 }
    }
}

/// A card's place on the canvas. `w`/`h` are only present once the user has resized the card
/// (absent = default width, auto height). `z` is the stacking order (higher = in front); `back`
/// remembers an explicit "Send to back" so the UI never auto-raises that card.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Pos {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<i64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub back: bool,
    /// Position pinned: drags, align and auto-layout leave it where it is.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}

pub const MIN_CARD_W: f64 = 160.0;
pub const MIN_CARD_H: f64 = 90.0;
pub const MAX_CARD_SIDE: f64 = 4000.0;

impl Pos {
    pub fn at(x: f64, y: f64) -> Pos {
        Pos { x, y, ..Default::default() }
    }
}

/// A titled region drawn behind cards. Pure layout: membership is "inside the rectangle".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub z: i64,
}

pub const MIN_FRAME_SIDE: f64 = 80.0;
pub const MAX_FRAME_SIDE: f64 = 100_000.0;
/// v2 added `frames`, v3 `folders`. Older files read fine (none of either) and are written back as v3.
pub const CANVAS_VERSION: u32 = 3;

/// A folder inside a project (one record in folders.json). Its contents live on its own canvas,
/// `canvases/<id>.json`; card files stay flat in cards/.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Folder {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Parent folder id; None = the project root.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nudge_off: bool,
    /// "version" for a project version (always top-level); absent = an ordinary folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// A version: the version it was copied from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_from: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub const KIND_VERSION: &str = "version";

impl Folder {
    pub fn is_version(&self) -> bool {
        self.kind.as_deref() == Some(KIND_VERSION) && self.parent.is_none()
    }
    pub fn name(&self) -> String {
        if self.title.trim().is_empty() { "Untitled folder".into() } else { self.title.trim().to_string() }
    }
}

/// folders.json.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct FolderIndex {
    #[serde(default)]
    pub folders: Vec<Folder>,
}

/// One `save_layout` call: canvases to write (key "" = the root canvas) and, when present, the
/// whole folder list (folders that left it lose their canvas file).
#[derive(Deserialize, Debug, Default)]
pub struct LayoutWrite {
    #[serde(default)]
    pub canvases: BTreeMap<String, Canvas>,
    #[serde(default)]
    pub folders: Option<Vec<Folder>>,
}

/// canvas.json / canvases/<folder>.json: camera, card and child-folder positions, frames.
/// Links live in each card's frontmatter.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Canvas {
    pub version: u32,
    #[serde(default)]
    pub viewport: Viewport,
    #[serde(default)]
    pub cards: BTreeMap<String, Pos>,
    #[serde(default)]
    pub frames: BTreeMap<String, Frame>,
    /// Child folders shown on this canvas.
    #[serde(default)]
    pub folders: BTreeMap<String, Pos>,
}
impl Default for Canvas {
    fn default() -> Self {
        Canvas { version: CANVAS_VERSION, viewport: Viewport::default(), cards: BTreeMap::new(), frames: BTreeMap::new(), folders: BTreeMap::new() }
    }
}

impl Canvas {
    /// The highest stacking order in use (0 when no card has one yet).
    pub fn max_z(&self) -> i64 {
        self.cards.values().chain(self.folders.values()).filter_map(|p| p.z).max().unwrap_or(0)
    }

    /// Repairs values a hand edit (or a bug) could leave behind: non-finite coordinates are
    /// reset, sizes are clamped to sane bounds, and a non-finite size falls back to "auto".
    pub fn sanitize(&mut self) {
        for p in self.cards.values_mut().chain(self.folders.values_mut()) {
            if !p.x.is_finite() {
                p.x = 0.0;
            }
            if !p.y.is_finite() {
                p.y = 0.0;
            }
            p.w = p.w.filter(|v| v.is_finite()).map(|v| v.clamp(MIN_CARD_W, MAX_CARD_SIDE));
            p.h = p.h.filter(|v| v.is_finite()).map(|v| v.clamp(MIN_CARD_H, MAX_CARD_SIDE));
        }
        let side = |v: f64| if v.is_finite() { v.clamp(MIN_FRAME_SIDE, MAX_FRAME_SIDE) } else { MIN_FRAME_SIDE };
        for f in self.frames.values_mut() {
            if !f.x.is_finite() {
                f.x = 0.0;
            }
            if !f.y.is_finite() {
                f.y = 0.0;
            }
            f.w = side(f.w);
            f.h = side(f.h);
        }
        self.version = CANVAS_VERSION;
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectMeta {
    pub name: String,
    /// Optional per-project theme override (theme id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default)]
    pub created: String,
    /// Repo folder the handoff pack is copied into (docs/design/ + the CLAUDE.md block).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_target: Option<String>,
    /// The target the user confirmed writing into (the first-use confirm). Copying happens only
    /// while this equals `handoff_target`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_target_confirmed: Option<String>,
    /// The project version (folder id) that opens by default; also the "open version" Claude works in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_version: Option<String>,
    /// Keys Dreamer doesn't know (hand edits, newer versions) survive a rewrite.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl ProjectMeta {
    pub fn named(name: &str) -> ProjectMeta {
        ProjectMeta { name: name.into(), theme: None, created: now_stamp(), handoff_target: None, handoff_target_confirmed: None, last_version: None, extra: BTreeMap::new() }
    }
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectSummary {
    pub slug: String,
    pub name: String,
    pub theme: Option<String>,
    pub card_count: usize,
    pub is_inbox: bool,
    /// Handoff pack versions under design/ (design/index.json).
    #[serde(default)]
    pub design_versions: usize,
    /// Unanswered lines in the handoff repo's docs/design/QUESTIONS.md.
    #[serde(default)]
    pub open_questions: usize,
}

#[derive(Deserialize, Debug, Default)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// Theme id; an empty string clears the override.
    pub theme: Option<String>,
    /// Repo folder for the handoff pack; an empty string clears it (and its confirmation).
    pub handoff_target: Option<String>,
    /// Records that the user confirmed this exact target (first use).
    pub handoff_target_confirmed: Option<String>,
    /// Hides the root canvas's "Tidy this folder?" hint (folders keep theirs in folders.json).
    #[serde(default)]
    pub nudge_off: Option<bool>,
    /// The version that opens by default (must be a version folder).
    #[serde(default)]
    pub last_version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub version: u32,
    pub theme: String,
    pub hotkey: String,
    /// "Clipboard to Inbox" global shortcut.
    #[serde(default = "default_clip_hotkey")]
    pub clipboard_hotkey: String,
    #[serde(default)]
    pub last_project: Option<String>,
    /// Left panel (projects) shown. Older files without the key show it.
    #[serde(default = "yes")]
    pub show_projects: bool,
    /// Right panel (Claude chat) shown.
    #[serde(default = "yes")]
    pub show_chat: bool,
    /// Left panel width in px (180-420).
    #[serde(default = "default_side_w")]
    pub side_w: u32,
    /// Chat panel width in px (280-720).
    #[serde(default = "default_chat_w")]
    pub chat_w: u32,
    /// The one-time "Dreamer is still running in the tray" notice has been seen.
    #[serde(default)]
    pub tray_notice_shown: bool,
    /// Launch Dreamer when Windows starts (the real state is the autostart plugin's Run entry).
    #[serde(default = "yes")]
    pub start_with_windows: bool,
    /// On a Windows-start launch, stay in the tray without opening the window.
    #[serde(default = "yes")]
    pub start_hidden: bool,
    /// Claude model for chat sessions (an alias like "sonnet" or a full model id).
    #[serde(default = "default_model_chat")]
    pub model_chat: String,
    /// Route chat turns between the fast / main (`model_chat`) / deep models. See router.rs.
    #[serde(default = "yes")]
    pub model_router: bool,
    /// Chat model for simple actions and lookups (router "fast").
    #[serde(default = "default_model_fast")]
    pub model_fast: String,
    /// Chat model for turns with "Think" on (router "deep").
    #[serde(default = "default_model_deep")]
    pub model_deep: String,
    /// Claude model for the handoff pack sessions (gap check and generation).
    #[serde(default = "default_model_export")]
    pub model_export: String,
    /// Claude model for build runs (never the local model).
    #[serde(default = "default_model_build")]
    pub build_model: String,
    /// Claude model for one-shot thread summaries (auto-compact).
    #[serde(default = "default_model_memory")]
    pub model_memory: String,
    /// A thread is summarized into a fresh session once its last turn read more input tokens than this.
    #[serde(default = "default_compact_tokens")]
    pub compact_tokens: u64,
    /// Word cap of a project's memory.md.
    #[serde(default = "default_memory_cap")]
    pub memory_cap: u64,
    /// Everyday chat turns (router fast and main) run on a local model through Ollama.
    #[serde(default = "yes")]
    pub local_chat: bool,
    /// The Ollama model for local turns (Dreamer runs a 64k-context copy of it, see ollama.rs).
    #[serde(default = "default_local_model")]
    pub local_model: String,
    /// The folder picked with "Locate ollama.exe…" (searched first); empty = none.
    #[serde(default)]
    pub ollama_path: String,
    /// The cloud model was declined on a PC whose GPU is too small for a local one: chat stays on Claude.
    #[serde(default)]
    pub local_cloud_declined: bool,
    /// SpriteCook's remote MCP server (artifact images). The API key is in the OS credential store.
    #[serde(default = "default_spritecook_url")]
    pub spritecook_url: String,
    /// Paid SpriteCook calls an artifact turn may make before it pauses for a confirm.
    #[serde(default = "default_credit_cap")]
    pub credit_cap: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
fn yes() -> bool {
    true
}
pub const SIDE_W: (u32, u32, u32) = (180, 224, 420);
pub const CHAT_W: (u32, u32, u32) = (280, 340, 720);
fn default_side_w() -> u32 {
    SIDE_W.1
}
fn default_chat_w() -> u32 {
    CHAT_W.1
}
pub const DEFAULT_MODEL_CHAT: &str = "sonnet";
pub const DEFAULT_MODEL_EXPORT: &str = "opus";
/// Build runs: Claude Code working in the repo. Claude only.
pub const DEFAULT_MODEL_BUILD: &str = "sonnet";
pub const DEFAULT_MODEL_FAST: &str = "haiku";
pub const DEFAULT_MODEL_DEEP: &str = "opus";
fn default_model_fast() -> String {
    DEFAULT_MODEL_FAST.into()
}
fn default_model_deep() -> String {
    DEFAULT_MODEL_DEEP.into()
}
pub const DEFAULT_MODEL_MEMORY: &str = "haiku";
/// Qwen 3.5 MoE, 35B total / ~3B active, tools + vision (Ollama library, checked 2026-11).
pub const DEFAULT_LOCAL_MODEL: &str = "qwen3.5:35b-a3b";
fn default_local_model() -> String {
    DEFAULT_LOCAL_MODEL.into()
}
pub const DEFAULT_SPRITECOOK_URL: &str = "https://api.spritecook.ai/mcp/";
pub const DEFAULT_CREDIT_CAP: u32 = 4;
fn default_spritecook_url() -> String {
    DEFAULT_SPRITECOOK_URL.into()
}
fn default_credit_cap() -> u32 {
    DEFAULT_CREDIT_CAP
}
pub const DEFAULT_COMPACT_TOKENS: u64 = 50_000;
fn default_model_memory() -> String {
    DEFAULT_MODEL_MEMORY.into()
}
fn default_memory_cap() -> u64 {
    crate::memory::DEFAULT_CAP
}
fn default_compact_tokens() -> u64 {
    DEFAULT_COMPACT_TOKENS
}
fn default_model_chat() -> String {
    DEFAULT_MODEL_CHAT.into()
}
fn default_model_export() -> String {
    DEFAULT_MODEL_EXPORT.into()
}
fn default_model_build() -> String {
    DEFAULT_MODEL_BUILD.into()
}
fn default_clip_hotkey() -> String {
    "Ctrl+Alt+Shift+V".into()
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: 1,
            theme: "pearl-glow".into(),
            hotkey: "Ctrl+Shift+Space".into(),
            clipboard_hotkey: default_clip_hotkey(),
            last_project: None,
            show_projects: true,
            show_chat: true,
            side_w: default_side_w(),
            chat_w: default_chat_w(),
            tray_notice_shown: false,
            start_with_windows: true,
            start_hidden: true,
            model_chat: default_model_chat(),
            model_router: true,
            model_fast: default_model_fast(),
            model_deep: default_model_deep(),
            model_export: default_model_export(),
            build_model: default_model_build(),
            model_memory: default_model_memory(),
            compact_tokens: default_compact_tokens(),
            memory_cap: default_memory_cap(),
            local_chat: true,
            local_model: default_local_model(),
            ollama_path: String::new(),
            local_cloud_declined: false,
            spritecook_url: default_spritecook_url(),
            credit_cap: DEFAULT_CREDIT_CAP,
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Deserialize, Debug, Default)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub hotkey: Option<String>,
    pub clipboard_hotkey: Option<String>,
    /// Empty string clears it.
    pub last_project: Option<String>,
    pub show_projects: Option<bool>,
    pub show_chat: Option<bool>,
    pub side_w: Option<u32>,
    pub chat_w: Option<u32>,
    pub tray_notice_shown: Option<bool>,
    pub start_with_windows: Option<bool>,
    pub start_hidden: Option<bool>,
    /// Empty string restores the default.
    pub model_chat: Option<String>,
    pub model_router: Option<bool>,
    /// Empty string restores the default.
    pub model_fast: Option<String>,
    /// Empty string restores the default.
    pub model_deep: Option<String>,
    /// Empty string restores the default.
    pub model_export: Option<String>,
    /// Empty string restores the default; a local (Ollama) model name is refused.
    pub build_model: Option<String>,
    /// Empty string restores the default.
    pub model_memory: Option<String>,
    /// 0 restores the default.
    pub compact_tokens: Option<u64>,
    /// 0 restores the default.
    pub memory_cap: Option<u64>,
    pub local_chat: Option<bool>,
    /// Empty string restores the default.
    pub local_model: Option<String>,
    /// Empty string clears it.
    pub ollama_path: Option<String>,
    pub local_cloud_declined: Option<bool>,
    /// Empty string restores the default; must be https.
    pub spritecook_url: Option<String>,
    /// 0 restores the default.
    pub credit_cap: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub stage: Stage,
    /// "deleted" or "lost to <winner title>" (step 7).
    pub reason: String,
    pub deleted_at: String,
    pub pos: Option<Pos>,
    /// "folder" for a trashed folder (its subtree is in trash/<id>.folder.json); absent = a card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The folder whose canvas it was on (None = the root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// A trashed folder: how many cards went with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TrashIndex {
    #[serde(default)]
    pub items: Vec<TrashItem>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DeletedProject {
    pub slug: String,
    pub path: String,
    /// true = moved to the OS Recycle Bin / Trash; false = deleted outright.
    pub recycled: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProjectData {
    pub slug: String,
    pub is_inbox: bool,
    pub meta: ProjectMeta,
    /// The root canvas (canvas.json).
    pub canvas: Canvas,
    pub folders: Vec<Folder>,
    /// Each folder's canvas by folder id.
    pub canvases: BTreeMap<String, Canvas>,
    pub cards: Vec<Card>,
    /// Pending Claude edit proposals by card id (`cards/<id>.proposal.json`).
    pub proposals: BTreeMap<String, Value>,
    /// Files that could not be read (shown to the user, never fatal).
    pub warnings: Vec<String>,
    /// The root has ordinary top-level folders and no versions yet: the UI asks which are versions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_migration: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The UI (src/api/types.ts) relies on this exact JSON shape.
    #[test]
    fn json_contract_with_the_ui() {
        let mut card = Card::default();
        card.meta.id = "01A".into();
        card.meta.title = "T".into();
        card.meta.stage = Stage::Dream;
        card.body = "b".into();
        card.meta.extra.insert("notes".into(), json!("n"));
        let v = serde_json::to_value(&card).unwrap();
        assert_eq!(v["id"], "01A");
        assert_eq!(v["stage"], "dream");
        assert_eq!(v["source"], "user");
        assert_eq!(v["ghost"], false);
        assert_eq!(v["body"], "b");
        assert_eq!(v["notes"], "n", "extra keys are top-level");
        assert!(v.get("meta").is_none());
        assert!(v.get("branch").is_none() || v["branch"].is_null());

        let s = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(s["last_project"], serde_json::Value::Null);
        assert_eq!(s["hotkey"], "Ctrl+Shift+Space");

        // What the UI sends.
        let n: NewCard = serde_json::from_value(json!({"title": "x", "stage": "lucid", "x": 1.5, "y": 2.0})).unwrap();
        assert_eq!((n.stage, n.x), (Some(Stage::Lucid), Some(1.5)));
        let p: CardPatch = serde_json::from_value(json!({"ghost": false})).unwrap();
        assert_eq!(p.ghost, Some(false));
        let c: Canvas = serde_json::from_value(json!({"version": 1, "viewport": {"x": 1, "y": 2, "zoom": 1}, "cards": {"a": {"x": 0, "y": 0}}})).unwrap();
        assert_eq!(c.cards.len(), 1);
        // A legacy position has no size/z and serializes back without them.
        assert_eq!(serde_json::to_value(c.cards["a"]).unwrap(), json!({"x": 0.0, "y": 0.0}));
        let sp: SettingsPatch = serde_json::from_value(json!({"last_project": ""})).unwrap();
        assert_eq!(sp.last_project.as_deref(), Some(""));
    }

    #[test]
    fn card_size_and_z_order_roundtrip_and_sanitize() {
        let v = json!({"version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1}, "cards": {
            "a": {"x": 1, "y": 2, "w": 320, "h": 240, "z": 7},
            "b": {"x": 3, "y": 4, "z": -2, "back": true},
            "c": {"x": 5, "y": 6, "w": 10, "h": 99999},
        }});
        let mut c: Canvas = serde_json::from_value(v).unwrap();
        assert_eq!(c.cards["a"], Pos { x: 1.0, y: 2.0, w: Some(320.0), h: Some(240.0), z: Some(7), back: false, pinned: false });
        assert!(c.cards["b"].back);
        assert_eq!(c.max_z(), 7);
        c.sanitize();
        assert_eq!((c.cards["c"].w, c.cards["c"].h), (Some(MIN_CARD_W), Some(MAX_CARD_SIDE)));
        let back = serde_json::to_value(&c).unwrap();
        assert_eq!(back["cards"]["a"]["w"], 320.0);
        assert_eq!(back["cards"]["b"]["back"], true);
        assert!(back["cards"]["a"].get("back").is_none(), "false is not written");
        assert_eq!(Canvas::default().max_z(), 0);
    }

    #[test]
    fn attachment_json_shape_and_merge_dedupe() {
        let a: Attachment = serde_json::from_value(json!({"type": "image", "id": "a", "path": "media/a.png"})).unwrap();
        assert_eq!(serde_json::to_value(&a).unwrap(), json!({"type": "image", "id": "a", "path": "media/a.png"}));
        let c: Attachment = serde_json::from_value(json!({"type": "clip", "id": "c", "url": "https://x", "excerpt": "media/clips/a.md"})).unwrap();
        assert!(c.validate().is_ok());
        let b = Attachment::Image { id: "b".into(), path: "media/a.png".into(), caption: Some("dup".into()) };
        let d = Attachment::Image { id: "a".into(), path: "media/d.png".into(), caption: None };
        let m = merge_attachments([vec![a.clone(), c.clone()].as_slice(), vec![b, d].as_slice()]);
        assert_eq!(m.len(), 3, "same path deduped");
        assert_eq!((m[0].id(), m[1].id()), ("a", "c"));
        assert!(m[2].key() == "media/d.png" && m[2].id() != "a", "colliding id renamed");
        for bad in ["media/../x", "/abs", "media\\x", "media//x", "other/x"] {
            assert!(Attachment::Image { id: String::new(), path: bad.into(), caption: None }.validate().is_err(), "{bad}");
        }
        let card: Card = serde_json::from_value(json!({"title": "t"})).unwrap();
        let v = serde_json::to_value(&card).unwrap();
        assert_eq!((v["kind"].clone(), v["attachments"].clone()), (json!("card"), json!([])));
        assert!(v.get("items").is_none() && v.get("role").is_none());
    }
}

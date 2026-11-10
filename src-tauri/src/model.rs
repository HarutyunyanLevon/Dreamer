use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    #[default]
    Cloud,
    Sketch,
    Draft,
    Pitch,
}

/// Lenient: case-insensitive, and unknown values fall back to Cloud (files may be hand-edited).
impl<'de> Deserialize<'de> for Stage {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.trim().to_lowercase().as_str() {
            "sketch" => Stage::Sketch,
            "draft" => Stage::Draft,
            "pitch" => Stage::Pitch,
            _ => Stage::Cloud,
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

/// Card file frontmatter. Unknown keys are preserved in `extra` so external edits are never lost.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Frontmatter {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
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
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
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
    pub x: Option<f64>,
    pub y: Option<f64>,
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Pos {
    pub x: f64,
    pub y: f64,
}

/// canvas.json: camera and card positions. Links live in each card's frontmatter.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Canvas {
    pub version: u32,
    #[serde(default)]
    pub viewport: Viewport,
    #[serde(default)]
    pub cards: BTreeMap<String, Pos>,
}
impl Default for Canvas {
    fn default() -> Self {
        Canvas { version: 1, viewport: Viewport::default(), cards: BTreeMap::new() }
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectSummary {
    pub slug: String,
    pub name: String,
    pub theme: Option<String>,
    pub card_count: usize,
    pub is_inbox: bool,
}

#[derive(Deserialize, Debug, Default)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// Theme id; an empty string clears the override.
    pub theme: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub version: u32,
    pub theme: String,
    pub hotkey: String,
    #[serde(default)]
    pub last_project: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: 1,
            theme: "pearl-glow".into(),
            hotkey: "Ctrl+Shift+Space".into(),
            last_project: None,
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Deserialize, Debug, Default)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub hotkey: Option<String>,
    /// Empty string clears it.
    pub last_project: Option<String>,
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TrashIndex {
    #[serde(default)]
    pub items: Vec<TrashItem>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProjectData {
    pub slug: String,
    pub is_inbox: bool,
    pub meta: ProjectMeta,
    pub canvas: Canvas,
    pub cards: Vec<Card>,
    /// Files that could not be read (shown to the user, never fatal).
    pub warnings: Vec<String>,
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
        card.meta.stage = Stage::Pitch;
        card.body = "b".into();
        card.meta.extra.insert("notes".into(), json!("n"));
        let v = serde_json::to_value(&card).unwrap();
        assert_eq!(v["id"], "01A");
        assert_eq!(v["stage"], "pitch");
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
        let n: NewCard = serde_json::from_value(json!({"title": "x", "stage": "draft", "x": 1.5, "y": 2.0})).unwrap();
        assert_eq!((n.stage, n.x), (Some(Stage::Draft), Some(1.5)));
        let p: CardPatch = serde_json::from_value(json!({"ghost": false})).unwrap();
        assert_eq!(p.ghost, Some(false));
        let c: Canvas = serde_json::from_value(json!({"version": 1, "viewport": {"x": 1, "y": 2, "zoom": 1}, "cards": {"a": {"x": 0, "y": 0}}})).unwrap();
        assert_eq!(c.cards.len(), 1);
        let sp: SettingsPatch = serde_json::from_value(json!({"last_project": ""})).unwrap();
        assert_eq!(sp.last_project.as_deref(), Some(""));
    }
}

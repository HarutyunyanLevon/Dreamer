//! Cards from the clipboard: the global "Clipboard to Inbox" hotkey, text classification, and
//! "Split into cards" (local model, JSON-schema output, validated against the source text).

use crate::error::{AppError, Result};
use crate::model::*;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Pasted text longer than this gets the "Split into cards" chip.
pub const LONG_TEXT: usize = 600;
/// Frontmatter field that marks a long paste (the card shows the chip; hidden from the field list).
pub const SPLIT_FIELD: &str = "split_offer";

/// A single http(s) line.
pub fn as_url(text: &str) -> Option<String> {
    let t = text.trim();
    (!t.contains(char::is_whitespace) && (t.starts_with("http://") || t.starts_with("https://")) && t.len() > 8).then(|| t.to_string())
}

/// Title (first line, max 80 chars) and body (the rest; the whole text when the first line was cut).
pub fn title_body(text: &str) -> (String, String) {
    let t = text.trim();
    let (first, rest) = t.split_once('\n').unwrap_or((t, ""));
    let first = first.trim();
    if first.chars().count() <= 80 { (first.to_string(), rest.trim().to_string()) } else { (format!("{}…", first.chars().take(77).collect::<String>().trim_end()), t.to_string()) }
}

/// Is `t` a card from plain text, and a long one?
pub fn text_card(text: &str) -> NewCard {
    let (title, body) = title_body(text);
    let long = text.trim().chars().count() > LONG_TEXT;
    NewCard {
        title: Some(title),
        body: Some(body),
        stage: Some(Stage::Mist),
        fields: long.then(|| [(SPLIT_FIELD.to_string(), json!(true))].into_iter().collect()),
        ..Default::default()
    }
}

// ---------- split ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Draft {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

/// Keeps the drafts whose words mostly (>= 80%) come from `source`; the rest are dropped with a warning.
pub fn validate_split(source: &str, drafts: Vec<Draft>) -> (Vec<Draft>, Vec<String>) {
    let known: HashSet<String> = words(source).into_iter().collect();
    let (mut keep, mut warn) = (Vec::new(), Vec::new());
    for d in drafts {
        let w = words(&format!("{} {}", d.title, d.body));
        let ok = !w.is_empty() && w.iter().filter(|x| known.contains(*x)).count() * 5 >= w.len() * 4;
        if ok && !d.title.trim().is_empty() { keep.push(d) } else { warn.push(format!("Dropped \"{}\": it has words that are not in your text.", d.title.trim())) }
    }
    (keep, warn)
}

const SPLIT_SYSTEM: &str = "You split the user's text into separate cards, one idea per card. Use only the user's own words and ideas: do not add, invent or explain anything. Each card has a short title (taken from the text), a body (the matching part of the text) and up to 3 tags that appear in the text. Return JSON only.";

#[derive(Serialize)]
pub struct SplitResult {
    pub cards: Vec<Draft>,
    pub warnings: Vec<String>,
}

/// Runs the local model with JSON-schema output. Never escalates to Claude by itself.
pub fn split_local(state: &AppState, text: &str) -> Result<SplitResult> {
    let settings = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.get_settings()?;
    let status = state.ollama.status(&crate::ollama::LocalCfg::from_settings(&settings));
    let model = status.variant.clone().filter(|_| status.ready).ok_or_else(|| AppError::Invalid(status.error.unwrap_or_else(|| "The local model isn't ready. Use Think harder to ask Claude.".into())))?;
    let schema = json!({ "type": "object", "properties": { "cards": { "type": "array", "items": { "type": "object",
        "properties": { "title": { "type": "string" }, "body": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" } } },
        "required": ["title", "body", "tags"] } } }, "required": ["cards"] });
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let v = crate::ollama::chat_json(&model, SPLIT_SYSTEM, text, &schema, 0.2, &crate::ollama::ChatLimits::default(), &cancel).map_err(|e| AppError::Invalid(e.to_string()))?;
    let drafts: Vec<Draft> = serde_json::from_value(v.get("cards").cloned().unwrap_or(Value::Null)).map_err(|e| AppError::Invalid(format!("The model's reply had the wrong shape ({e}).")))?;
    let (cards, mut warnings) = validate_split(text, drafts);
    if cards.is_empty() {
        warnings.push("Nothing usable came back.".into());
    }
    Ok(SplitResult { cards, warnings })
}

// ---------- the global hotkey ----------

/// A small always-on-top message that closes itself (the app may be in the tray).
pub fn popup_toast(app: &AppHandle, msg: &str) {
    let enc: String = msg.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let (w, h) = (340.0, 64.0);
    let (x, y) = app.primary_monitor().ok().flatten().map(|m| {
        let s = m.scale_factor();
        ((m.size().width as f64 / s) - w - 24.0, (m.size().height as f64 / s) - h - 72.0)
    }).unwrap_or((100.0, 100.0));
    let Ok(win) = WebviewWindowBuilder::new(app, format!("toast{n}"), WebviewUrl::App(format!("index.html?toast=1&msg={enc}").into()))
        .inner_size(w, h).position(x, y).decorations(false).resizable(false).always_on_top(true).skip_taskbar(true).focused(false).build()
    else { return };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2600));
        let _ = win.close();
    });
}

/// Hotkey handler: the clipboard becomes a card in the Inbox (same type logic as paste on the canvas).
pub fn clipboard_to_inbox(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let msg = match add_from_clipboard(&app).await {
            Ok(m) => m,
            Err(e) => format!("Couldn't add the clipboard: {e}"),
        };
        popup_toast(&app, &msg);
    });
}

async fn add_from_clipboard(app: &AppHandle) -> Result<String> {
    let st = app.state::<AppState>();
    let io = |e: arboard::Error| AppError::Invalid(format!("clipboard: {e}"));
    let (text, image, files) = {
        let mut cb = arboard::Clipboard::new().map_err(io)?;
        (cb.get_text().ok(), cb.get_image().ok().map(|i| (i.width, i.height, i.bytes.into_owned())), cb.get().file_list().ok())
    };
    // shortcut: lands in the last opened project, until the capture utility is removed.
    let inbox_slug = {
        let ws = st.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let last = ws.get_settings()?.last_project.filter(|s| ws.existing_project_dir(s).is_ok());
        last.or_else(|| ws.list_projects().ok()?.first().map(|p| p.slug.clone())).ok_or_else(|| AppError::NotFound("a project".into()))?
    };
    let inbox = inbox_slug.as_str();
    let with = |f: &dyn Fn(&crate::storage::Workspace) -> Result<String>| -> Result<String> { f(&*st.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?) };
    let fetched_cell: std::cell::RefCell<Option<crate::clip::Fetched>> = Default::default();
    let is_bundle = |t: &str| crate::bundle::detect(t);
    // bundle -> image -> files -> URL -> text
    if let Some(t) = text.as_deref().filter(|t| is_bundle(t)) {
        return with(&|ws| {
            let r = ws.apply_bundle(t, &crate::storage::Target { project: Some(inbox.into()), ..Default::default() })?;
            Ok(format!("Added to Inbox: {} cards as suggestions", r.created.len() + r.proposals.len()))
        });
    }
    if let Some((w, h, rgba)) = image {
        let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba).ok_or_else(|| AppError::Invalid("bad clipboard image".into()))?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| AppError::Invalid(e.to_string()))?;
        return with(&|ws| {
            let path = ws.save_media(inbox, "pasted.png", &png)?;
            let att = Attachment::Image { id: ulid::Ulid::generate().to_string(), path, caption: None };
            ws.create_card(inbox, NewCard { title: Some("Pasted image".into()), kind: Some(CardKind::Image), attachments: Some(vec![att]), ..Default::default() })?;
            Ok("Added to Inbox: Pasted image".into())
        });
    }
    if let Some(files) = files.filter(|f| !f.is_empty()) {
        let mut n = 0;
        let mut texts = Vec::new();
        for f in &files {
            let name = f.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if name.ends_with(".dreamer.md") {
                texts.push(std::fs::read_to_string(f).unwrap_or_default());
            } else if [".png", ".jpg", ".jpeg", ".gif", ".webp"].iter().any(|e| name.ends_with(e)) {
                if let Ok(bytes) = std::fs::read(f) {
                    let title = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Image".into());
                    with(&|ws| {
                        let path = ws.save_media(inbox, &name, &bytes)?;
                        let att = Attachment::Image { id: ulid::Ulid::generate().to_string(), path, caption: None };
                        ws.create_card(inbox, NewCard { title: Some(title.clone()), kind: Some(CardKind::Image), attachments: Some(vec![att]), ..Default::default() })?;
                        Ok(String::new())
                    })?;
                    n += 1;
                }
            }
        }
        for t in texts.iter().filter(|t| is_bundle(t)) {
            with(&|ws| ws.apply_bundle(t, &crate::storage::Target { project: Some(inbox.into()), ..Default::default() }).map(|_| String::new()))?;
            n += 1;
        }
        return Ok(if n == 0 { "Nothing to add: those files aren't images or bundles".into() } else { format!("Added to Inbox: {n} item(s)") });
    }
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).ok_or_else(|| AppError::Invalid("the clipboard is empty".into()))?;
    if let Some(url) = as_url(&text) {
        *fetched_cell.borrow_mut() = Some(crate::clip::fetch(&url).await);
        return with(&|ws| {
            let fetched = fetched_cell.borrow_mut().take().unwrap_or_default();
            let att = ws.store_clip(inbox, &ulid::Ulid::generate().to_string(), &url, fetched)?;
            let title = match &att { Attachment::Clip { title: Some(t), .. } => t.clone(), _ => url.clone() };
            ws.create_card(inbox, NewCard { title: Some(title.clone()), kind: Some(CardKind::Clip), attachments: Some(vec![att]), ..Default::default() })?;
            Ok(format!("Added to Inbox: {title}"))
        });
    }
    with(&|ws| {
        let c = ws.create_card(inbox, text_card(&text))?;
        Ok(format!("Added to Inbox: {}", c.meta.title))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_text() {
        assert_eq!(as_url(" https://a.b/c?d=1 \n").as_deref(), Some("https://a.b/c?d=1"));
        assert_eq!(as_url("see https://a.b"), None);
        assert_eq!(as_url("two\nhttps://a.b"), None);
        assert_eq!(title_body("Title\n\nrest of it"), ("Title".into(), "rest of it".into()));
        let long_first = "x".repeat(100);
        let (t, b) = title_body(&format!("{long_first}\nmore"));
        assert_eq!((t.chars().count(), b.starts_with('x')), (78, true));
        assert!(text_card("short").fields.is_none());
        assert!(text_card(&"word ".repeat(200)).fields.is_some());
    }

    #[test]
    fn split_validation_drops_invented_cards() {
        let src = "We need a fishing minigame with a timing bar. Also the harbour should have day and night lighting.";
        let d = |t: &str, b: &str| Draft { title: t.into(), body: b.into(), tags: vec![] };
        let (keep, warn) = validate_split(src, vec![d("Fishing minigame", "a fishing minigame with a timing bar"), d("Harbour", "day and night lighting for the harbour"), d("Crafting", "players craft legendary swords from dragon scales")]);
        assert_eq!(keep.len(), 2);
        assert_eq!(warn.len(), 1);
        assert!(warn[0].contains("Crafting"));
    }
}

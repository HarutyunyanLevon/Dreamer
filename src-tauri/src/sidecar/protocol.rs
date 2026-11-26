//! Tool requests from the sidecar answered against storage.
use super::*;

/// What read_card says about an attachment (no file contents; view_attachment has those).
pub(super) fn attachment_summary(a: &crate::model::Attachment) -> Value {
    use crate::model::Attachment;
    match a {
        Attachment::Image { id, caption, .. } => json!({ "id": id, "type": "image", "caption": caption }),
        Attachment::Clip { id, url, title, caption, excerpt, .. } => {
            json!({ "id": id, "type": "clip", "caption": caption, "title": title, "url": url, "has_excerpt": excerpt.is_some() })
        }
    }
}

/// Longest side Claude gets an image at (larger ones are downscaled by the API anyway).
pub(super) const MAX_IMAGE_SIDE: u32 = 1568;

/// Decodes an image, shrinks it to MAX_IMAGE_SIDE on its long side, and re-encodes it
/// (JPEG for opaque images, PNG when it has transparency). Returns (mime, base64).
pub(super) fn downscale_for_claude(bytes: &[u8]) -> Result<(&'static str, String)> {
    use base64::Engine;
    use image::{GenericImageView, ImageFormat};
    let img = image::load_from_memory(bytes).map_err(|e| AppError::Invalid(format!("can't read this image: {e}")))?;
    let (w, h) = img.dimensions();
    let img = if w.max(h) > MAX_IMAGE_SIDE { img.resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, image::imageops::FilterType::Triangle) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    let mime = if img.color().has_alpha() {
        img.write_to(&mut out, ImageFormat::Png).map_err(|e| AppError::Invalid(format!("encode image: {e}")))?;
        "image/png"
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
            .encode_image(&img.to_rgb8())
            .map_err(|e| AppError::Invalid(format!("encode image: {e}")))?;
        "image/jpeg"
    };
    Ok((mime, base64::engine::general_purpose::STANDARD.encode(out.into_inner())))
}

pub(super) fn to_json<T: Serialize>(v: &T, what: &str) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| AppError::Parse { context: what.into(), message: e.to_string() })
}

pub(super) fn active_slug(state: &AppState) -> Result<String> {
    Ok(state.claude.active_slug.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?.clone())
}

pub(super) fn scope_of(state: &AppState) -> crate::organize::Scope {
    state.claude.scope.lock().map(|s| s.clone()).unwrap_or_default()
}

pub(super) fn run_tool(state: &AppState, tool: &str, input: Value) -> Result<Value> {
    match tool {
        "create_card" => {
            let slug = state.claude.active_slug.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?.clone();
            let branch_group = input.get("branch_group").and_then(Value::as_str);
            let branch = branch_group.map(|g| json!({ "group": g, "of": input.get("variant_of").and_then(Value::as_str) }));
            let new_card = NewCard {
                title: input.get("title").and_then(Value::as_str).map(str::to_string),
                body: input.get("body").and_then(Value::as_str).map(str::to_string),
                tags: input.get("tags").cloned().and_then(|v| serde_json::from_value(v).ok()),
                stage: input.get("stage").cloned().and_then(|v| serde_json::from_value(v).ok()),
                links: input.get("links").cloned().and_then(|v| serde_json::from_value(v).ok()),
                source: Some(Source::Claude),
                ghost: Some(true),
                branch,
                // Claude may make plain cards and checklists (e.g. a /critique list).
                kind: input
                    .get("kind")
                    .cloned()
                    .and_then(|v| serde_json::from_value::<crate::model::CardKind>(v).ok())
                    .filter(|k| matches!(k, crate::model::CardKind::Card | crate::model::CardKind::Checklist)),
                items: input.get("items").cloned().and_then(|v| serde_json::from_value(v).ok()),
                ..Default::default()
            };
            let card = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.create_card(&slug, new_card)?;
            // Don't wait for the watcher's debounce: a search right after this should see it.
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            to_json(&card, "create_card result")
        }
        // A reference page as a ghost web-clip card. The page is fetched here; one that can't be is refused.
        "create_reference" => {
            let slug = active_slug(state)?;
            let url = input.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            let fetched = tauri::async_runtime::block_on(crate::clip::fetch(&url));
            if let Some(e) = &fetched.error {
                return Err(AppError::Invalid(format!("could not fetch {url}: {e}")));
            }
            let title = fetched.title.clone().unwrap_or_else(|| url.clone());
            let att = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.store_clip(&slug, &ulid::Ulid::generate().to_string(), &url, fetched)?;
            let new_card = NewCard {
                title: Some(title),
                body: input.get("take").and_then(Value::as_str).map(str::to_string),
                source: Some(Source::Claude),
                ghost: Some(true),
                kind: Some(crate::model::CardKind::Clip),
                attachments: Some(vec![att]),
                ..Default::default()
            };
            let card = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.create_card(&slug, new_card)?;
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            to_json(&card, "create_reference result")
        }
        // A merge is only a ghost: the originals are moved to Trash by the UI when the user Keeps it.
        "merge_cards" => {
            use crate::model::{Link, Stage};
            let slug = active_slug(state)?;
            let ids: Vec<String> = input.get("ids").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            let mut uniq: Vec<String> = Vec::new();
            for id in ids {
                crate::storage::check_id(&id)?;
                if !uniq.contains(&id) {
                    uniq.push(id);
                }
            }
            if uniq.len() < 2 {
                return Err(AppError::Invalid("merge_cards needs at least 2 distinct card ids".into()));
            }
            let card = {
                let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
                let project = guard.load_project(&slug)?;
                let rank = |s: Stage| match s {
                    Stage::Mist => 0,
                    Stage::Reverie => 1,
                    Stage::Lucid => 2,
                    Stage::Dream => 3,
                    Stage::Built => 4,
                };
                let mut stage = Stage::Mist;
                let mut links: Vec<Link> = Vec::new();
                let mut atts: Vec<&[crate::model::Attachment]> = Vec::new();
                let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
                for id in &uniq {
                    let c = project.cards.iter().find(|c| &c.meta.id == id).ok_or_else(|| AppError::NotFound(format!("card {id} in the open project")))?;
                    atts.push(&c.meta.attachments);
                    if rank(c.meta.stage) > rank(stage) {
                        stage = c.meta.stage;
                    }
                    for l in &c.meta.links {
                        if !uniq.contains(&l.to) && !links.iter().any(|x| x.to == l.to) {
                            links.push(l.clone());
                        }
                    }
                    if let Some(p) = project.canvas.cards.get(id) {
                        sx += p.x;
                        sy += p.y;
                        n += 1.0;
                    }
                }
                let new_card = NewCard {
                    title: input.get("title").and_then(Value::as_str).map(str::to_string),
                    body: input.get("body").and_then(Value::as_str).map(str::to_string),
                    tags: input.get("tags").cloned().and_then(|v| serde_json::from_value(v).ok()),
                    stage: Some(stage),
                    links: Some(links),
                    source: Some(Source::Claude),
                    ghost: Some(true),
                    merged_from: Some(uniq),
                    // Concatenated in the given card order, deduped by path/url.
                    attachments: Some(crate::model::merge_attachments(atts)),
                    x: (n > 0.0).then(|| sx / n),
                    y: (n > 0.0).then(|| sy / n),
                    ..Default::default()
                };
                guard.create_card(&slug, new_card)?
            };
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            to_json(&card, "merge_cards result")
        }
        // ---- read-only retrieval tools: nothing below writes to disk ----
        "search_cards" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or_default();
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
            let project = match input.get("scope").and_then(Value::as_str) {
                Some("project") => Some(active_slug(state)?),
                _ => None,
            };
            let hits = state.with_search(|idx| idx.search(query, project.as_deref(), limit.min(25)))?;
            to_json(&hits, "search results")
        }
        "read_card" => {
            let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let slug = active_slug(state)?;
            state.with_search(|idx| {
                let (project, card) = idx.find(id, Some(&slug)).ok_or_else(|| AppError::NotFound(format!("card {id} (it may have been trashed)")))?;
                let mut v = to_json(&card, "card")?;
                v["project"] = json!(project);
                v["links"] = json!(idx.describe_links(&project, &card.meta.links));
                v["kind"] = to_json(&card.meta.kind, "kind")?;
                // A summary only; view_attachment shows an image or a clip's saved text.
                v["attachments"] = Value::Array(card.meta.attachments.iter().map(attachment_summary).collect());
                // No data: URIs, no raw HTML, nothing over the cap: attachments are referred to by id.
                crate::ctx::claude_json(&mut v);
                Ok(v)
            })?
        }
        "list_cards" => {
            let slug = active_slug(state)?;
            let selection = state.claude.selection.lock().map_err(|_| AppError::Invalid("sidecar lock poisoned".into()))?.clone();
            let only_selection = input.get("scope").and_then(Value::as_str) == Some("selection");
            if only_selection && selection.is_empty() {
                return Err(AppError::Invalid("nothing is selected on the canvas; use scope \"project\"".into()));
            }
            let frames = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.card_frames(&slug)?;
            let mut cards = state.with_search(|idx| idx.overview(&slug).map(|(_, c)| c).unwrap_or_default())?;
            cards.retain(|c| !c.ghost && (!only_selection || selection.contains(&c.id)));
            cards.sort_by(|a, b| b.updated.cmp(&a.updated));
            let out: Vec<Value> = cards
                .iter()
                .map(|c| json!({ "id": c.id, "kind": c.kind, "title": c.title, "stage": c.stage, "tags": c.tags, "frame": frames.get(&c.id) }))
                .collect();
            Ok(Value::Array(out))
        }
        "list_related" => {
            let id = input.get("id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let related = state.with_search(|idx| idx.related(id, 20))?.ok_or_else(|| AppError::NotFound(format!("card {id}")))?;
            to_json(&related, "related cards")
        }
        // Only *proposes* a link: validated here, then shown in the UI as a dashed ghost link the
        // user must Keep. Nothing is written to any card file.
        "list_tree" => crate::organize::list_tree(state, &active_slug(state)?, &scope_of(state), &input),
        // Only *proposes* a reorganization: checked in full here, previewed and applied by the UI.
        "propose_organize" => crate::organize::propose_organize(state, &active_slug(state)?, &scope_of(state), &input),
        "propose_link" => {
            let from = input.get("from").and_then(Value::as_str).unwrap_or_default();
            let to = input.get("to").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(from)?;
            crate::storage::check_id(to)?;
            if from == to {
                return Err(AppError::Invalid("a card can't link to itself".into()));
            }
            let slug = active_slug(state)?;
            let from_card = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.read_card(&slug, from)?;
            let to_card = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.read_card(&slug, to)?;
            if from_card.meta.links.iter().any(|l| l.to == to) {
                return Err(AppError::Invalid(format!("\"{}\" already links to \"{}\"", from_card.meta.title, to_card.meta.title)));
            }
            Ok(json!({ "slug": slug, "from": from, "to": to, "fromTitle": from_card.meta.title, "toTitle": to_card.meta.title }))
        }
        // Read-only: one attachment for Claude to look at. Images come back downscaled as base64;
        // clips as the page excerpt saved when the clip was made.
        "view_attachment" => {
            let id = input.get("card_id").and_then(Value::as_str).unwrap_or_default();
            let att_id = input.get("attachment_id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            view_attachment(state, &active_slug(state)?, id, att_id)
        }
        // Only *proposes* changes: validated, then saved as cards/<id>.proposal.json (never the
        // card file). The card shows a badge; the user keeps or dismisses it in a diff view.
        "propose_edit" => {
            let id = input.get("card_id").and_then(Value::as_str).unwrap_or_default();
            crate::storage::check_id(id)?;
            let slug = active_slug(state)?;
            let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            let card = guard.read_card(&slug, id)?;
            let mut p = serde_json::Map::new();
            for k in ["title", "body"] {
                if let Some(v) = input.get(k).and_then(Value::as_str) {
                    p.insert(k.into(), json!(v));
                }
            }
            if let Some(t) = input.get("tags").filter(|v| !v.is_null()) {
                let tags: Vec<String> = serde_json::from_value(t.clone()).map_err(|_| AppError::Invalid("tags must be a list of strings".into()))?;
                p.insert("tags".into(), json!(tags));
            }
            if let Some(st) = input.get("stage").filter(|v| !v.is_null()) {
                let stage: crate::model::Stage = serde_json::from_value(st.clone()).map_err(|_| AppError::Invalid("stage must be mist, reverie, lucid, dream or built".into()))?;
                p.insert("stage".into(), json!(stage));
            }
            if let Some(caps) = input.get("captions").and_then(Value::as_object).filter(|m| !m.is_empty()) {
                for (att, c) in caps {
                    if !card.meta.attachments.iter().any(|a| a.id() == att) {
                        return Err(AppError::NotFound(format!("attachment {att} on card {id}")));
                    }
                    if !c.is_string() {
                        return Err(AppError::Invalid("each caption must be a string".into()));
                    }
                }
                p.insert("captions".into(), Value::Object(caps.clone()));
            }
            if p.is_empty() {
                return Err(AppError::Invalid("propose_edit needs at least one of title, body, tags, stage, captions".into()));
            }
            p.insert("reason".into(), json!(input.get("reason").and_then(Value::as_str).unwrap_or_default()));
            p.insert("created".into(), json!(crate::storage::now()));
            guard.write_proposal(&slug, id, &Value::Object(p))?;
            drop(guard);
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            Ok(json!({ "slug": slug, "title": card.meta.title }))
        }
        // A ghost artifact (deepen / grill): a brief only. Nothing is generated or spent until the
        // user keeps it; keeping it starts the artifact's first turn (UI).
        "propose_artifact" => {
            let slug = active_slug(state)?;
            let kind = input.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
            let source = input.get("source_card").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
            let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
            let source = source.filter(|s| guard.read_card(&slug, s).is_ok());
            let new = crate::artifacts::NewArtifact {
                kind,
                title: input.get("title").and_then(Value::as_str).map(str::to_string),
                brief: input.get("brief").and_then(Value::as_str).unwrap_or_default().to_string(),
                source_card: source,
                ghost: true,
                ..Default::default()
            };
            let card = crate::artifacts::create(&guard, &slug, new)?;
            drop(guard);
            if let Ok(mut idx) = state.search.lock() {
                idx.mark_dirty(Some(&slug));
            }
            Ok(json!({ "id": card.meta.id, "title": card.meta.title }))
        }
        other => Err(AppError::Invalid(format!("unknown tool {other:?}"))),
    }
}


/// One attachment for Claude to look at: an image downscaled to base64, or a clip's saved excerpt.
/// Read-only. Shared by the chat's and the handoff session's view_attachment.
pub(crate) fn view_attachment(state: &AppState, slug: &str, id: &str, att_id: &str) -> Result<Value> {
    use crate::model::Attachment;
    let (att, bytes) = {
        let guard = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
        let card = guard.read_card(slug, id)?;
        let att = card.meta.attachments.iter().find(|a| a.id() == att_id).cloned().ok_or_else(|| AppError::NotFound(format!("attachment {att_id} on card {id}")))?;
        let file = match &att {
            Attachment::Image { path, .. } => Some(path.clone()),
            Attachment::Clip { excerpt, .. } => excerpt.clone(),
        };
        let bytes = file.map(|f| guard.read_project_file(slug, &f)).transpose();
        (att, bytes)
    };
    match att {
        Attachment::Image { caption, .. } => {
            let (mime, data) = downscale_for_claude(&bytes?.unwrap_or_default())?;
            Ok(json!({ "kind": "image", "caption": caption, "mime": mime, "data": data }))
        }
        Attachment::Clip { url, title, caption, .. } => {
            let text = match bytes {
                Ok(Some(b)) => crate::ctx::claude_text(&String::from_utf8_lossy(&b)),
                _ => "no excerpt".into(),
            };
            Ok(json!({ "kind": "clip", "url": url, "title": title, "caption": caption, "text": text }))
        }
    }
}

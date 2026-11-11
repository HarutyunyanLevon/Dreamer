//! Plain-file card search: an in-memory keyword index over every project's `cards/*.md`.
//!
//! No database and no embeddings. Each project's index is a map of card id → pre-tokenized
//! document plus the file's (mtime, size) stamp. The file watcher marks a project dirty; the
//! next search re-stats that project's card files and re-parses only the ones whose stamp
//! changed (or that are new), and drops the ones that disappeared. Trashed cards live in
//! `trash/`, not `cards/`, so they are never indexed.
//!
//! Ranking is weighted keyword scoring: title > tags > fields > body, case- and
//! accent-insensitive, with light suffix stemming (s/es/ing/ed).

use crate::model::{Card, Link, ProjectMeta, Stage};
use crate::storage::{check_slug, parse_card, INBOX_SLUG};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use unicode_normalization::UnicodeNormalization;

const W_TITLE: f32 = 10.0;
const W_TAG: f32 = 6.0;
const W_FIELD: f32 = 4.0;
const W_BODY: f32 = 1.0;
/// A query term that is only a prefix of a card term (e.g. "dra" → "dragon") counts this much.
const PREFIX_FACTOR: f32 = 0.5;
const SNIPPET_CHARS: usize = 200;
pub const MAX_LIMIT: usize = 100;

// ---------- text normalization ----------

/// Lowercase and strip accents ("Café Œuvre" → "cafe oeuvre").
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.nfkd() {
        if unicode_normalization::char::is_combining_mark(c) {
            continue;
        }
        match c {
            'ß' => out.push_str("ss"),
            'æ' | 'Æ' => out.push_str("ae"),
            'œ' | 'Œ' => out.push_str("oe"),
            'ø' | 'Ø' => out.push('o'),
            'đ' | 'Đ' => out.push('d'),
            'ł' | 'Ł' => out.push('l'),
            _ => out.extend(c.to_lowercase()),
        }
    }
    out
}

/// Light English stemming: strips `ing`, `ed`, `es`, `s`, undoubles a final consonant left
/// behind by `ing`/`ed` ("running" → "run"), and drops a trailing `e` so "game", "games" and
/// "gaming" all meet at "gam". Words shorter than 4 characters are left alone.
pub fn stem(word: &str) -> String {
    let w: Vec<char> = word.chars().collect();
    if w.len() < 4 || !w.iter().all(|c| c.is_alphabetic()) {
        return word.to_string();
    }
    let s: String = word.to_string();
    let n = w.len();
    let ends = |suf: &str| s.ends_with(suf);
    let mut stemmed: String;
    let mut undouble = false;
    if ends("ing") && n - 3 >= 3 {
        stemmed = w[..n - 3].iter().collect();
        undouble = true;
    } else if n >= 5 && (ends("ied") || ends("ies")) {
        stemmed = w[..n - 3].iter().collect::<String>() + "y";
    } else if ends("ed") && n - 2 >= 3 {
        stemmed = w[..n - 2].iter().collect();
        undouble = true;
    } else if ends("es") && n - 2 >= 3 && (ends("ses") || ends("xes") || ends("zes") || ends("ches") || ends("shes")) {
        stemmed = w[..n - 2].iter().collect();
    } else if ends("s") && !ends("ss") && !ends("us") && !ends("is") {
        stemmed = w[..n - 1].iter().collect();
    } else {
        stemmed = s.clone();
    }
    let sc: Vec<char> = stemmed.chars().collect();
    let m = sc.len();
    if undouble && m >= 3 && sc[m - 1] == sc[m - 2] && !matches!(sc[m - 1], 'a' | 'e' | 'i' | 'o' | 'u' | 'l' | 's' | 'z') {
        stemmed.pop();
    }
    if stemmed.chars().count() >= 4 && stemmed.ends_with('e') {
        stemmed.pop();
    }
    stemmed
}

/// Splits on anything that isn't a letter or digit, folds and stems each word.
pub fn terms(text: &str) -> Vec<String> {
    fold(text).split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(stem).collect()
}

/// Words of `text` with their byte ranges in the original string, for snippet placement.
fn spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            out.push((s, i, stem(&fold(&text[s..i]))));
        }
    }
    if let Some(s) = start {
        out.push((s, text.len(), stem(&fold(&text[s..]))));
    }
    out
}

// ---------- documents ----------

#[derive(Clone, Debug)]
struct Doc {
    card: Card,
    title: Vec<String>,
    tags: Vec<String>,
    fields: Vec<String>,
    fields_text: String,
    body: HashMap<String, u32>,
}

fn field_text(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Number(n) => out.push(n.to_string()),
        Value::Bool(_) | Value::Null => {}
        Value::Array(a) => a.iter().for_each(|x| field_text(x, out)),
        Value::Object(o) => o.values().for_each(|x| field_text(x, out)),
    }
}

impl Doc {
    fn new(card: Card) -> Doc {
        let mut ft = Vec::new();
        for (k, v) in &card.meta.fields {
            // Media paths ("media/01ABC.png") are noise, not content.
            if k == "image" {
                continue;
            }
            field_text(v, &mut ft);
        }
        let fields_text = ft.join(" · ");
        let mut body = HashMap::new();
        for t in terms(&card.body) {
            *body.entry(t).or_insert(0) += 1;
        }
        Doc {
            title: terms(&card.meta.title),
            tags: card.meta.tags.iter().flat_map(|t| terms(t)).collect(),
            fields: terms(&fields_text),
            fields_text,
            body,
            card,
        }
    }
}

/// How well one query term matches a list of card terms: 1 for an exact (stemmed) match,
/// PREFIX_FACTOR when the query term is a prefix of a card term (3+ chars), else 0.
fn term_match<'a>(q: &str, mut words: impl Iterator<Item = &'a String>) -> f32 {
    let mut best: f32 = 0.0;
    for w in words.by_ref() {
        if w == q {
            return 1.0;
        }
        if q.chars().count() >= 3 && w.starts_with(q) {
            best = PREFIX_FACTOR;
        }
    }
    best
}

fn score_doc(doc: &Doc, query: &[String], phrase: &str) -> f32 {
    let mut total = 0.0;
    let mut matched = 0usize;
    for q in query {
        let mut s = W_TITLE * term_match(q, doc.title.iter()) + W_TAG * term_match(q, doc.tags.iter()) + W_FIELD * term_match(q, doc.fields.iter());
        // Body: exact hits count with diminishing returns; otherwise a prefix hit.
        if let Some(&n) = doc.body.get(q) {
            s += W_BODY * (1.0 + (n as f32).ln());
        } else {
            s += W_BODY * term_match(q, doc.body.keys());
        }
        if s > 0.0 {
            matched += 1;
        }
        total += s;
    }
    if matched == 0 {
        return 0.0;
    }
    // Cards matching every query word beat cards matching one word many times.
    let coverage = matched as f32 / query.len() as f32;
    total *= 0.4 + 0.6 * coverage * coverage;
    if query.len() > 1 && !phrase.is_empty() && fold(&doc.card.meta.title).contains(phrase) {
        total += W_TITLE;
    }
    total
}

/// ~200 characters of `text` around the densest cluster of query matches, whitespace collapsed.
pub fn snippet(text: &str, query: &[String]) -> String {
    let words = spans(text);
    let qset: HashSet<&str> = query.iter().map(String::as_str).collect();
    let hit = |w: &str| qset.contains(w) || qset.iter().any(|q| q.chars().count() >= 3 && w.starts_with(q));
    let hits: Vec<usize> = words.iter().enumerate().filter(|(_, (_, _, w))| hit(w)).map(|(i, _)| i).collect();
    let anchor = if hits.is_empty() {
        0
    } else {
        // The hit with the most other hits in the following ~SNIPPET_CHARS bytes.
        let mut best = (0usize, words[hits[0]].0);
        for &i in &hits {
            let start = words[i].0;
            let n = hits.iter().filter(|&&j| words[j].0 >= start && words[j].0 < start + SNIPPET_CHARS).count();
            if n > best.0 {
                best = (n, start);
            }
        }
        best.1
    };
    // Back up ~50 chars (to a word start) so the match has some lead-in.
    let lead = 50;
    let mut start = 0;
    if anchor > lead {
        let target = anchor - lead;
        start = words.iter().map(|w| w.0).find(|&s| s >= target).unwrap_or(anchor).min(anchor);
    }
    let rest = &text[start..];
    let mut out: String = rest.chars().take(SNIPPET_CHARS).collect();
    let truncated = rest.chars().count() > SNIPPET_CHARS;
    if truncated {
        if let Some(cut) = out.rfind(char::is_whitespace) {
            if cut > SNIPPET_CHARS / 2 {
                out.truncate(cut);
            }
        }
    }
    let mut out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        out.insert_str(0, "…");
    }
    if truncated {
        out.push('…');
    }
    out
}

// ---------- the index ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub project: String,
    pub project_name: String,
    pub title: String,
    pub stage: Stage,
    pub tags: Vec<String>,
    pub ghost: bool,
    pub snippet: String,
    pub score: f32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Related {
    pub id: String,
    pub project: String,
    pub title: String,
    pub stage: Stage,
    pub ghost: bool,
    /// e.g. ["links to", "shares tags: boss, water"]
    pub relation: Vec<String>,
}

type Stamp = (Option<SystemTime>, u64);

#[derive(Default)]
struct ProjectIndex {
    name: String,
    loaded: bool,
    dirty: bool,
    docs: HashMap<String, (Stamp, Doc)>,
}

#[derive(Default)]
pub struct SearchIndex {
    root: Option<PathBuf>,
    projects: HashMap<String, ProjectIndex>,
    /// Card files parsed by the most recent refresh (for tests and the stress check).
    pub last_parsed: usize,
}

fn project_dir(root: &Path, slug: &str) -> PathBuf {
    if slug == INBOX_SLUG { root.join(INBOX_SLUG) } else { root.join("projects").join(slug) }
}

fn list_slugs(root: &Path) -> Vec<String> {
    let mut out = vec![INBOX_SLUG.to_string()];
    if let Ok(rd) = fs::read_dir(root.join("projects")) {
        for e in rd.filter_map(|e| e.ok()) {
            let slug = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() && check_slug(&slug).is_ok() {
                out.push(slug);
            }
        }
    }
    out.sort_by(|a, b| (a != INBOX_SLUG).cmp(&(b != INBOX_SLUG)).then(a.cmp(b)));
    out
}

fn stamp(meta: &fs::Metadata) -> Stamp {
    (meta.modified().ok(), meta.len())
}

impl SearchIndex {
    /// Points the index at a workspace root; switching roots throws the old index away.
    pub fn set_root(&mut self, root: &Path) {
        if self.root.as_deref() != Some(root) {
            self.root = Some(root.to_path_buf());
            self.projects.clear();
        }
    }

    /// Called from the file watcher. `None` = something changed but we don't know which project.
    pub fn mark_dirty(&mut self, project: Option<&str>) {
        match project {
            Some(p) => self.projects.entry(p.to_string()).or_default().dirty = true,
            None => self.projects.values_mut().for_each(|p| p.dirty = true),
        }
    }

    /// Brings one project up to date: re-stats its card files and re-parses only changed ones.
    fn refresh_project(&mut self, slug: &str) -> usize {
        let Some(root) = self.root.clone() else { return 0 };
        let dir = project_dir(&root, slug);
        let p = self.projects.entry(slug.to_string()).or_default();
        if p.loaded && !p.dirty {
            return 0;
        }
        p.name = fs::read_to_string(dir.join("project.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<ProjectMeta>(&t).ok())
            .map(|m| m.name)
            .unwrap_or_else(|| if slug == INBOX_SLUG { "Inbox".into() } else { slug.to_string() });
        let mut seen = HashSet::new();
        let mut parsed = 0;
        if let Ok(rd) = fs::read_dir(dir.join("cards")) {
            for e in rd.filter_map(|e| e.ok()) {
                let path = e.path();
                if path.extension().is_none_or(|x| x != "md") {
                    continue;
                }
                let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
                if id.starts_with('.') || crate::storage::check_id(&id).is_err() {
                    continue;
                }
                let Ok(meta) = e.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let st = stamp(&meta);
                seen.insert(id.clone());
                if p.docs.get(&id).is_some_and(|(old, _)| *old == st) {
                    continue;
                }
                // Unreadable files are skipped here; load_project already surfaces them as warnings.
                match fs::read_to_string(&path).ok().and_then(|t| parse_card(&t, &id).ok()) {
                    Some(card) => {
                        p.docs.insert(id, (st, Doc::new(card)));
                        parsed += 1;
                    }
                    None => {
                        p.docs.remove(&id);
                    }
                }
            }
        }
        p.docs.retain(|id, _| seen.contains(id));
        p.loaded = true;
        p.dirty = false;
        parsed
    }

    /// Refreshes the given project, or every project when `None`. Returns the slugs covered.
    fn refresh(&mut self, project: Option<&str>) -> Vec<String> {
        let Some(root) = self.root.clone() else { return vec![] };
        let slugs = match project {
            Some(p) => vec![p.to_string()],
            None => {
                let slugs = list_slugs(&root);
                // Projects deleted on disk drop out of the index.
                self.projects.retain(|k, _| slugs.contains(k));
                slugs
            }
        };
        self.last_parsed = slugs.iter().map(|s| self.refresh_project(s)).sum();
        slugs
    }

    pub fn search(&mut self, query: &str, project: Option<&str>, limit: usize) -> Vec<SearchHit> {
        let q: Vec<String> = {
            let mut seen = HashSet::new();
            terms(query).into_iter().filter(|t| seen.insert(t.clone())).collect()
        };
        if q.is_empty() {
            return vec![];
        }
        let phrase = fold(query.trim());
        let slugs = self.refresh(project);
        let mut hits: Vec<(f32, &str, &str, &Doc)> = Vec::new();
        for slug in &slugs {
            let Some(p) = self.projects.get(slug) else { continue };
            for (_, d) in p.docs.values() {
                let s = score_doc(d, &q, &phrase);
                if s > 0.0 {
                    hits.push((s, slug.as_str(), p.name.as_str(), d));
                }
            }
        }
        hits.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.3.card.meta.title.cmp(&b.3.card.meta.title)));
        hits.truncate(limit.clamp(1, MAX_LIMIT));
        hits.into_iter()
            .map(|(score, slug, name, d)| {
                let c = &d.card;
                let body_hit = q.iter().any(|t| d.body.contains_key(t) || d.body.keys().any(|w| t.chars().count() >= 3 && w.starts_with(t.as_str())));
                let source = if body_hit || d.fields_text.is_empty() { &c.body } else { &d.fields_text };
                SearchHit {
                    id: c.meta.id.clone(),
                    project: slug.to_string(),
                    project_name: name.to_string(),
                    title: c.meta.title.clone(),
                    stage: c.meta.stage,
                    tags: c.meta.tags.clone(),
                    ghost: c.meta.ghost,
                    snippet: snippet(source, &q),
                    score: (score * 100.0).round() / 100.0,
                }
            })
            .collect()
    }

    /// Finds a card anywhere in the workspace (ids are ULIDs, so unique across projects).
    /// `prefer` is checked first.
    pub fn find(&mut self, id: &str, prefer: Option<&str>) -> Option<(String, Card)> {
        if let Some(p) = prefer {
            self.refresh(Some(p));
            if let Some((_, d)) = self.projects.get(p).and_then(|x| x.docs.get(id)) {
                return Some((p.to_string(), d.card.clone()));
            }
        }
        for slug in self.refresh(None) {
            if let Some((_, d)) = self.projects.get(&slug).and_then(|x| x.docs.get(id)) {
                return Some((slug, d.card.clone()));
            }
        }
        None
    }

    pub fn title_of(&self, project: &str, id: &str) -> Option<String> {
        self.projects.get(project)?.docs.get(id).map(|(_, d)| d.card.meta.title.clone())
    }

    /// Cards linked to or from `id` (same project), then cards sharing tags (any project),
    /// most shared tags first.
    pub fn related(&mut self, id: &str, limit: usize) -> Option<Vec<Related>> {
        let (slug, card) = self.find(id, None)?;
        let my_tags: HashSet<String> = card.meta.tags.iter().map(|t| fold(t.trim())).filter(|t| !t.is_empty()).collect();
        let outgoing: HashSet<&str> = card.meta.links.iter().map(|l| l.to.as_str()).collect();
        let mut out: Vec<(u32, Related)> = Vec::new();
        for (pslug, p) in &self.projects {
            for (_, d) in p.docs.values() {
                let c = &d.card;
                if c.meta.id == id {
                    continue;
                }
                let mut relation = Vec::new();
                let mut rank = 0;
                if *pslug == slug {
                    if outgoing.contains(c.meta.id.as_str()) {
                        relation.push("linked from this card".to_string());
                        rank += 100;
                    }
                    if c.meta.links.iter().any(|l| l.to == id) {
                        relation.push("links to this card".to_string());
                        rank += 100;
                    }
                }
                let shared: Vec<&String> = c.meta.tags.iter().filter(|t| my_tags.contains(&fold(t.trim()))).collect();
                if !shared.is_empty() {
                    relation.push(format!("shares tags: {}", shared.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
                    rank += 10 * shared.len() as u32 + if *pslug == slug { 5 } else { 0 };
                }
                if !relation.is_empty() {
                    out.push((rank, Related { id: c.meta.id.clone(), project: pslug.clone(), title: c.meta.title.clone(), stage: c.meta.stage, ghost: c.meta.ghost, relation }));
                }
            }
        }
        out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
        Some(out.into_iter().take(limit.clamp(1, MAX_LIMIT)).map(|(_, r)| r).collect())
    }

    /// Links of a card with the target's title resolved (for `read_card`).
    pub fn describe_links(&self, project: &str, links: &[Link]) -> Vec<Value> {
        links
            .iter()
            .map(|l| {
                serde_json::json!({
                    "to": l.to,
                    "label": l.label,
                    "title": self.title_of(project, &l.to),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Frontmatter, NewCard};
    use crate::storage::{serialize_card, Workspace};
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn card(id: &str, title: &str, tags: &[&str], body: &str) -> Card {
        Card {
            meta: Frontmatter { id: id.into(), title: title.into(), tags: tags.iter().map(|s| s.to_string()).collect(), ..Default::default() },
            body: body.into(),
        }
    }

    fn write(dir: &Path, c: &Card) {
        fs::write(dir.join("cards").join(format!("{}.md", c.meta.id)), serialize_card(c).unwrap()).unwrap();
    }

    fn setup() -> (TempDir, Workspace, SearchIndex) {
        let tmp = TempDir::new().unwrap();
        let ws = Workspace::open(tmp.path()).unwrap();
        let mut idx = SearchIndex::default();
        idx.set_root(&ws.root);
        (tmp, ws, idx)
    }

    #[test]
    fn folding_and_stemming() {
        assert_eq!(fold("Café ÉLAN Œuvre Straße"), "cafe elan oeuvre strasse");
        for (a, b) in [
            ("games", "game"),
            ("gaming", "game"),
            ("gamed", "game"),
            ("running", "run"),
            ("runs", "run"),
            ("boxes", "box"),
            ("planned", "plan"),
            ("falling", "fall"),
            ("missed", "miss"),
            ("stories", "story"),
            ("dragons", "dragon"),
        ] {
            assert_eq!(stem(a), stem(b), "{a} vs {b}");
        }
        // Not over-stemmed.
        assert_eq!(stem("glass"), "glass");
        assert_eq!(stem("bus"), "bus");
        assert_eq!(stem("axis"), "axis");
        assert_eq!(stem("ring"), "ring");
        assert_eq!(stem("red"), "red");
        assert_eq!(stem("level42"), "level42");
        assert_eq!(terms("Neon-bait, GLOWING!"), vec!["neon", "bait", "glow"]);
    }

    #[test]
    fn scoring_prefers_title_then_tags_then_fields_then_body() {
        let (_t, ws, mut idx) = setup();
        let dir = ws.project_dir("inbox").unwrap();
        write(&dir, &card("01BODY", "Something else", &[], "a dragon sleeps here"));
        write(&dir, &card("01TITLE", "Dragon rider", &[], ""));
        write(&dir, &card("01TAG", "Cave level", &["dragons"], ""));
        let mut f = card("01FIELD", "Boss fight", &[], "");
        f.meta.fields = BTreeMap::from([("enemy".to_string(), Value::String("Dragon king".into()))]);
        write(&dir, &f);
        write(&dir, &card("01NONE", "Fishing", &[], "no match"));
        let hits = idx.search("DRAGONS", None, 10);
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["01TITLE", "01TAG", "01FIELD", "01BODY"]);
        assert!(hits.windows(2).all(|w| w[0].score > w[1].score));
        assert_eq!(hits[0].project, "inbox");
        assert_eq!(hits[0].project_name, "Inbox");
    }

    #[test]
    fn accents_coverage_prefix_and_ghosts() {
        let (_t, ws, mut idx) = setup();
        let dir = ws.project_dir("inbox").unwrap();
        write(&dir, &card("01CAFE", "Café crawl", &[], ""));
        write(&dir, &card("01BOTH", "Neon lake", &[], ""));
        write(&dir, &card("01ONE", "Neon neon neon", &[], "neon neon neon neon"));
        let mut g = card("01GHOST", "Lake monster", &[], "");
        g.meta.ghost = true;
        write(&dir, &g);
        assert_eq!(idx.search("cafe", None, 5)[0].id, "01CAFE");
        assert_eq!(idx.search("CAFÉS", None, 5)[0].id, "01CAFE");
        // Matching both words beats repeating one.
        assert_eq!(idx.search("neon lake", None, 5)[0].id, "01BOTH");
        // Prefix: "mons" finds "monster"; ghosts are included and flagged.
        let h = idx.search("mons", None, 5);
        assert_eq!(h.len(), 1);
        assert!(h[0].ghost);
        assert!(idx.search("   ", None, 5).is_empty());
        assert!(idx.search("zzz", None, 5).is_empty());
    }

    #[test]
    fn snippet_centers_on_the_match() {
        let filler = "lorem ipsum dolor sit amet ".repeat(30);
        let text = format!("{filler}the hidden treasure lies under the old mill {filler}");
        let s = snippet(&text, &terms("treasure"));
        assert!(s.contains("treasure"), "{s}");
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.chars().count() <= SNIPPET_CHARS + 2);
        assert_eq!(snippet("short\n\nbody", &terms("x")), "short body");
    }

    #[test]
    fn trashed_cards_are_skipped_and_scope_is_respected() {
        let (_t, ws, mut idx) = setup();
        let p = ws.create_project("Fish").unwrap();
        let a = ws.create_card("inbox", NewCard { title: Some("Lake idea".into()), ..Default::default() }).unwrap();
        let b = ws.create_card(&p.slug, NewCard { title: Some("Lake boss".into()), ..Default::default() }).unwrap();
        assert_eq!(idx.search("lake", None, 10).len(), 2);
        assert_eq!(idx.search("lake", Some(&p.slug), 10).iter().map(|h| h.id.clone()).collect::<Vec<_>>(), vec![b.meta.id.clone()]);
        ws.delete_card("inbox", &a.meta.id).unwrap();
        idx.mark_dirty(Some("inbox"));
        let hits = idx.search("lake", None, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].project_name, "Fish");
    }

    #[test]
    fn index_updates_incrementally_from_dirty_marks() {
        let (_t, ws, mut idx) = setup();
        let dir = ws.project_dir("inbox").unwrap();
        for i in 0..20 {
            write(&dir, &card(&format!("01C{i:02}"), &format!("Card {i}"), &[], "plain"));
        }
        idx.search("card", None, 5);
        assert_eq!(idx.last_parsed, 20);
        // Nothing marked dirty: no re-parse, even though a file changed underneath.
        write(&dir, &card("01C05", "Volcano", &[], "plain body, now longer"));
        idx.search("card", None, 5);
        assert_eq!(idx.last_parsed, 0);
        assert!(idx.search("volcano", None, 5).is_empty(), "stale until the watcher says so");
        // The watcher marks the project dirty: exactly the one changed file is re-parsed.
        idx.mark_dirty(Some("inbox"));
        assert_eq!(idx.search("volcano", None, 5)[0].id, "01C05");
        assert_eq!(idx.last_parsed, 1);
        // Added and removed files.
        write(&dir, &card("01NEW", "Volcano two", &[], ""));
        fs::remove_file(dir.join("cards/01C05.md")).unwrap();
        idx.mark_dirty(Some("inbox"));
        let ids: Vec<String> = idx.search("volcano", None, 5).into_iter().map(|h| h.id).collect();
        assert_eq!(ids, vec!["01NEW"]);
        assert_eq!(idx.last_parsed, 1);
        // Switching roots clears the index.
        let other = TempDir::new().unwrap();
        let ws2 = Workspace::open(other.path()).unwrap();
        idx.set_root(&ws2.root);
        assert!(idx.search("volcano", None, 5).is_empty());
    }

    #[test]
    fn related_finds_links_both_ways_and_shared_tags() {
        let (_t, ws, mut idx) = setup();
        let dir = ws.project_dir("inbox").unwrap();
        let mut me = card("01ME", "Me", &["boss", "Water"], "");
        me.meta.links = vec![Link { to: "01OUT".into(), label: None }];
        write(&dir, &me);
        write(&dir, &card("01OUT", "Out", &[], ""));
        let mut inc = card("01IN", "In", &[], "");
        inc.meta.links = vec![Link { to: "01ME".into(), label: Some("feeds".into()) }];
        write(&dir, &inc);
        write(&dir, &card("01TAG2", "Two tags", &["water", "boss"], ""));
        write(&dir, &card("01TAG1", "One tag", &["boss"], ""));
        write(&dir, &card("01NO", "Unrelated", &["fire"], ""));
        let r = idx.related("01ME", 10).unwrap();
        let ids: Vec<&str> = r.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["01IN", "01OUT", "01TAG2", "01TAG1"]);
        assert_eq!(r[2].relation, vec!["shares tags: water, boss".to_string()]);
        assert!(idx.related("01MISSING", 10).is_none());
        let (slug, c) = idx.find("01IN", None).unwrap();
        assert_eq!(slug, "inbox");
        assert_eq!(idx.describe_links(&slug, &c.meta.links)[0]["title"], "Me");
    }

    /// Mirrors the `?stress=1` seed in src/api/mock.ts (500 cards, 4 stages, every third tagged),
    /// with a few distinctive cards mixed in so ranking is checked at scale too.
    #[test]
    fn stress_500_card_seed() {
        let (_t, ws, mut idx) = setup();
        let p = ws.create_project("Stress test (500 cards)").unwrap();
        let dir = ws.project_dir(&p.slug).unwrap();
        let stages = [Stage::Cloud, Stage::Sketch, Stage::Draft, Stage::Pitch];
        for i in 0..500 {
            let mut c = card(&format!("01S{i:04}"), &format!("Idea {i}"), if i % 3 == 0 { &["tag"] } else { &[] }, "Lorem ipsum dolor sit amet, consectetur adipiscing elit.");
            c.meta.stage = stages[i % 4];
            if i == 417 {
                c.meta.title = "Clockwork leviathan".into();
            }
            write(&dir, &c);
        }
        let t = Instant::now();
        let hits = idx.search("leviathan", None, 8);
        let cold = t.elapsed();
        assert_eq!(idx.last_parsed, 500);
        assert_eq!(hits[0].id, "01S0417");

        let t = Instant::now();
        for _ in 0..20 {
            assert_eq!(idx.search("lorem ipsum", None, 8).len(), 8);
        }
        let warm = t.elapsed() / 20;
        assert_eq!(idx.last_parsed, 0);
        assert_eq!(idx.search("tag", Some(&p.slug), 100).len(), 100, "limit is honored");

        // One edit → one re-parse, then a search: still fast.
        write(&dir, &card("01S0003", "Idea 3: leviathan's egg", &["tag"], "Lorem"));
        idx.mark_dirty(Some(&p.slug));
        let t = Instant::now();
        let hits = idx.search("leviathan", None, 8);
        let incremental = t.elapsed();
        assert_eq!(idx.last_parsed, 1);
        assert_eq!(hits.len(), 2);
        println!("500 cards: cold {cold:?}, warm {warm:?}, after one edit {incremental:?}");
        // Generous bounds (debug build, slow CI disks); typical numbers are far lower.
        assert!(warm < Duration::from_millis(100), "warm search took {warm:?}");
        assert!(incremental < Duration::from_millis(200), "incremental search took {incremental:?}");
    }
}

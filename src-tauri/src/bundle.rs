//! `.dreamer.md` bundles (spec: docs/bundle-format.md): a lenient parser, no I/O.

use crate::model::{Link, Stage};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Header {
    pub bundle_id: String,
    pub title: String,
    pub project: Option<String>,
    pub version: Option<String>,
    pub frame: Option<String>,
    pub source: String,
    pub created: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BCard {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub id: Option<String>,
    pub title: String,
    pub stage: Stage,
    pub tags: Vec<String>,
    pub frame: Option<String>,
    /// `to` is a ref of this bundle or an existing card id (checked when applied).
    pub links: Vec<Link>,
    pub fields: BTreeMap<String, Value>,
    pub build: Option<Value>,
    pub body: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Bundle {
    pub header: Header,
    pub cards: Vec<BCard>,
    pub warnings: Vec<String>,
}

const MARK: &str = "<!-- card -->";
const SOURCES: [&str; 4] = ["claude.ai", "claude-code", "dreamer-scan", "other"];

/// Text without BOM, with LF line ends and without a surrounding ``` fence.
fn clean(text: &str) -> String {
    let t = text.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = t.lines().collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.first().is_some_and(|l| l.trim_start().starts_with("```")) {
        lines.remove(0);
        if lines.last().is_some_and(|l| l.trim() == "```") {
            lines.pop();
        }
    }
    lines.join("\n")
}

/// Splits `---\n<yaml>\n---\n<rest>`; None when the text doesn't open with a front-matter block.
fn split_front(t: &str) -> Option<(&str, &str)> {
    let rest = t.strip_prefix("---\n").or_else(|| t.trim_start().strip_prefix("---\n"))?;
    if let Some(after) = rest.strip_prefix("---") {
        return Some(("", after.trim_start_matches('\n')));
    }
    let i = rest.find("\n---").filter(|i| rest[i + 4..].is_empty() || rest[i + 4..].starts_with('\n'))?;
    Some((&rest[..i], rest[i + 4..].trim_start_matches('\n')))
}

/// Is this a bundle: first non-blank line (after an optional fence) is `---` and the header has `dreamer_bundle`.
pub fn detect(text: &str) -> bool {
    let t = clean(text);
    split_front(&t).is_some_and(|(h, _)| serde_yaml::from_str::<serde_yaml::Mapping>(h).is_ok_and(|m| m.contains_key("dreamer_bundle")))
}

fn s(v: &serde_yaml::Value) -> Option<String> {
    match v {
        serde_yaml::Value::String(x) => Some(x.trim().to_string()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
    .filter(|x| !x.is_empty())
}

fn to_json(v: &serde_yaml::Value) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

pub fn parse(text: &str) -> Result<Bundle, String> {
    let t = clean(text);
    let (head, rest) = split_front(&t).ok_or("Not a Dreamer bundle: it doesn't start with a --- header.")?;
    let hm: serde_yaml::Mapping = serde_yaml::from_str(head).map_err(|e| format!("The bundle header isn't valid YAML: {e}"))?;
    if !hm.contains_key("dreamer_bundle") {
        return Err("Not a Dreamer bundle: the header has no dreamer_bundle key.".into());
    }
    let mut warnings = Vec::new();
    let mut h = Header::default();
    for (k, v) in &hm {
        let key = k.as_str().unwrap_or("");
        let val = s(v);
        match key {
            "dreamer_bundle" => {
                if val.as_deref() != Some("1") {
                    warnings.push(format!("Bundle version {} is not 1; read as version 1.", val.unwrap_or_default()));
                }
            }
            "bundle_id" => h.bundle_id = val.unwrap_or_default(),
            "title" => h.title = val.unwrap_or_default(),
            "project" => h.project = val,
            "version" => h.version = val,
            "frame" => h.frame = val,
            "source" => h.source = val.unwrap_or_default(),
            "created" => h.created = val.unwrap_or_default(),
            other => warnings.push(format!("Unknown header key \"{other}\" ignored.")),
        }
    }
    if !SOURCES.contains(&h.source.as_str()) {
        if !h.source.is_empty() {
            warnings.push(format!("Unknown source \"{}\"; treated as other.", h.source));
        }
        h.source = "other".into();
    }
    if h.title.is_empty() {
        h.title = "Imported cards".into();
    }

    let mut cards: Vec<BCard> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // Text before the first marker is ignored; a bundle with no marker has no cards.
    for (n, chunk) in rest.split('\n').fold(Vec::<Vec<&str>>::new(), |mut acc, line| {
        if line.trim() == MARK {
            acc.push(Vec::new());
        } else if let Some(c) = acc.last_mut() {
            c.push(line);
        }
        acc
    })
    .into_iter()
    .enumerate()
    {
        let src = chunk.join("\n");
        let src = src.trim_start_matches('\n');
        let at = format!("Card {}", n + 1);
        let Some((fm, body)) = split_front(src) else {
            warnings.push(format!("{at} skipped: no --- front matter."));
            continue;
        };
        let m: serde_yaml::Mapping = match serde_yaml::from_str(fm) {
            Ok(m) => m,
            Err(e) => {
                warnings.push(format!("{at} skipped: bad YAML ({e})."));
                continue;
            }
        };
        let mut c = BCard {
            r#ref: String::new(),
            id: None,
            title: String::new(),
            stage: Stage::Mist,
            tags: vec![],
            frame: None,
            links: vec![],
            fields: BTreeMap::new(),
            build: None,
            body: body.trim_matches('\n').to_string(),
        };
        for (k, v) in &m {
            match k.as_str().unwrap_or("") {
                "ref" => c.r#ref = s(v).unwrap_or_default(),
                "id" => c.id = s(v),
                "title" => c.title = s(v).unwrap_or_default(),
                "stage" => {
                    let st = s(v).unwrap_or_default().to_lowercase();
                    c.stage = match st.as_str() {
                        "mist" => Stage::Mist,
                        "reverie" => Stage::Reverie,
                        "lucid" => Stage::Lucid,
                        "dream" => Stage::Dream,
                        "built" => {
                            c.build.get_or_insert_with(|| serde_json::json!({ "status": "built" }));
                            Stage::Built
                        }
                        other => {
                            warnings.push(format!("{at}: unknown stage \"{other}\", using mist."));
                            Stage::Mist
                        }
                    }
                }
                "tags" => match v {
                    serde_yaml::Value::Sequence(l) => c.tags = l.iter().filter_map(s).collect(),
                    other => c.tags = s(other).map(|x| vec![x]).unwrap_or_default(),
                },
                "frame" => c.frame = s(v),
                "links" => {
                    if let serde_yaml::Value::Sequence(l) = v {
                        for e in l {
                            let to = e.get("to").and_then(s).or_else(|| s(e));
                            match to {
                                Some(to) => c.links.push(Link { to, label: e.get("label").and_then(s) }),
                                None => warnings.push(format!("{at}: a link without \"to\" was dropped.")),
                            }
                        }
                    }
                }
                "fields" => {
                    if let Value::Object(o) = to_json(v) {
                        c.fields = o.into_iter().collect();
                    }
                }
                "build" => {
                    let b = to_json(v);
                    if b.is_object() {
                        c.build = Some(b);
                    }
                }
                other => warnings.push(format!("{at}: unknown key \"{other}\" ignored.")),
            }
        }
        if c.title.is_empty() {
            c.title = c.body.lines().find_map(|l| l.trim().strip_prefix("# ").map(|t| t.trim().to_string())).unwrap_or_else(|| "Untitled".into());
        }
        if c.r#ref.is_empty() {
            c.r#ref = format!("card-{}", n + 1);
            warnings.push(format!("{at} has no ref; named {}.", c.r#ref));
        }
        if !seen.insert(c.r#ref.clone()) {
            let old = c.r#ref.clone();
            let mut k = 2;
            while seen.contains(&format!("{old}-{k}")) {
                k += 1;
            }
            c.r#ref = format!("{old}-{k}");
            seen.insert(c.r#ref.clone());
            warnings.push(format!("Duplicate ref \"{old}\" renamed {}.", c.r#ref));
        }
        cards.push(c);
    }
    // Links: to another ref of this bundle, or to an existing card id (checked at import).
    let refs: HashSet<String> = cards.iter().map(|c| c.r#ref.clone()).collect();
    for c in &mut cards {
        let mine = c.r#ref.clone();
        c.links.retain(|l| {
            let ok = refs.contains(&l.to) || (l.to.len() == 26 && l.to.chars().all(|ch| ch.is_ascii_alphanumeric()));
            if !ok {
                warnings.push(format!("{mine}: link to unknown ref \"{}\" dropped.", l.to));
            }
            ok
        });
    }
    if h.bundle_id.is_empty() {
        let key: String = std::iter::once(h.title.clone()).chain(cards.iter().map(|c| c.r#ref.clone())).collect::<Vec<_>>().join("|");
        h.bundle_id = format!("auto-{:012x}", fnv(&key) & 0xffff_ffff_ffff);
        warnings.push("No bundle_id: made one from the title and refs.".into());
    }
    Ok(Bundle { header: h, cards, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "---\ndreamer_bundle: 1\nbundle_id: b1\ntitle: Ideas\nproject: Fish Game\nsource: claude.ai\ncreated: 2026-01-01T00:00:00Z\n---\n<!-- card -->\n---\nref: a\ntitle: First\nstage: lucid\ntags: [x, y]\nlinks: [{to: b, label: needs}]\nfields: {k: 1}\n---\nBody one\n\n---\nmore\n<!-- card -->\n---\nref: b\ntitle: Second\nstage: built\n---\nBody two\n";

    #[test]
    fn parses_a_good_bundle() {
        let b = parse(GOOD).unwrap();
        assert_eq!(b.header.bundle_id, "b1");
        assert_eq!(b.header.project.as_deref(), Some("Fish Game"));
        assert_eq!(b.cards.len(), 2);
        assert_eq!(b.cards[0].stage, Stage::Lucid);
        assert_eq!(b.cards[0].tags, ["x", "y"]);
        assert_eq!(b.cards[0].links[0].label.as_deref(), Some("needs"));
        assert_eq!(b.cards[0].body, "Body one\n\n---\nmore");
        assert_eq!(b.cards[1].stage, Stage::Built);
        assert!(b.cards[1].build.is_some());
        assert!(b.warnings.is_empty(), "{:?}", b.warnings);
    }

    #[test]
    fn crlf_bom_and_fences() {
        let t = format!("\u{feff}```dreamer\n{GOOD}```\n").replace('\n', "\r\n");
        assert!(detect(&t));
        assert_eq!(parse(&t).unwrap().cards.len(), 2);
        assert!(detect(&format!("\n\n```markdown\n{GOOD}\n```")));
    }

    #[test]
    fn detection_is_strict() {
        assert!(!detect("hello\n---\ndreamer_bundle: 1\n---\n"));
        assert!(!detect("---\ntitle: plain card\n---\nbody"));
        assert!(!detect("# Heading"));
        assert!(parse("# Heading").is_err());
    }

    #[test]
    fn lenient_problems_become_warnings() {
        let t = "---\ndreamer_bundle: 1\nbogus: 1\n---\n<!-- card -->\n---\nref: a\ntitle: A\nstage: weird\nmystery: 1\nlinks: [{to: nope}, {to: b}]\n---\nx\n<!-- card -->\n---\nref: a\ntitle: dup\n---\ny\n<!-- card -->\n---\nref: [unclosed\n---\nz\n<!-- card -->\n---\nref: b\ntitle: B\n---\nw\n";
        let b = parse(t).unwrap();
        let refs: Vec<&str> = b.cards.iter().map(|c| c.r#ref.as_str()).collect();
        assert_eq!(refs, ["a", "a-2", "b"]); // the broken card is skipped, the duplicate renamed
        assert_eq!(b.cards[0].stage, Stage::Mist);
        assert_eq!(b.cards[0].links.len(), 1);
        for needle in ["bogus", "weird", "mystery", "nope", "Duplicate ref", "bad YAML", "bundle_id"] {
            assert!(b.warnings.iter().any(|w| w.contains(needle)), "no warning for {needle}: {:?}", b.warnings);
        }
        // Without a bundle_id the made-up one is stable.
        assert_eq!(b.header.bundle_id, parse(t).unwrap().header.bundle_id);
    }

    #[test]
    fn empty_and_missing_titles() {
        let t = "---\ndreamer_bundle: 1\nbundle_id: z\n---\n<!-- card -->\n---\nref: a\n---\n# Heading title\ntext";
        let b = parse(t).unwrap();
        assert_eq!(b.cards[0].title, "Heading title");
        assert_eq!(b.header.source, "other");
    }
}

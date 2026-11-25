//! `docs/design/STATUS.md` (spec: docs/status-format.md): the build status Claude Code writes back.
//! A lenient parser, no I/O. The apply side lives in storage/build.rs.

pub const STATUSES: [&str; 4] = ["in-progress", "built", "partial", "blocked"];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Entry {
    /// None for a `## new · title` entry (a feature built without a card).
    pub id: Option<String>,
    pub title: String,
    pub status: Option<String>,
    pub task: Option<String>,
    pub commits: Vec<String>,
    pub files: Vec<String>,
    pub evidence: Vec<String>,
    /// `notes:` plus every unknown key as `key: value`, one per line.
    pub notes: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
}

/// Stable 64-bit FNV-1a (these hashes are stored on disk, so `DefaultHasher` won't do).
pub fn fnv(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.bytes().chain(std::iter::once(0xff)) {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

impl Entry {
    /// Identity in build-sync.json: the card id, or the title of a `new` entry.
    pub fn key(&self) -> String {
        self.id.clone().unwrap_or_else(|| format!("new:{}", self.title.trim().to_lowercase()))
    }
    /// Changes whenever anything the entry says changes.
    pub fn hash(&self) -> String {
        let (c, f, e) = (self.commits.join(","), self.files.join(","), self.evidence.join(","));
        fnv(&[&self.key(), &self.title, self.status.as_deref().unwrap_or(""), self.task.as_deref().unwrap_or(""), &c, &f, &e, self.notes.as_deref().unwrap_or("")])
    }
    /// What a dismissed `new` entry is remembered by: its title and files.
    pub fn dismiss_key(&self) -> String {
        fnv(&[&self.title.trim().to_lowercase(), &self.files.join(",")])
    }
}

fn id_like(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn list(v: &str) -> Vec<String> {
    v.split(',').map(|x| x.trim().trim_matches('`').trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// "In progress", "in_progress" and "in-progress" are one status; None when it is none of ours.
pub fn norm_status(s: &str) -> Option<&'static str> {
    let n = s.trim().to_lowercase().replace([' ', '_'], "-");
    STATUSES.into_iter().find(|k| *k == n)
}

pub fn parse(text: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut cur: Option<Entry> = None;
    let mut extra: Vec<String> = Vec::new();
    let mut last_key = String::new();
    let mut in_comment = false;
    let finish = |cur: &mut Option<Entry>, extra: &mut Vec<String>, out: &mut Parsed| {
        if let Some(mut e) = cur.take() {
            if !extra.is_empty() {
                let more = extra.join("\n");
                e.notes = Some(match e.notes.take() {
                    Some(n) if !n.is_empty() => format!("{n}\n{more}"),
                    _ => more,
                });
            }
            out.entries.push(e);
        }
        extra.clear();
    };
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if in_comment {
            in_comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("<!--") {
            in_comment = !line.contains("-->");
            continue;
        }
        if let Some(head) = line.strip_prefix("## ") {
            finish(&mut cur, &mut extra, &mut out);
            last_key.clear();
            let (left, right) = match head.split_once('·') {
                Some((l, r)) => (l.trim(), r.trim()),
                None => ("", head.trim()),
            };
            let (id, title) = if left.eq_ignore_ascii_case("new") || (left.is_empty() && !id_like(right)) {
                (None, right.to_string())
            } else if left.is_empty() {
                (Some(right.to_string()), String::new())
            } else if id_like(left) {
                (Some(left.to_string()), right.to_string())
            } else {
                out.warnings.push(format!("\"{head}\": the heading is neither \"<card id> · <title>\" nor \"new · <title>\"; skipped."));
                continue;
            };
            cur = Some(Entry { id, title, ..Default::default() });
            continue;
        }
        let Some(e) = cur.as_mut() else { continue };
        let body = line.trim_start_matches(['-', '*']).trim();
        let kv = body.split_once(':').filter(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-'));
        let Some((k, v)) = kv else {
            // A wrapped notes line continues the previous key; other stray text is ignored.
            if !line.is_empty() && last_key == "notes" {
                let n = e.notes.get_or_insert_with(String::new);
                if !n.is_empty() {
                    n.push(' ');
                }
                n.push_str(line);
            }
            continue;
        };
        let (k, v) = (k.trim().to_lowercase(), v.trim());
        last_key = k.clone();
        match k.as_str() {
            "status" => match norm_status(v) {
                Some(s) => e.status = Some(s.to_string()),
                None => out.warnings.push(format!("\"{}\": unknown status \"{v}\" (use in-progress, built, partial or blocked); ignored.", e.title)),
            },
            "task" => e.task = Some(v.to_string()).filter(|t| !t.is_empty()),
            "commits" => e.commits = list(v),
            "files" => e.files = list(v),
            "evidence" => e.evidence = list(v),
            "notes" => e.notes = Some(v.to_string()).filter(|t| !t.is_empty()),
            _ => extra.push(format!("{k}: {v}")),
        }
    }
    finish(&mut cur, &mut extra, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01JABCDEFGHJKMNPQRSTVWXYZ0";

    #[test]
    fn parses_the_documented_format() {
        let t = format!(
            "# Build status\n<!-- dreamer:status v1 -->\n\n## {ID} · Harpoon rod\nstatus: in-progress\ntask: tasks/harpoon.md\ncommits: abc123, def456\nfiles: src/rod.ts, `src/rod.test.ts`\nevidence: docs/design/evidence/rod.png\nnotes: casts and reels\n\n## new · Fish radio\nstatus: built\nfiles: src/radio.ts\nnotes: what it is and why it was added\n"
        );
        let p = parse(&t);
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!(p.entries.len(), 2);
        let a = &p.entries[0];
        assert_eq!((a.id.as_deref(), a.title.as_str(), a.status.as_deref()), (Some(ID), "Harpoon rod", Some("in-progress")));
        assert_eq!(a.task.as_deref(), Some("tasks/harpoon.md"));
        assert_eq!(a.commits, vec!["abc123", "def456"]);
        assert_eq!(a.files, vec!["src/rod.ts", "src/rod.test.ts"]);
        assert_eq!(a.evidence, vec!["docs/design/evidence/rod.png"]);
        let b = &p.entries[1];
        assert_eq!((b.id.clone(), b.title.as_str(), b.status.as_deref()), (None, "Fish radio", Some("built")));
        assert_eq!(b.key(), "new:fish radio");
    }

    #[test]
    fn is_lenient_about_order_missing_keys_extras_and_bad_status() {
        let t = format!(
            "## {ID} · A\nnotes: first\n  wrapped on\nowner: me\nstatus: In Progress\n\n## {ID}2 · B\nstatus: shipped\n\n## What is this? yes\ntext\n\n## Some title\n- status: partial\n<!--\nstatus: hidden\n-->\n"
        );
        let p = parse(&t);
        let a = &p.entries[0];
        assert_eq!(a.status.as_deref(), Some("in-progress"));
        assert_eq!(a.notes.as_deref(), Some("first wrapped on\nowner: me"), "extra keys are kept as notes");
        assert_eq!(p.entries[1].status, None, "an unknown status is dropped...");
        assert!(p.warnings.iter().any(|w| w.contains("unknown status \"shipped\"")), "...with a warning: {:?}", p.warnings);
        // "What is this? yes" has no dot: it is a new entry, not an id.
        let c = p.entries.last().unwrap();
        assert_eq!((c.id.as_deref(), c.title.as_str(), c.status.as_deref()), (None, "Some title", Some("partial")));
        assert_eq!(p.entries.len(), 4);
        assert_eq!(p.entries[2].title, "What is this? yes");
    }

    #[test]
    fn a_heading_with_a_dot_and_a_non_id_is_skipped_with_a_warning() {
        let p = parse("## Card 12 · title\nstatus: built\n");
        assert!(p.entries.is_empty() && p.warnings.len() == 1);
    }

    #[test]
    fn hash_follows_content_and_dismiss_key_follows_title_and_files() {
        let mut a = parse("## new · Radio\nstatus: built\nfiles: a.ts\n").entries.remove(0);
        let h = a.hash();
        assert_eq!(h, parse("## new · Radio\nfiles: a.ts\nstatus: built\n").entries[0].hash(), "key order is free");
        let d = a.dismiss_key();
        a.notes = Some("changed".into());
        assert_ne!(h, a.hash());
        assert_eq!(d, a.dismiss_key(), "notes don't change what was dismissed");
        a.files.push("b.ts".into());
        assert_ne!(d, a.dismiss_key());
    }
}

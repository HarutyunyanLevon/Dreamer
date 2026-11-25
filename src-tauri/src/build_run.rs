//! Build runs: Claude Code implements saved tasks inside the linked repo, on a branch of its own.
//! The sidecar runs the session ("build" mode, see claude-sidecar.mjs); this side owns the
//! permission rules, git, the per-run logs (`<project>/builds/<run>.jsonl` + `<run>.json`) and the
//! summary. One run per repo at a time; a run is a queue of tasks on ONE branch.

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::storage::{atomic_write, now};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

// ---------- permission rules ----------

#[derive(Debug, PartialEq, Clone)]
pub enum Verdict {
    Allow,
    /// Shown to the user; the run waits for the answer.
    Ask(String),
    /// Sent back to Claude.
    Deny(String),
}

/// `p` (absolute, or relative to the repo) resolves inside `repo` (`dunce::canonicalize`d). The deepest part that
/// exists is resolved, symlinks included; the part that doesn't exist yet may not climb (`..`).
pub fn inside(repo: &Path, p: &str) -> bool {
    let p = p.trim();
    if p.is_empty() || p.starts_with('~') || p.contains('$') || p.contains('%') {
        return false;
    }
    // One separator style, so `..` is always a real component.
    let p = if cfg!(windows) { p.replace('/', "\\") } else { p.to_string() };
    let path = Path::new(&p);
    let full = if path.is_absolute() { path.to_path_buf() } else { repo.join(path) };
    let mut at = full.as_path();
    loop {
        if let Ok(c) = dunce::canonicalize(at) {
            return c.starts_with(repo);
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(_)) => at = parent,
            _ => return false, // ends in `..` or ran out of path
        }
    }
}

/// Shell words, split into segments at unquoted `; & | < >`, newlines, `(`/`)`, `$(` and backticks.
/// `complex`: anything beyond one plain command (operators, redirects, substitution, an open quote).
#[allow(unused_assignments)] // the macros reset state the last use never reads
fn segments(cmd: &str) -> (Vec<Vec<String>>, bool) {
    let (mut segs, mut cur, mut word) = (Vec::new(), Vec::new(), String::new());
    let (mut complex, mut in_word) = (false, false);
    let mut chars = cmd.chars().peekable();
    let mut quote: Option<char> = None;
    macro_rules! end_word {
        () => {
            if in_word {
                cur.push(std::mem::take(&mut word));
                in_word = false;
            }
        };
    }
    macro_rules! end_seg {
        () => {{
            end_word!();
            if !cur.is_empty() {
                segs.push(std::mem::take(&mut cur));
            }
        }};
    }
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                } else {
                    word.push(c);
                }
            }
            Some(_) => match c {
                '"' => quote = None,
                // In double quotes a backslash escapes only these (a Windows path keeps its backslashes).
                '\\' if matches!(chars.peek(), Some('$' | '`' | '"' | '\\' | '\n')) => {
                    if let Some(n) = chars.next() {
                        word.push(n);
                    }
                }
                // A substitution runs its content as a command: read it unquoted.
                '`' => {
                    complex = true;
                    quote = None;
                    end_seg!();
                }
                '$' if chars.peek() == Some(&'(') => {
                    complex = true;
                    quote = None;
                    chars.next();
                    end_seg!();
                }
                _ => word.push(c),
            },
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    in_word = true;
                }
                '\\' => {
                    if let Some(n) = chars.next() {
                        word.push(n);
                        in_word = true;
                    }
                }
                ' ' | '\t' => end_word!(),
                ';' | '&' | '|' | '<' | '>' | '\n' | '\r' | '(' | ')' | '`' => {
                    complex = true;
                    end_seg!();
                }
                '$' if chars.peek() == Some(&'(') => {
                    complex = true;
                    chars.next();
                    end_seg!();
                }
                _ => {
                    word.push(c);
                    in_word = true;
                }
            },
        }
    }
    if quote.is_some() {
        complex = true;
    }
    end_seg!();
    (segs, complex)
}

fn base_name(w: &str) -> String {
    Path::new(w).file_stem().and_then(OsStr::to_str).unwrap_or(w).to_lowercase()
}

/// Drops `VAR=value`, `env`, `sudo`, `command`, `nohup`, `time` in front of the real command.
fn strip_wrappers(w: &[String]) -> &[String] {
    let n = w.iter().take_while(|x| (x.contains('=') && !x.starts_with('-') && !x.starts_with('=')) || matches!(x.as_str(), "env" | "sudo" | "command" | "nohup" | "time")).count();
    &w[n..]
}

/// (global options present, index of the subcommand) of a `git` command.
fn git_sub(w: &[String]) -> Option<(bool, usize)> {
    if w.is_empty() || base_name(&w[0]) != "git" {
        return None;
    }
    let (mut i, mut globals) = (1, false);
    while i < w.len() && w[i].starts_with('-') {
        globals = true;
        if matches!(w[i].as_str(), "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace") {
            i += 1;
        }
        i += 1;
    }
    (i < w.len()).then_some((globals, i))
}

/// A short-option cluster (`-fd`) containing `c`.
fn short_has(a: &str, c: char) -> bool {
    a.starts_with('-') && !a.starts_with("--") && a[1..].contains(c)
}

fn denied(repo: &Path, words: &[String]) -> Option<String> {
    let w = strip_wrappers(words);
    if let Some((_, i)) = git_sub(w) {
        let args = &w[i + 1..];
        let has = |s: &str| args.iter().any(|a| a == s);
        return match w[i].as_str() {
            "push" => Some("git push is not allowed in a Dreamer build run: the branch stays local, the user merges it.".into()),
            "reset" if has("--hard") => Some("git reset --hard is not allowed in a build run: it throws work away. Make a new commit instead.".into()),
            "clean" if has("--force") || args.iter().any(|a| short_has(a, 'f')) => Some("git clean -f is not allowed in a build run: it deletes untracked files.".into()),
            "switch" => Some("Stay on the run's branch: switching branches is not allowed in a build run.".into()),
            "checkout" if !has("--") => Some("Stay on the run's branch: git checkout of a branch is not allowed. To restore a file use git checkout -- <file> or git restore <file>.".into()),
            "branch" if args.iter().any(|a| short_has(a, 'D')) || (has("--delete") && has("--force")) => Some("Deleting branches (git branch -D) is not allowed in a build run.".into()),
            _ => None,
        };
    }
    if w.first().map(|c| base_name(c)) == Some("rm".into()) {
        let mut after = false;
        let (mut rec, mut force, mut targets) = (false, false, Vec::new());
        for a in &w[1..] {
            if !after && a == "--" {
                after = true;
            } else if !after && a.starts_with("--") {
                rec |= a == "--recursive";
                force |= a == "--force";
            } else if !after && a.starts_with('-') && a.len() > 1 {
                rec |= short_has(a, 'r') || short_has(a, 'R');
                force |= short_has(a, 'f');
            } else {
                targets.push(a);
            }
        }
        if rec && force && targets.iter().any(|t| !inside(repo, t)) {
            return Some("rm -rf outside the repo is not allowed in a build run.".into());
        }
    }
    None
}

/// git status / git diff* / git log* / git add <paths in the repo> / git commit -m (no --amend, no -C).
fn safe_git(repo: &Path, w: &[String]) -> bool {
    let Some((globals, i)) = git_sub(w) else { return false };
    if globals || i != 1 {
        return false;
    }
    let args = &w[i + 1..];
    match w[i].as_str() {
        "status" => true,
        "diff" | "log" => !args.iter().any(|a| a.starts_with("--output") || a.starts_with("--ext-diff")),
        "add" => {
            const OK: [&str; 8] = ["-A", "--all", "-u", "--update", "-N", "--intent-to-add", "-v", "--verbose"];
            let (mut after, mut any) = (false, false);
            for a in args {
                if !after && a == "--" {
                    after = true;
                } else if !after && a.starts_with('-') {
                    if !OK.contains(&a.as_str()) {
                        return false;
                    }
                    any = true;
                } else if inside(repo, a) {
                    any = true;
                } else {
                    return false;
                }
            }
            any
        }
        "commit" => {
            let (mut msg, mut k) = (false, 0);
            while k < args.len() {
                let a = args[k].as_str();
                match a {
                    "-m" | "--message" | "-am" => {
                        msg = true;
                        k += 1;
                    }
                    "-a" | "--all" | "-q" | "--quiet" => {}
                    _ if a.starts_with("--message=") || (a.starts_with("-m") && a.len() > 2 && !a.starts_with("--")) => msg = true,
                    _ => return false,
                }
                k += 1;
            }
            msg && k <= args.len()
        }
        _ => false,
    }
}

/// What "Allow this command prefix" remembers: the first word, plus the second when it is not an option.
/// Claude Code often starts with `cd "<repo>" && …`: that `cd` changes nothing, so it is dropped
/// before the allow rules (not before the deny rules, which see every segment anyway).
fn strip_cd<'a>(repo: &Path, cmd: &'a str) -> &'a str {
    let t = cmd.trim_start();
    let Some(rest) = t.strip_prefix("cd ") else { return cmd };
    let Some(i) = rest.find("&&") else { return cmd };
    let (segs, complex) = segments(&rest[..i]);
    match segs.as_slice() {
        [w] if !complex && w.len() == 1 && inside(repo, &w[0]) => rest[i + 2..].trim_start(),
        _ => cmd,
    }
}

pub fn prefix_of(repo: &Path, cmd: &str) -> Option<String> {
    let (segs, complex) = segments(strip_cd(repo, cmd));
    let w = match segs.as_slice() {
        [one] if !complex => one,
        _ => return None,
    };
    let n = if w.len() > 1 && !w[1].starts_with('-') { 2 } else { 1 };
    Some(w[..n].join(" "))
}

fn bash(repo: &Path, cmd: &str, prefixes: &[String]) -> Verdict {
    let (segs, _) = segments(cmd);
    if let Some(why) = segs.iter().find_map(|s| denied(repo, s)) {
        return Verdict::Deny(why);
    }
    let (segs, complex) = segments(strip_cd(repo, cmd));
    if !complex && segs.len() == 1 {
        let w = &segs[0];
        if safe_git(repo, w) {
            return Verdict::Allow;
        }
        if prefixes.iter().any(|p| {
            let p: Vec<&str> = p.split_whitespace().collect();
            !p.is_empty() && w.len() >= p.len() && w.iter().zip(&p).all(|(a, b)| a == b)
        }) {
            return Verdict::Allow;
        }
    }
    Verdict::Ask("Run a command".into())
}

/// The rule for one tool call of a build run. `repo` is canonical.
pub fn decide(repo: &Path, tool: &str, input: &Value, prefixes: &[String]) -> Verdict {
    let s = |k: &str| input.get(k).and_then(Value::as_str);
    let at = |k: &str, optional: bool| match s(k) {
        None if optional => Verdict::Allow,
        Some(p) if inside(repo, p) => Verdict::Allow,
        Some(p) => Verdict::Ask(format!("{tool} outside the repo: {p}")),
        None => Verdict::Ask(format!("{tool} without a path")),
    };
    match tool {
        "TodoWrite" => Verdict::Allow,
        "Read" => at("file_path", false),
        "Glob" => match s("pattern") {
            Some(p) if Path::new(p).is_absolute() || p.split(['/', '\\']).any(|x| x == "..") => Verdict::Ask(format!("Glob outside the repo: {p}")),
            _ => at("path", true),
        },
        "Grep" | "LS" => at("path", true),
        "Edit" | "Write" | "MultiEdit" => at("file_path", false),
        "NotebookEdit" => at("notebook_path", false),
        "Bash" => bash(repo, s("command").unwrap_or_default(), prefixes),
        "WebFetch" => Verdict::Ask(format!("Open a web page: {}", s("url").unwrap_or_default())),
        "WebSearch" => Verdict::Ask(format!("Search the web: {}", s("query").unwrap_or_default())),
        other => Verdict::Ask(format!("Use {other}")),
    }
}

// ---------- git ----------

pub mod git {
    use crate::error::{AppError, Result};
    use std::path::Path;
    use std::process::Stdio;

    pub fn run(repo: &Path, args: &[&str]) -> Result<String> {
        let mut c = crate::claude_setup::command(Path::new("git"));
        let o = c.arg("-C").arg(repo).args(args).stdin(Stdio::null()).output().map_err(|e| AppError::io("run git (is it installed?)", e))?;
        if !o.status.success() {
            let err = String::from_utf8_lossy(&o.stderr);
            return Err(AppError::Invalid(format!("git {}: {}", args.first().unwrap_or(&""), err.trim())));
        }
        Ok(String::from_utf8_lossy(&o.stdout).trim_end().to_string())
    }
    pub fn is_repo(repo: &Path) -> bool {
        run(repo, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|o| o == "true")
    }
    pub fn dirty(repo: &Path) -> Result<bool> {
        Ok(!run(repo, &["status", "--porcelain"])?.trim().is_empty())
    }
    /// The checked-out branch; an error on a detached HEAD.
    pub fn branch(repo: &Path) -> Result<String> {
        run(repo, &["symbolic-ref", "--short", "HEAD"]).map_err(|_| AppError::Invalid("HEAD is detached: check out a branch first.".into()))
    }
    pub fn head(repo: &Path) -> Result<String> {
        run(repo, &["rev-parse", "HEAD"])
    }
    pub fn stash(repo: &Path) -> Result<()> {
        run(repo, &["stash", "push", "-u", "-m", "Dreamer: before a build run"]).map(|_| ())
    }
    /// `dreamer/<yyyymmdd>-<slug>`.
    pub fn branch_name(date: &str, title: &str) -> String {
        let mut slug = String::new();
        for c in title.to_lowercase().chars() {
            if c.is_ascii_alphanumeric() {
                slug.push(c);
            } else if !slug.ends_with('-') && !slug.is_empty() {
                slug.push('-');
            }
        }
        let slug: String = slug.chars().take(40).collect::<String>().trim_matches('-').to_string();
        format!("dreamer/{date}-{}", if slug.is_empty() { "run" } else { &slug })
    }
    /// Creates and checks out `want` from HEAD (`want-2`, `-3`… when it exists). Returns the name.
    pub fn create_branch(repo: &Path, want: &str) -> Result<String> {
        let (mut name, mut n) = (want.to_string(), 2);
        while run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok() {
            name = format!("{want}-{n}");
            n += 1;
        }
        run(repo, &["switch", "-c", &name])?;
        Ok(name)
    }
    /// Oldest first: (short hash, subject).
    pub fn commits(repo: &Path, base: &str, branch: &str) -> Result<Vec<(String, String)>> {
        let out = run(repo, &["log", "--reverse", "--format=%h%x09%s", &format!("{base}..{branch}")])?;
        Ok(out.lines().filter_map(|l| l.split_once('\t')).map(|(h, s)| (h.to_string(), s.to_string())).collect())
    }
    pub fn files(repo: &Path, base: &str, branch: &str) -> Result<Vec<String>> {
        Ok(run(repo, &["diff", "--name-only", &format!("{base}..{branch}")])?.lines().map(String::from).collect())
    }
    pub fn file_diff(repo: &Path, base: &str, branch: &str, file: &str) -> Result<String> {
        run(repo, &["diff", &format!("{base}..{branch}"), "--", file])
    }
    /// Merges `branch` into `base` (checked out first): fast-forward when possible, else a merge
    /// commit. A conflicted merge is aborted. Never pushes. Returns how it merged.
    pub fn merge(repo: &Path, base: &str, branch: &str) -> Result<&'static str> {
        if branch_or_empty(repo) != base {
            run(repo, &["switch", base])?;
        }
        if run(repo, &["merge", "--ff-only", branch]).is_ok() {
            return Ok("fast-forward");
        }
        match run(repo, &["merge", "--no-ff", "--no-edit", branch]) {
            Ok(_) => Ok("merge commit"),
            Err(e) => {
                let _ = run(repo, &["merge", "--abort"]);
                Err(e)
            }
        }
    }
    /// Deletes `branch` (switching to `base` first when it is checked out).
    pub fn delete_branch(repo: &Path, branch: &str, base: &str) -> Result<()> {
        if branch_or_empty(repo) == branch {
            run(repo, &["switch", base])?;
        }
        run(repo, &["branch", "-D", branch]).map(|_| ())
    }
    fn branch_or_empty(repo: &Path) -> String {
        branch(repo).unwrap_or_default()
    }
}

// ---------- runs ----------

pub enum Answer {
    Once,
    Prefix,
    Deny(String),
}

pub struct Run {
    pub id: String,
    slug: String,
    dir: PathBuf,
    repo: PathBuf,
    branch: String,
    base: String,
    base_sha: String,
    tasks: Vec<String>,
    titles: Vec<String>,
    cards: Vec<String>,
    current: usize,
    started: Instant,
    started_at: String,
    stashed: bool,
    model: String,
    prefixes: Vec<String>,
    /// Pending asks: request id -> (the ask event, where the answer goes).
    asks: HashMap<String, (Value, mpsc::Sender<Answer>)>,
    stop: Option<&'static str>,
}

impl Run {
    fn info(&self) -> Value {
        json!({
            "id": self.id, "slug": self.slug, "branch": self.branch, "base": self.base, "tasks": self.tasks, "titles": self.titles,
            "cards": self.cards, "current": self.current, "started_at": self.started_at, "stashed": self.stashed, "model": self.model,
            "asks": self.asks.values().map(|(v, _)| v.clone()).collect::<Vec<_>>(), "live": true,
        })
    }
}

fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, HashMap<String, Run>>> {
    state.claude.build.lock().map_err(|_| AppError::Invalid("build lock poisoned".into()))
}

fn emit(app: &AppHandle, run: &str, mut payload: Value) {
    payload["run"] = json!(run);
    let _ = app.emit("build-event", payload);
}

/// One line of `<project>/builds/<run>.jsonl`. Events only: tool names and labels, assistant text, asks and answers.
fn log(dir: &Path, run: &str, mut v: Value) {
    v["at"] = json!(now());
    let path = dir.join("builds").join(format!("{run}.jsonl"));
    let _ = fs::create_dir_all(path.parent().unwrap_or(dir));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{v}");
    }
}

fn check_run_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid(format!("not a run id: {id:?}")));
    }
    Ok(())
}

fn repo_of(state: &AppState, slug: &str) -> Result<(PathBuf, PathBuf)> {
    let ws = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?;
    let repo = crate::task::confirmed_repo(&ws, slug)?;
    let repo = dunce::canonicalize(&repo).map_err(|e| AppError::io(format!("open {}", repo.display()), e))?;
    Ok((repo, ws.existing_project_dir(slug)?))
}

/// Before a run: the repo must be a git repo; `dirty` = uncommitted changes (the UI asks what to do).
pub fn preflight(state: &AppState, slug: &str) -> Result<Value> {
    let (repo, _) = repo_of(state, slug)?;
    if !git::is_repo(&repo) {
        return Err(AppError::Invalid(format!("{} is not a git repository. Run `git init` there (and commit once) first.", repo.display())));
    }
    let busy = lock(state)?.values().any(|r| r.repo == repo);
    Ok(json!({ "repo": repo.display().to_string(), "branch": git::branch(&repo)?, "dirty": git::dirty(&repo)?, "busy": busy }))
}

/// Starts a run of `tasks` (repo-relative task files) on a new branch. `dirty`: "stash" | "continue"
/// for a tree with uncommitted changes (anything else refuses).
pub fn start(app: &AppHandle, state: &AppState, slug: &str, tasks: Vec<String>, dirty: &str) -> Result<Value> {
    if tasks.is_empty() {
        return Err(AppError::Invalid("Nothing to run: no task.".into()));
    }
    tasks.iter().try_for_each(|t| crate::task::file_name_ok(t).map(|_| ()))?;
    let (repo, dir) = repo_of(state, slug)?;
    if !git::is_repo(&repo) {
        return Err(AppError::Invalid(format!("{} is not a git repository.", repo.display())));
    }
    if lock(state)?.values().any(|r| r.repo == repo) {
        return Err(AppError::Invalid("A build run is already going on in this repo. Wait for it or interrupt it.".into()));
    }
    let all = crate::task::list(state, slug)?;
    let mut titles = Vec::new();
    let mut cards: Vec<String> = Vec::new();
    for t in &tasks {
        let info = all.iter().find(|i| &i.file == t).ok_or_else(|| AppError::NotFound(t.clone()))?;
        titles.push(info.title.clone());
        for c in &info.cards {
            if !cards.contains(c) {
                cards.push(c.clone());
            }
        }
    }
    let base = git::branch(&repo)?;
    let mut stashed = false;
    if git::dirty(&repo)? {
        match dirty {
            "stash" => {
                git::stash(&repo)?;
                stashed = true;
            }
            "continue" => {}
            _ => return Err(AppError::Invalid("The repo has uncommitted changes.".into())),
        }
    }
    let base_sha = git::head(&repo)?;
    let branch = git::create_branch(&repo, &git::branch_name(&chrono::Local::now().format("%Y%m%d").to_string(), &titles[0]))?;
    let model = state.ws.lock().ok().and_then(|ws| ws.get_settings().ok()).map(|s| s.build_model).unwrap_or_else(|| crate::model::DEFAULT_MODEL_BUILD.into());
    if let Ok(ws) = state.ws.lock() {
        if let Err(e) = ws.set_build_status(slug, &cards, "in-progress", "run") {
            eprintln!("[dreamer] build run: could not mark cards in progress: {e}");
        }
    }
    let id = ulid::Ulid::generate().to_string();
    let run = Run {
        id: id.clone(), slug: slug.into(), dir: dir.clone(), repo, branch, base, base_sha, tasks, titles, cards, current: 0, started: Instant::now(), started_at: now(),
        stashed, model, prefixes: vec![], asks: HashMap::new(), stop: None,
    };
    let info = run.info();
    log(&dir, &id, json!({ "type": "start", "branch": run.branch, "base": run.base, "tasks": run.tasks, "model": run.model }));
    lock(state)?.insert(id.clone(), run);
    emit(app, &id, json!({ "type": "started", "info": info }));
    if let Err(e) = send_task(app, state, &id) {
        finish(app, &id, "failed", Some(e.to_string()));
        return Err(e);
    }
    Ok(info)
}

fn send_task(app: &AppHandle, state: &AppState, id: &str) -> Result<()> {
    crate::sidecar::ensure_started(app, state)?;
    let msg = {
        let g = lock(state)?;
        let r = g.get(id).ok_or_else(|| AppError::NotFound(format!("run {id}")))?;
        json!({ "type": "build_start", "run": id, "cwd": crate::claude_setup::child_path(&r.repo), "prompt": crate::task::reference(&r.tasks[r.current]), "model": r.model })
    };
    crate::sidecar::write_line(state, &msg);
    Ok(())
}

/// A build_* message from the sidecar.
pub fn on_message(app: &AppHandle, msg: Value) {
    let state = app.state::<AppState>();
    let Some(id) = msg.get("run").and_then(Value::as_str).map(String::from) else { return };
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(dir) = lock(&state).ok().and_then(|g| g.get(&id).map(|r| r.dir.clone())) else { return };
    match kind {
        "build_step" => {
            let s = &msg["step"];
            // A step is logged once it has ended (running -> done/error), not on every relabel.
            if s.get("status").and_then(Value::as_str) != Some("running") {
                log(&dir, &id, json!({ "type": "step", "kind": s["kind"], "tool": s["tool"], "label": s["label"], "status": s["status"], "detail": s["detail"] }));
            }
            emit(app, &id, json!({ "type": "step", "step": s }));
        }
        "build_text" => {
            log(&dir, &id, json!({ "type": "text", "text": msg["text"] }));
            emit(app, &id, json!({ "type": "text", "text": msg["text"] }));
        }
        "build_usage" => emit(app, &id, json!({ "type": "usage", "input": msg["input"], "cacheRead": msg["cacheRead"], "cacheCreate": msg["cacheCreate"], "output": msg["output"] })),
        "build_done" => {
            let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let error = msg.get("error").and_then(Value::as_str).map(String::from);
            let next = {
                let Ok(mut g) = lock(&state) else { return };
                let Some(r) = g.get_mut(&id) else { return };
                log(&dir, &id, json!({ "type": "task_done", "task": r.tasks[r.current], "ok": ok, "error": error }));
                if ok && r.stop.is_none() && r.current + 1 < r.tasks.len() {
                    r.current += 1;
                    Some(r.current)
                } else {
                    None
                }
            };
            match next {
                Some(i) => {
                    emit(app, &id, json!({ "type": "task", "index": i }));
                    if let Err(e) = send_task(app, &state, &id) {
                        finish(app, &id, "failed", Some(e.to_string()));
                    }
                }
                None => {
                    let stopped = lock(&state).ok().and_then(|g| g.get(&id).and_then(|r| r.stop));
                    let result = if ok { "done" } else if stopped.is_some() || msg.get("cancelled").and_then(Value::as_bool) == Some(true) { "interrupted" } else { "failed" };
                    finish(app, &id, result, if ok { None } else { error });
                }
            }
        }
        _ => {}
    }
}

/// Ends a run: the summary is computed, written and sent; pending asks are dropped (denied).
fn finish(app: &AppHandle, id: &str, result: &str, error: Option<String>) {
    let state = app.state::<AppState>();
    let Some(r) = lock(&state).ok().and_then(|mut g| g.remove(id)) else { return };
    let commits = git::commits(&r.repo, &r.base_sha, &r.branch).unwrap_or_default();
    let files = git::files(&r.repo, &r.base_sha, &r.branch).unwrap_or_default();
    // STATUS.md as it is now: the entries of this run's cards, and which cards reported nothing.
    let parsed = fs::read_to_string(r.repo.join(crate::storage::build::STATUS_REL)).map(|t| crate::status::parse(&t)).unwrap_or_default();
    let (titles, sync) = match state.ws.lock() {
        Ok(ws) => {
            let titles: HashMap<String, String> = ws.load_project(&r.slug).map(|d| d.cards.into_iter().map(|c| (c.meta.id, c.meta.title)).collect()).unwrap_or_default();
            (titles, ws.sync_status(&r.slug).ok())
        }
        Err(_) => (HashMap::new(), None),
    };
    let status: Vec<Value> = parsed.entries.iter().filter(|e| e.id.as_ref().is_some_and(|i| r.cards.contains(i))).map(|e| json!({ "id": e.id, "title": e.title, "status": e.status, "notes": e.notes })).collect();
    let missing: Vec<Value> = r.cards.iter().filter(|c| !status.iter().any(|s| s["id"] == json!(c))).map(|c| json!({ "id": c, "title": titles.get(c).cloned().unwrap_or_else(|| c.clone()) })).collect();
    let summary = json!({
        "id": r.id, "slug": r.slug, "result": result, "error": error, "branch": r.branch, "base": r.base, "base_sha": r.base_sha,
        "tasks": r.tasks, "titles": r.titles, "cards": r.cards, "started_at": r.started_at, "ended_at": now(),
        "duration_ms": r.started.elapsed().as_millis() as u64, "stashed": r.stashed, "model": r.model,
        "commits": commits.iter().map(|(h, s)| json!({ "hash": h, "subject": s })).collect::<Vec<_>>(),
        "files": files, "status": status, "missing": missing, "outcome": null,
    });
    log(&r.dir, id, json!({ "type": "end", "result": result, "error": summary["error"] }));
    if let Err(e) = crate::storage::write_json(&r.dir.join("builds").join(format!("{id}.json")), &summary) {
        eprintln!("[dreamer] build run: could not write the summary: {e}");
    }
    if let Some(rep) = sync.filter(|s| s.changed()) {
        let _ = app.emit("build-update", rep);
    }
    emit(app, id, json!({ "type": "done", "summary": summary }));
}

/// The sidecar is gone: every run fails.
pub fn on_sidecar_gone(app: &AppHandle, why: &str) {
    let ids: Vec<String> = lock(&app.state::<AppState>()).map(|g| g.keys().cloned().collect()).unwrap_or_default();
    for id in ids {
        finish(app, &id, "failed", Some(why.to_string()));
    }
}

/// Interrupt: the sidecar stops the session and answers with build_done.
pub fn interrupt(state: &AppState, id: &str) -> Result<()> {
    {
        let mut g = lock(state)?;
        let r = g.get_mut(id).ok_or_else(|| AppError::NotFound(format!("run {id}")))?;
        r.stop = Some("interrupted");
        r.asks.clear(); // dropping the senders denies what is waiting
    }
    crate::sidecar::write_line(state, &json!({ "type": "build_cancel", "run": id }));
    Ok(())
}

pub fn answer(state: &AppState, id: &str, req: &str, decision: &str, reason: Option<String>) -> Result<()> {
    let tx = lock(state)?.get_mut(id).and_then(|r| r.asks.remove(req)).map(|(_, tx)| tx).ok_or_else(|| AppError::NotFound("that request".into()))?;
    let a = match decision {
        "once" => Answer::Once,
        "prefix" => Answer::Prefix,
        _ => Answer::Deny(reason.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).unwrap_or_else(|| "The user denied this.".into())),
    };
    let _ = tx.send(a);
    Ok(())
}

/// The sidecar's `build_permission` request. phase "hook" (every call, before any settings rule):
/// only the always-deny rules. phase "ask" (canUseTool): allow, deny, or ask the user and wait.
pub fn permission(app: &AppHandle, state: &AppState, input: &Value) -> Result<Value> {
    let id = input.get("run").and_then(Value::as_str).unwrap_or_default().to_string();
    let tool = input.get("tool").and_then(Value::as_str).unwrap_or_default().to_string();
    let tin = input.get("input").cloned().unwrap_or(Value::Null);
    let deny = |m: String| json!({ "behavior": "deny", "message": m });
    let (repo, prefixes, dir) = {
        let g = lock(state)?;
        let Some(r) = g.get(&id).filter(|r| r.stop.is_none()) else { return Ok(deny("The build run is over. Stop now.".into())) };
        (r.repo.clone(), r.prefixes.clone(), r.dir.clone())
    };
    let v = decide(&repo, &tool, &tin, &prefixes);
    if input.get("phase").and_then(Value::as_str) == Some("hook") {
        return Ok(match v {
            Verdict::Deny(m) => {
                log(&dir, &id, json!({ "type": "denied", "tool": tool, "reason": m }));
                emit(app, &id, json!({ "type": "denied", "tool": tool, "reason": m }));
                deny(m)
            }
            _ => json!({ "behavior": "pass" }),
        });
    }
    let why = match v {
        Verdict::Allow => return Ok(json!({ "behavior": "allow" })),
        Verdict::Deny(m) => return Ok(deny(m)),
        Verdict::Ask(why) => why,
    };
    let command = tin.get("command").and_then(Value::as_str).map(String::from);
    let detail = command.clone().or_else(|| ["file_path", "notebook_path", "path", "url", "query"].iter().find_map(|k| tin.get(*k).and_then(Value::as_str).map(String::from))).unwrap_or_default();
    let prefix = if tool == "Bash" { command.as_deref().and_then(|c| prefix_of(&repo, c)) } else { None };
    let req = ulid::Ulid::generate().to_string();
    let ask = json!({ "req": req, "tool": tool, "why": why, "detail": detail, "prefix": prefix, "description": tin.get("description") });
    let (tx, rx) = mpsc::channel();
    {
        let mut g = lock(state)?;
        let Some(r) = g.get_mut(&id) else { return Ok(deny("The build run is over. Stop now.".into())) };
        r.asks.insert(req.clone(), (ask.clone(), tx));
    }
    log(&dir, &id, json!({ "type": "ask", "tool": tool, "why": why }));
    emit(app, &id, json!({ "type": "ask", "ask": ask }));
    let got = rx.recv();
    let (out, decision) = match got {
        Ok(Answer::Once) => (json!({ "behavior": "allow" }), "allowed once"),
        Ok(Answer::Prefix) => {
            if let (Some(p), Ok(mut g)) = (prefix, lock(state)) {
                if let Some(r) = g.get_mut(&id) {
                    r.prefixes.push(p);
                }
            }
            (json!({ "behavior": "allow" }), "allowed for this run")
        }
        Ok(Answer::Deny(m)) => (deny(m), "denied"),
        Err(_) => (deny("The build run was stopped.".into()), "stopped"),
    };
    log(&dir, &id, json!({ "type": "answer", "tool": tool, "decision": decision }));
    emit(app, &id, json!({ "type": "ask_done", "req": req, "decision": decision }));
    Ok(out)
}

// ---------- past runs and their actions ----------

/// Past runs of the project (newest first), plus the live ones (`live: true`).
pub fn list(state: &AppState, slug: &str) -> Result<Vec<Value>> {
    let dir = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.existing_project_dir(slug)?;
    let mut out: Vec<Value> = lock(state)?.values().filter(|r| r.slug == slug).map(Run::info).collect();
    if let Ok(rd) = fs::read_dir(dir.join("builds")) {
        let mut past: Vec<Value> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension() == Some(OsStr::new("json")))
            .filter_map(|e| fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()))
            .collect();
        past.sort_by(|a: &Value, b: &Value| b["started_at"].as_str().cmp(&a["started_at"].as_str()));
        out.extend(past);
    }
    Ok(out)
}

/// The logged events of a run.
pub fn events(state: &AppState, slug: &str, id: &str) -> Result<Vec<Value>> {
    check_run_id(id)?;
    let dir = state.ws.lock().map_err(|_| AppError::Invalid("workspace lock poisoned".into()))?.existing_project_dir(slug)?;
    let text = fs::read_to_string(dir.join("builds").join(format!("{id}.jsonl"))).unwrap_or_default();
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

fn summary_of(state: &AppState, slug: &str, id: &str) -> Result<(PathBuf, PathBuf, Value)> {
    check_run_id(id)?;
    let (repo, dir) = repo_of(state, slug)?;
    let path = dir.join("builds").join(format!("{id}.json"));
    let s: Value = serde_json::from_str(&fs::read_to_string(&path).map_err(|e| AppError::io(format!("read {}", path.display()), e))?).map_err(|e| AppError::Invalid(e.to_string()))?;
    if lock(state)?.values().any(|r| r.repo == repo) {
        return Err(AppError::Invalid("A build run is going on in this repo. Wait for it first.".into()));
    }
    Ok((repo, path, s))
}

fn str_of<'a>(s: &'a Value, k: &str) -> &'a str {
    s.get(k).and_then(Value::as_str).unwrap_or_default()
}

pub fn file_diff(state: &AppState, slug: &str, id: &str, file: &str) -> Result<String> {
    let (repo, _, s) = summary_of(state, slug, id)?;
    if !s["files"].as_array().is_some_and(|f| f.iter().any(|x| x == file)) {
        return Err(AppError::Invalid(format!("{file:?} is not a file of this run")));
    }
    git::file_diff(&repo, str_of(&s, "base_sha"), str_of(&s, "branch"), file)
}

/// "merge" | "delete" | "keep": the run's branch is merged into its base (never pushed), deleted or kept.
pub fn act(state: &AppState, slug: &str, id: &str, action: &str) -> Result<Value> {
    let (repo, path, mut s) = summary_of(state, slug, id)?;
    let (branch, base) = (str_of(&s, "branch").to_string(), str_of(&s, "base").to_string());
    let outcome = match action {
        "merge" => format!("merged ({})", git::merge(&repo, &base, &branch)?),
        "delete" => {
            git::delete_branch(&repo, &branch, &base)?;
            "deleted".into()
        }
        "keep" => "kept".into(),
        other => return Err(AppError::Invalid(format!("unknown action {other:?}"))),
    };
    s["outcome"] = json!(outcome);
    atomic_write(&path, serde_json::to_string_pretty(&s).map_err(|e| AppError::Invalid(e.to_string()))?.as_bytes())?;
    Ok(s)
}

pub fn open_terminal(state: &AppState, slug: &str) -> Result<()> {
    let (repo, _) = repo_of(state, slug)?;
    crate::task::terminal_at(&crate::claude_setup::child_path(&repo), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::TempDir::new().unwrap();
        let p = d.path().join("repo");
        fs::create_dir_all(p.join("src")).unwrap();
        fs::write(p.join("src/a.ts"), "x").unwrap();
        let c = dunce::canonicalize(&p).unwrap();
        (d, c)
    }
    fn bash_v(repo: &Path, cmd: &str) -> Verdict {
        decide(repo, "Bash", &json!({ "command": cmd }), &[])
    }
    fn is_deny(v: Verdict) -> bool {
        matches!(v, Verdict::Deny(_))
    }
    fn is_ask(v: Verdict) -> bool {
        matches!(v, Verdict::Ask(_))
    }

    #[test]
    fn file_tools_inside_the_repo_are_allowed_outside_asked() {
        let (d, r) = repo();
        let outside = d.path().join("elsewhere.txt").display().to_string();
        for t in ["Edit", "Write", "MultiEdit"] {
            assert_eq!(decide(&r, t, &json!({ "file_path": r.join("src/a.ts").display().to_string() }), &[]), Verdict::Allow, "{t}");
            assert_eq!(decide(&r, t, &json!({ "file_path": "src/new/file.ts" }), &[]), Verdict::Allow, "{t}: a new file in a new folder");
            assert!(is_ask(decide(&r, t, &json!({ "file_path": outside }), &[])), "{t}");
            assert!(is_ask(decide(&r, t, &json!({ "file_path": "src/../../x.ts" }), &[])), "{t}: climbing out");
            assert!(is_ask(decide(&r, t, &json!({ "file_path": "nope/../../x.ts" }), &[])), "{t}: climbing out through a missing folder");
        }
        assert_eq!(decide(&r, "NotebookEdit", &json!({ "notebook_path": "n.ipynb" }), &[]), Verdict::Allow);
        assert_eq!(decide(&r, "Read", &json!({ "file_path": "src/a.ts" }), &[]), Verdict::Allow);
        assert!(is_ask(decide(&r, "Read", &json!({ "file_path": outside }), &[])));
        assert_eq!(decide(&r, "Grep", &json!({ "pattern": "x" }), &[]), Verdict::Allow);
        assert_eq!(decide(&r, "Glob", &json!({ "pattern": "**/*.ts" }), &[]), Verdict::Allow);
        assert!(is_ask(decide(&r, "Glob", &json!({ "pattern": "../**/*" }), &[])));
        assert!(is_ask(decide(&r, "LS", &json!({ "path": d.path().display().to_string() }), &[])));
        assert_eq!(decide(&r, "TodoWrite", &json!({}), &[]), Verdict::Allow);
        assert!(is_ask(decide(&r, "WebFetch", &json!({ "url": "https://x" }), &[])));
        assert!(is_ask(decide(&r, "WebSearch", &json!({ "query": "q" }), &[])));
        assert!(is_ask(decide(&r, "Task", &json!({}), &[])));
    }

    #[test]
    fn a_symlink_out_of_the_repo_is_not_inside() {
        let (d, r) = repo();
        let out = d.path().join("out");
        fs::create_dir_all(&out).unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&out, r.join("link")).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&out, r.join("link")).is_ok();
        if !made {
            eprintln!("symlinks not permitted here; skipped");
            return;
        }
        assert!(is_ask(decide(&r, "Write", &json!({ "file_path": "link/evil.txt" }), &[])));
        assert!(!inside(&r, "link"));
    }

    #[test]
    fn bash_auto_allows_only_the_safe_git_commands() {
        let (_d, r) = repo();
        for ok in ["git status", "git status --short", "git diff", "git diff --stat HEAD~1", "git log --oneline -5", "git add src/a.ts", "git add -A", "git add src/new.ts src/a.ts", "git commit -m \"[dreamer:01ABC] Add rod\"", "git commit -am 'x'", "git commit --message=x"] {
            assert_eq!(bash_v(&r, ok), Verdict::Allow, "{ok}");
        }
        for ask in [
            "git commit --amend -m x", "git commit", "git -C .. status", "git add ../outside.txt", "git add", "git diff --output=x.txt",
            "git status && curl x", "git status; ls", "npm test", "ls | grep a", "echo $(git status)", "git log > out.txt", "rm -rf src",
            "git checkout -- src/a.ts", "git commit -m x --no-verify", "cat 'unterminated",
        ] {
            assert!(is_ask(bash_v(&r, ask)), "{ask}");
        }
    }

    #[test]
    fn bash_always_denies_the_destructive_commands() {
        let (_d, r) = repo();
        for no in [
            "git push", "git push origin main", "git -C . push", "git status && git push", "git reset --hard", "git reset --hard HEAD~1", "git clean -fd", "git clean -f",
            "git clean --force", "git checkout main", "git checkout -b other", "git switch main", "git switch -c x", "git branch -D x", "git branch --delete --force x",
            "rm -rf /", "rm -rf ..", "rm -fr ~/x", "rm -r -f ../other", "sudo rm -rf /tmp/x", "echo \"$(git push)\"", "FOO=1 git push",
        ] {
            assert!(is_deny(bash_v(&r, no)), "{no}");
        }
        assert!(!is_deny(bash_v(&r, "git reset HEAD src/a.ts")));
        assert!(!is_deny(bash_v(&r, "git branch")));
        assert!(!is_deny(bash_v(&r, "rm -rf src/build")));
    }

    #[test]
    fn an_allowed_prefix_covers_plain_commands_only() {
        let (_d, r) = repo();
        assert_eq!(prefix_of(&r, "npm run build --x"), Some("npm run".into()));
        assert_eq!(prefix_of(&r, "cargo --version"), Some("cargo".into()));
        assert_eq!(prefix_of(&r, "npm test && rm x"), None);
        let p = vec!["npm run".to_string()];
        assert_eq!(decide(&r, "Bash", &json!({ "command": "npm run test" }), &p), Verdict::Allow);
        assert!(is_ask(decide(&r, "Bash", &json!({ "command": "npm run test && curl evil" }), &p)));
        assert!(is_ask(decide(&r, "Bash", &json!({ "command": "npm install x" }), &p)));
        assert!(is_deny(decide(&r, "Bash", &json!({ "command": "git push" }), &["git".into()])), "a prefix never beats a deny");
        // A leading `cd` into the repo is dropped; one out of it is not.
        let cd = format!("cd \"{}\" && git status", r.display());
        assert_eq!(bash_v(&r, &cd), Verdict::Allow);
        assert_eq!(prefix_of(&r, &format!("cd \"{}\" && npm run x", r.display())), Some("npm run".into()));
        assert!(is_ask(bash_v(&r, "cd .. && git status")));
        assert!(is_deny(bash_v(&r, &format!("cd \"{}\" && git push", r.display()))));
    }

    // ---- git helpers on a temp repo ----

    fn g(repo: &Path, args: &[&str]) -> String {
        git::run(repo, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }
    fn git_repo() -> Option<(tempfile::TempDir, PathBuf)> {
        let d = tempfile::TempDir::new().unwrap();
        let r = dunce::canonicalize(d.path()).unwrap();
        git::run(&r, &["init", "-q", "-b", "main"]).ok()?;
        g(&r, &["config", "user.email", "t@example.com"]);
        g(&r, &["config", "user.name", "T"]);
        g(&r, &["config", "commit.gpgsign", "false"]);
        fs::write(r.join("a.txt"), "one\n").unwrap();
        g(&r, &["add", "a.txt"]);
        g(&r, &["commit", "-q", "-m", "init"]);
        Some((d, r))
    }

    #[test]
    fn git_branch_commits_files_diff_and_fast_forward_merge() {
        let Some((_d, r)) = git_repo() else {
            eprintln!("git not available; skipped");
            return;
        };
        assert!(git::is_repo(&r));
        assert!(!git::dirty(&r).unwrap());
        let base_sha = git::head(&r).unwrap();
        let name = git::branch_name("20261125", "Harpoon rod: v2!");
        assert_eq!(name, "dreamer/20261125-harpoon-rod-v2");
        assert_eq!(git::create_branch(&r, &name).unwrap(), name);
        assert_eq!(git::branch(&r).unwrap(), name);
        fs::write(r.join("a.txt"), "two\n").unwrap();
        fs::write(r.join("b.txt"), "new\n").unwrap();
        assert!(git::dirty(&r).unwrap());
        g(&r, &["add", "-A"]);
        g(&r, &["commit", "-q", "-m", "[dreamer:X] change"]);
        let c = git::commits(&r, &base_sha, &name).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].1, "[dreamer:X] change");
        assert_eq!(git::files(&r, &base_sha, &name).unwrap(), vec!["a.txt", "b.txt"]);
        let d = git::file_diff(&r, &base_sha, &name, "a.txt").unwrap();
        assert!(d.contains("-one") && d.contains("+two"), "{d}");
        assert_eq!(git::merge(&r, "main", &name).unwrap(), "fast-forward");
        assert_eq!(git::branch(&r).unwrap(), "main");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap().trim(), "two");
        // The same name again gets a suffix.
        assert_eq!(git::create_branch(&r, &name).unwrap(), format!("{name}-2"));
        git::delete_branch(&r, &format!("{name}-2"), "main").unwrap();
        assert_eq!(git::branch(&r).unwrap(), "main");
        assert!(git::run(&r, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}-2")]).is_err());
    }

    #[test]
    fn git_merge_commit_when_the_base_moved_and_stash_of_a_dirty_tree() {
        let Some((_d, r)) = git_repo() else {
            eprintln!("git not available; skipped");
            return;
        };
        let base_sha = git::head(&r).unwrap();
        let b = git::create_branch(&r, "dreamer/20261125-x").unwrap();
        fs::write(r.join("b.txt"), "b\n").unwrap();
        g(&r, &["add", "b.txt"]);
        g(&r, &["commit", "-q", "-m", "b"]);
        g(&r, &["switch", "-q", "main"]);
        fs::write(r.join("c.txt"), "c\n").unwrap();
        g(&r, &["add", "c.txt"]);
        g(&r, &["commit", "-q", "-m", "c"]);
        g(&r, &["switch", "-q", &b]);
        assert_eq!(git::merge(&r, "main", &b).unwrap(), "merge commit");
        assert!(r.join("b.txt").is_file() && r.join("c.txt").is_file());
        assert_eq!(git::commits(&r, &base_sha, "main").unwrap().len(), 3, "b, c and the merge");
        fs::write(r.join("a.txt"), "dirty\n").unwrap();
        fs::write(r.join("untracked.txt"), "u\n").unwrap();
        assert!(git::dirty(&r).unwrap());
        git::stash(&r).unwrap();
        assert!(!git::dirty(&r).unwrap());
        assert!(git::branch(&r).is_ok());
        g(&r, &["checkout", "-q", "--detach"]);
        assert!(git::branch(&r).is_err(), "a detached HEAD has no branch");
    }
}

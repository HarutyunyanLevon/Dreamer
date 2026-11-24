//! `%LOCALAPPDATA%\Dreamer\logs\sidecar.log`: what happened between the app and the Claude sidecar,
//! so a chat turn that went wrong can be diagnosed after the fact. It records spawns and exits, the
//! sidecar's stderr, and every protocol line in both directions as type + id only. No message
//! text, card content or tool input is ever logged; error events are kept in full. Rotates at
//! 2 MB, keeping sidecar.log, sidecar.1.log and sidecar.2.log.

use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Files kept in total, the live one included.
const KEEP: usize = 3;

struct Sink {
    dir: PathBuf,
    file: Option<File>,
    size: u64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

/// `%LOCALAPPDATA%\Dreamer\logs` (Windows), or the platform's local data dir elsewhere.
pub fn dir() -> PathBuf {
    // The reliability harness logs into its own run folder, never the app's.
    if let Some(d) = std::env::var_os("DREAMER_LOG_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_STATE_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Dreamer").join("logs")
}

fn path(dir: &std::path::Path, n: usize) -> PathBuf {
    if n == 0 { dir.join("sidecar.log") } else { dir.join(format!("sidecar.{n}.log")) }
}

fn open(sink: &mut Sink) {
    let _ = std::fs::create_dir_all(&sink.dir);
    let p = path(&sink.dir, 0);
    sink.size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    sink.file = OpenOptions::new().create(true).append(true).open(&p).ok();
}

fn rotate(sink: &mut Sink) {
    sink.file = None;
    let _ = std::fs::remove_file(path(&sink.dir, KEEP - 1));
    for n in (0..KEEP - 1).rev() {
        let _ = std::fs::rename(path(&sink.dir, n), path(&sink.dir, n + 1));
    }
    open(sink);
}

/// Appends one line (prefixed with a UTC timestamp). Never fails the caller.
pub fn line(text: &str) {
    let Ok(mut guard) = SINK.lock() else { return };
    let sink = guard.get_or_insert_with(|| {
        let mut s = Sink { dir: dir(), file: None, size: 0 };
        open(&mut s);
        s
    });
    if sink.size >= MAX_BYTES {
        rotate(sink);
    }
    let entry = format!("{} {}\n", crate::storage::now(), text.trim_end());
    if let Some(f) = sink.file.as_mut() {
        if f.write_all(entry.as_bytes()).is_ok() {
            sink.size += entry.len() as u64;
        }
    }
}

/// "type id" of a protocol message: the turn id, tool request id or job id, whichever it has.
/// Error events go in full (they carry no user content, and they are what a diagnosis needs).
pub fn summary(msg: &Value) -> String {
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("?");
    if kind == "error" {
        return msg.to_string();
    }
    let id = ["id", "reqId", "job", "turnId"].iter().find_map(|k| msg.get(*k).and_then(Value::as_str)).unwrap_or("");
    let mut out = format!("{kind} {id}");
    // Which tool, and whether it failed: names and flags only, never inputs or results.
    if let Some(tool) = msg.get("tool").and_then(Value::as_str) {
        out.push_str(&format!(" tool={tool}"));
    }
    if kind == "tool_response" && msg.get("error").is_some() {
        out.push_str(" (error)");
    }
    for flag in ["isError", "ok", "cancelled"] {
        if let Some(b) = msg.get(flag).and_then(Value::as_bool) {
            out.push_str(&format!(" {flag}={b}"));
        }
    }
    if kind == "user_message" {
        out.push_str(&format!(" resume={}", msg.get("resume").is_some_and(|r| !r.is_null())));
    }
    if kind == "oneshot_done" {
        if let Some(e) = msg.get("error").and_then(Value::as_str) {
            out.push_str(&format!(" error={e:?}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summaries_never_carry_message_text() {
        let s = summary(&json!({ "type": "user_message", "id": "c1", "text": "secret idea", "fullText": "secret idea", "resume": "abc" }));
        assert_eq!(s, "user_message c1 resume=true");
        let s = summary(&json!({ "type": "delta", "id": "c1", "text": "secret" }));
        assert_eq!(s, "delta c1");
        let s = summary(&json!({ "type": "tool_request", "reqId": "r3", "tool": "read_card", "input": { "id": "x" } }));
        assert_eq!(s, "tool_request r3 tool=read_card");
        let s = summary(&json!({ "type": "error", "id": "c1", "message": "boom" }));
        assert!(s.contains("boom"), "errors are kept in full");
    }

    #[test]
    fn rotation_keeps_three_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mut sink = Sink { dir: tmp.path().to_path_buf(), file: None, size: 0 };
        open(&mut sink);
        for i in 0..5 {
            sink.file.as_mut().unwrap().write_all(format!("gen {i}\n").as_bytes()).unwrap();
            rotate(&mut sink);
        }
        let mut names: Vec<String> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["sidecar.1.log", "sidecar.2.log", "sidecar.log"]);
        assert_eq!(std::fs::read_to_string(tmp.path().join("sidecar.1.log")).unwrap(), "gen 4\n");
    }
}

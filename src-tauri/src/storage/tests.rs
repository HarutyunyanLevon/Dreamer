use super::*;
use serde_json::json;
use tempfile::TempDir;

/// The project a fresh workspace starts with.
const P: &str = "ideas";

fn ws() -> (TempDir, Workspace) {
    let dir = TempDir::new().unwrap();
    let ws = Workspace::open(dir.path().join("Dreamer")).unwrap();
    (dir, ws)
}

fn new_card(title: &str) -> NewCard {
    NewCard { title: Some(title.into()), ..Default::default() }
}

#[test]
fn open_creates_layout_and_a_first_project() {
    let (_d, ws) = ws();
    assert!(ws.root.join("workspace.json").is_file());
    assert!(!ws.root.join("inbox").exists());
    let dir = ws.root.join("projects").join(P);
    for sub in ["cards", "media", "trash"] {
        assert!(dir.join(sub).is_dir(), "{sub}");
    }
    assert!(dir.join("project.json").is_file() && dir.join("canvas.json").is_file());
    assert_eq!(ws.get_settings().unwrap().extra.get("layout"), Some(&json!(2)), "a new workspace needs no migration");
    let projects = ws.list_projects().unwrap();
    assert_eq!(projects.len(), 1);
    // reopening keeps existing data
    ws.create_card(P, new_card("keep me")).unwrap();
    let again = Workspace::open(&ws.root).unwrap();
    assert_eq!(again.list_projects().unwrap().len(), 1);
    assert_eq!(again.list_projects().unwrap()[0].card_count, 1);
}

#[test]
fn panel_visibility_persists_and_defaults_to_shown() {
    let (_d, ws) = ws();
    // An older workspace.json without the keys shows both panels and keeps unknown keys.
    fs::write(ws.root.join("workspace.json"), r#"{"version":1,"theme":"pearl-glow","hotkey":"Ctrl+Shift+Space","mine":7}"#).unwrap();
    let s = ws.get_settings().unwrap();
    assert!(s.show_projects && s.show_chat);
    let s = ws.update_settings(SettingsPatch { show_projects: Some(false), ..Default::default() }).unwrap();
    assert!(!s.show_projects && s.show_chat);
    ws.update_settings(SettingsPatch { show_chat: Some(false), ..Default::default() }).unwrap();
    let s = ws.get_settings().unwrap();
    assert!(!s.show_projects && !s.show_chat);
    assert_eq!(s.extra.get("mine"), Some(&serde_json::json!(7)), "unknown keys survive");
    let raw: serde_json::Value = serde_json::from_str(&fs::read_to_string(ws.root.join("workspace.json")).unwrap()).unwrap();
    assert_eq!((raw["show_projects"].clone(), raw["show_chat"].clone()), (serde_json::json!(false), serde_json::json!(false)));
    ws.update_settings(SettingsPatch { show_projects: Some(true), show_chat: Some(true), ..Default::default() }).unwrap();
    assert!(ws.get_settings().unwrap().show_projects && ws.get_settings().unwrap().show_chat);
}

#[test]
fn settings_roundtrip_and_corrupt_file_is_backed_up() {
    let (_d, ws) = ws();
    let s = ws.update_settings(SettingsPatch { theme: Some("gold-sky".into()), last_project: Some("fish".into()), ..Default::default() }).unwrap();
    assert_eq!(s.theme, "gold-sky");
    assert_eq!(ws.get_settings().unwrap().last_project.as_deref(), Some("fish"));
    ws.update_settings(SettingsPatch { last_project: Some(String::new()), ..Default::default() }).unwrap();
    assert_eq!(ws.get_settings().unwrap().last_project, None);
    assert!(ws.update_settings(SettingsPatch { theme: Some("  ".into()), ..Default::default() }).is_err());

    fs::write(ws.root.join("workspace.json"), "{ not json").unwrap();
    let s = ws.get_settings().unwrap();
    assert_eq!(s.theme, "pearl-glow");
    assert!(ws.root.join("workspace.json.bak").is_file());
}

#[test]
fn projects_get_unique_slugs() {
    let (_d, ws) = ws();
    let a = ws.create_project("Fish-punk fishing!").unwrap();
    // The same name twice is refused (item 8); a different name with the same slug gets -2.
    assert!(ws.create_project("Fish-punk fishing!").is_err());
    let b = ws.create_project("Fish punk, fishing").unwrap();
    // "Inbox" is an ordinary name now.
    let i = ws.create_project("Inbox").unwrap();
    assert_eq!(a.slug, "fish-punk-fishing");
    assert_eq!(b.slug, "fish-punk-fishing-2");
    assert_eq!(i.slug, "inbox");
    assert!(ws.create_project("   ").is_err());
    assert_eq!(ws.list_projects().unwrap().len(), 4);
    let u = ws.update_project(&a.slug, ProjectPatch { name: Some("Renamed".into()), theme: Some("iridescent".into()), ..Default::default() }).unwrap();
    assert_eq!((u.name.as_str(), u.theme.as_deref()), ("Renamed", Some("iridescent")));
    let u = ws.update_project(&a.slug, ProjectPatch { theme: Some(String::new()), ..Default::default() }).unwrap();
    assert_eq!(u.theme, None);
}

#[test]
fn slugs_and_ids_cannot_escape_the_workspace() {
    let (_d, ws) = ws();
    for bad in ["..", "../x", "a/b", "a\\b", "", "Up", ".hidden", "x y"] {
        assert!(ws.load_project(bad).is_err(), "{bad:?}");
    }
    for bad in ["../x", "a/b", "", "a.b", "a b"] {
        assert!(ws.read_card(P, bad).is_err(), "{bad:?}");
    }
    assert!(matches!(ws.load_project("nope"), Err(AppError::NotFound(_))));
}

#[test]
fn card_file_roundtrip_matches_the_documented_format() {
    let (_d, ws) = ws();
    let c = ws
        .create_card(
            P,
            NewCard {
                title: Some("Harpoon rod".into()),
                body: Some("# Notes\n\nTwo moods.\n\n---\n\nA rule above.".into()),
                stage: Some(Stage::Lucid),
                tags: Some(vec!["weapon".into(), "core".into()]),
                links: Some(vec![Link { to: "01OTHER".into(), label: Some("feeds".into()) }, Link { to: "01X".into(), label: None }]),
                source: Some(Source::Claude),
                ghost: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    let text = fs::read_to_string(ws.root.join(format!("projects/ideas/cards/{}.md", c.meta.id))).unwrap();
    assert!(text.starts_with("---\nid: "), "{text}");
    assert!(text.contains("stage: lucid"));
    assert!(text.contains("source: claude"));
    assert!(text.contains("ghost: true"));
    assert!(text.contains("- to: 01OTHER\n  label: feeds"));
    assert!(!text.contains("branch"), "branch omitted when unset");
    assert!(!text.contains('\r'));
    let back = ws.read_card(P, &c.meta.id).unwrap();
    assert_eq!(back, c);
    assert!(back.body.contains("A rule above."), "a --- rule in the body must not end the frontmatter");
    assert_eq!(c.meta.id.len(), 26, "ULID");
}

#[test]
fn parser_is_tolerant_of_crlf_bom_missing_fields_and_unknown_keys() {
    let crlf = "\u{feff}---\r\nid: WRONG\r\ntitle: From Windows\r\nstage: Reverie\r\nnotes: keep me\r\n---\r\n\r\nBody line\r\n";
    let c = parse_card(crlf, "01ABC").unwrap();
    assert_eq!(c.meta.id, "01ABC", "file name is the id authority");
    assert_eq!(c.meta.title, "From Windows");
    assert_eq!(c.meta.stage, Stage::Reverie);
    assert_eq!(c.body, "Body line");
    assert_eq!(c.meta.extra.get("notes").and_then(|v| v.as_str()), Some("keep me"));
    assert!(serialize_card(&c).unwrap().contains("notes: keep me"), "unknown keys survive a rewrite");

    let plain = parse_card("# Just a note\n\nhello", "01Z").unwrap();
    assert_eq!(plain.meta.title, "Just a note");
    assert_eq!(plain.meta.stage, Stage::Mist);
    assert_eq!(parse_card("", "01E").unwrap().meta.title, "Untitled");

    let weird = parse_card("---\nstage: banana\n---\nx", "01W").unwrap();
    assert_eq!(weird.meta.stage, Stage::Mist);
    let empty_fm = parse_card("---\n---\nbody", "01F").unwrap();
    assert_eq!(empty_fm.body, "body");
    let no_body = parse_card("---\ntitle: T\n---", "01G").unwrap();
    assert_eq!((no_body.meta.title.as_str(), no_body.body.as_str()), ("T", ""));
    assert!(parse_card("---\ntitle: [unclosed\n---\nx", "01B").is_err());
}

#[test]
fn update_card_patches_and_preserves_the_rest() {
    let (_d, ws) = ws();
    let c = ws.create_card(P, NewCard { title: Some("A".into()), body: Some("body".into()), tags: Some(vec!["t".into()]), ..Default::default() }).unwrap();
    let u = ws.update_card(P, &c.meta.id, CardPatch { stage: Some(Stage::Dream), title: Some("  B ".into()), ..Default::default() }).unwrap();
    assert_eq!(u.meta.title, "B");
    assert_eq!(u.meta.stage, Stage::Dream);
    assert_eq!(u.body, "body");
    assert_eq!(u.meta.tags, vec!["t"]);
    assert_eq!(u.meta.created, c.meta.created);
    assert!(u.meta.updated >= c.meta.updated);
    assert!(matches!(ws.update_card(P, "01MISSING", CardPatch::default()), Err(AppError::NotFound(_))));
}

#[test]
fn new_cards_are_placed_without_overlap_and_explicit_positions_are_kept() {
    let (_d, ws) = ws();
    let a = ws.create_card(P, new_card("a")).unwrap();
    let b = ws.create_card(P, new_card("b")).unwrap();
    let c = ws.create_card(P, NewCard { x: Some(900.0), y: Some(-40.0), ..new_card("c") }).unwrap();
    let data = ws.load_project(P).unwrap();
    let pa = data.canvas.cards[&a.meta.id];
    let pb = data.canvas.cards[&b.meta.id];
    assert_ne!(pa, pb);
    assert_eq!((data.canvas.cards[&c.meta.id].x, data.canvas.cards[&c.meta.id].y), (900.0, -40.0));
    assert_eq!(data.cards.len(), 3);
}

#[test]
fn externally_added_and_removed_cards_are_reconciled_on_load() {
    let (_d, ws) = ws();
    let a = ws.create_card(P, new_card("a")).unwrap();
    // a card dropped in by Claude Code / git, and a corrupt one
    fs::write(ws.root.join("projects/ideas/cards/01EXTERNAL.md"), "---\ntitle: External\nstage: reverie\n---\nhi\n").unwrap();
    fs::write(ws.root.join("projects/ideas/cards/01BROKEN.md"), "---\ntitle: [oops\n---\n").unwrap();
    fs::write(ws.root.join("projects/ideas/cards/notes.txt"), "ignored").unwrap();
    let data = ws.load_project(P).unwrap();
    assert_eq!(data.cards.len(), 2);
    assert!(data.canvas.cards.contains_key("01EXTERNAL"));
    assert_eq!(data.warnings.len(), 1);
    assert!(data.warnings[0].contains("01BROKEN"));
    // removed outside the app: position dropped
    fs::remove_file(ws.root.join(format!("projects/ideas/cards/{}.md", a.meta.id))).unwrap();
    let data = ws.load_project(P).unwrap();
    assert!(!data.canvas.cards.contains_key(&a.meta.id));
    // positions were persisted
    let on_disk: Canvas = serde_json::from_str(&fs::read_to_string(ws.root.join("projects/ideas/canvas.json")).unwrap()).unwrap();
    assert!(on_disk.cards.contains_key("01EXTERNAL"));
}

#[test]
fn delete_goes_to_trash_and_restore_returns_card_to_old_position() {
    let (_d, ws) = ws();
    let c = ws.create_card(P, NewCard { x: Some(123.0), y: Some(456.0), ..new_card("doomed") }).unwrap();
    let id = c.meta.id.clone();
    let item = ws.delete_card(P, &id).unwrap();
    assert_eq!(item.reason, "deleted");
    assert!(!ws.root.join(format!("projects/ideas/cards/{id}.md")).exists());
    assert!(ws.root.join(format!("projects/ideas/trash/{id}.md")).is_file());
    let data = ws.load_project(P).unwrap();
    assert!(data.cards.is_empty() && data.canvas.cards.is_empty());
    let trash = ws.list_trash(P).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].title, "doomed");

    let back = ws.restore_card(P, &id).unwrap();
    assert_eq!(back.meta.title, "doomed");
    let data = ws.load_project(P).unwrap();
    assert_eq!((data.canvas.cards[&id].x, data.canvas.cards[&id].y), (123.0, 456.0));
    assert!(ws.list_trash(P).unwrap().is_empty());
    assert!(ws.restore_card(P, &id).is_err());
    assert!(matches!(ws.delete_card(P, "01NOPE"), Err(AppError::NotFound(_))));
}

// ----- fix pass #3, item 8: create/delete reliability -----

#[test]
fn create_project_refuses_a_second_project_with_the_same_name() {
    let (_d, ws) = ws();
    let a = ws.create_project("Twice").unwrap();
    assert_eq!(a.slug, "twice");
    for again in ["Twice", "  twice ", "TWICE"] {
        let e = ws.create_project(again).unwrap_err().to_string();
        assert!(e.contains("already exists") && e.contains("Twice"), "{again:?}: {e}");
    }
    assert!(ws.create_project("Ideas").unwrap_err().to_string().contains("already exists"));
    // Only one folder was made; a different name that slugifies the same still works.
    assert_eq!(ws.list_projects().unwrap().iter().filter(|p| p.name == "Twice").count(), 1);
    assert_eq!(ws.create_project("Twice!").unwrap().slug, "twice-2");
}

#[test]
fn concurrent_creates_with_one_name_make_one_project() {
    // The command layer serialises calls on one Mutex<Workspace>; model that with 8 threads
    // firing the same create at once (a double-submitted form, Enter + blur).
    let (_d, ws) = ws();
    let shared = std::sync::Arc::new(std::sync::Mutex::new(ws));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let s = shared.clone();
            std::thread::spawn(move || s.lock().unwrap().create_project("Race").is_ok())
        })
        .collect();
    let oks = handles.into_iter().map(|h| h.join().unwrap()).filter(|ok| *ok).count();
    assert_eq!(oks, 1);
    let ws = shared.lock().unwrap();
    assert_eq!(fs::read_dir(ws.root.join("projects")).unwrap().count(), 2, "ideas + race");
}

fn project_with_files(ws: &Workspace, name: &str) -> (String, PathBuf) {
    let p = ws.create_project(name).unwrap();
    for i in 0..5 {
        ws.create_card(&p.slug, new_card(&format!("card {i}"))).unwrap();
    }
    let dir = ws.project_dir(&p.slug).unwrap();
    (p.slug, dir)
}

fn no_leftovers(ws: &Workspace) -> bool {
    fs::read_dir(ws.root.join("projects")).unwrap().filter_map(|e| e.ok()).all(|e| !e.file_name().to_string_lossy().contains(".deleting-"))
}

#[test]
fn delete_project_works_while_the_watcher_is_active() {
    let (_d, ws) = ws();
    let root = ws.root.canonicalize().unwrap();
    let ws = Workspace::open(&root).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let _w = crate::watcher::start(root.clone(), move |e| {
        let _ = tx.send(e);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    for round in 0..3 {
        let (slug, dir) = project_with_files(&ws, &format!("Watched {round}"));
        // Keep the watcher busy with a burst of writes right before the delete.
        ws.create_card(&slug, new_card("last")).unwrap();
        let out = ws.delete_project(&slug, false).unwrap();
        assert!(!out.recycled && !dir.exists(), "round {round}");
    }
    assert!(no_leftovers(&ws));
    // The watcher kept running and reported the changes.
    assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
}

#[test]
fn delete_project_clears_read_only_files() {
    let (_d, ws) = ws();
    let (slug, dir) = project_with_files(&ws, "Readonly");
    let f = dir.join("media").join("locked.bin");
    fs::write(&f, b"x").unwrap();
    let mut p = fs::metadata(&f).unwrap().permissions();
    p.set_readonly(true);
    fs::set_permissions(&f, p).unwrap();
    ws.delete_project(&slug, false).unwrap();
    assert!(!dir.exists() && no_leftovers(&ws));
}

/// Opens a file inside a project with no sharing at all, like a program that locks it.
#[cfg(windows)]
fn lock_file(path: &Path) -> fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new().read(true).write(true).share_mode(0).open(path).unwrap()
}

#[cfg(windows)]
#[test]
fn delete_project_retries_until_a_brief_lock_is_released() {
    let (_d, ws) = ws();
    let (slug, dir) = project_with_files(&ws, "Briefly locked");
    let lock = lock_file(&dir.join("canvas.json"));
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        drop(lock);
    });
    let started = std::time::Instant::now();
    ws.delete_project(&slug, false).unwrap();
    releaser.join().unwrap();
    assert!(!dir.exists() && no_leftovers(&ws));
    assert!(started.elapsed() >= Duration::from_millis(250), "it really had to wait for the lock");
}

#[cfg(windows)]
#[test]
fn delete_project_leaves_a_locked_project_whole_and_says_why() {
    let (_d, ws) = ws();
    let (slug, dir) = project_with_files(&ws, "Held open");
    let before: Vec<_> = fs::read_dir(dir.join("cards")).unwrap().map(|e| e.unwrap().file_name()).collect();
    let _lock = lock_file(&dir.join("canvas.json"));
    let e = ws.delete_project(&slug, false).unwrap_err().to_string();
    assert!(e.contains("in use") && e.contains("Nothing was deleted"), "{e}");
    // Not a single file is gone: no half-deleted project.
    let after: Vec<_> = fs::read_dir(dir.join("cards")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(before, after);
    assert!(dir.join("project.json").exists() && dir.join("canvas.json").exists());
    assert!(no_leftovers(&ws));
    assert!(ws.list_projects().unwrap().iter().any(|p| p.slug == slug));
}

#[test]
fn retry_io_gives_up_on_permanent_errors_at_once() {
    let mut calls = 0;
    let r: std::io::Result<()> = retry_io(|| {
        calls += 1;
        Err(std::io::Error::new(std::io::ErrorKind::NotFound, "gone"))
    });
    assert!(r.is_err() && calls == 1);
    let mut calls = 0;
    let r = retry_io(|| {
        calls += 1;
        if calls < 3 { Err(std::io::Error::from_raw_os_error(32)) } else { Ok(calls) }
    });
    assert_eq!(r.unwrap(), 3);
}

#[test]
fn delete_project_removes_folder_keeps_the_last_project_and_clears_last_project() {
    let (_d, ws) = ws();
    let p = ws.create_project("Doomed").unwrap();
    ws.create_card(&p.slug, new_card("x")).unwrap();
    ws.save_chat(&p.slug, "project", &serde_json::json!({"messages": []})).unwrap();
    ws.update_settings(SettingsPatch { last_project: Some(p.slug.clone()), ..Default::default() }).unwrap();
    assert!(matches!(ws.delete_project("nope", false), Err(AppError::NotFound(_))));
    assert!(ws.delete_project("../inbox", false).is_err());
    let out = ws.delete_project(&p.slug, false).unwrap();
    assert!(!out.recycled);
    assert!(!ws.root.join("projects").join(&p.slug).exists());
    assert_eq!(ws.get_settings().unwrap().last_project, None);
    assert!(ws.list_projects().unwrap().iter().all(|s| s.slug != p.slug));
    assert!(ws.root.join("projects/ideas").is_dir(), "others untouched");
    assert!(matches!(ws.delete_project(P, false), Err(AppError::Invalid(_))), "the last project stays");
}

/// Moves a throwaway project to the real Recycle Bin: `cargo test -- --ignored recycle`.
#[test]
#[ignore]
fn delete_project_recycles_live() {
    let (_d, ws) = ws();
    let p = ws.create_project("dreamer-recycle-test").unwrap();
    let out = ws.delete_project(&p.slug, true).unwrap();
    println!("recycled={} path={}", out.recycled, out.path);
    assert!(out.recycled);
    assert!(!ws.root.join("projects").join(&p.slug).exists());
}

#[test]
fn chat_threads_are_per_card_files_and_reset_clears_one() {
    let (_d, ws) = ws();
    let a = ws.create_card(P, new_card("a")).unwrap();
    let empty = ws.load_chat(P, &a.meta.id).unwrap();
    assert_eq!(empty["messages"], serde_json::json!([]));
    let t1 = serde_json::json!({"version": 1, "sessionId": "s1", "messages": [{"id": "m1", "role": "user", "text": "hi"}]});
    ws.save_chat(P, &a.meta.id, &t1).unwrap();
    ws.save_chat(P, "project", &serde_json::json!({"messages": [1]})).unwrap();
    assert!(ws.root.join(format!("projects/ideas/chats/{}.json", a.meta.id)).is_file());
    assert_eq!(ws.load_chat(P, &a.meta.id).unwrap(), t1);
    ws.reset_chat(P, &a.meta.id).unwrap();
    assert_eq!(ws.load_chat(P, &a.meta.id).unwrap()["messages"], serde_json::json!([]));
    assert_eq!(ws.load_chat(P, "project").unwrap()["messages"], serde_json::json!([1]), "other threads untouched");
    ws.reset_chat(P, &a.meta.id).unwrap(); // idempotent
    assert!(ws.load_chat(P, "../workspace").is_err());
    assert!(ws.save_chat(P, "a/b", &serde_json::json!({})).is_err());
    // Rust-owned fields (context snapshot, usage, summary) survive UI saves; reset clears them.
    ws.update_chat(P, &a.meta.id, |f| {
        f.insert("ctx".into(), serde_json::json!({"memoryHash": "h", "cards": {}}));
        f.insert("last_input_tokens".into(), serde_json::json!(123));
        f.insert("summary".into(), serde_json::json!("s"));
    })
    .unwrap();
    ws.save_chat(P, &a.meta.id, &serde_json::json!({"version": 1, "sessionId": "x", "messages": [2]})).unwrap();
    let kept = ws.load_chat(P, &a.meta.id).unwrap();
    assert_eq!((kept["ctx"]["memoryHash"].as_str(), kept["last_input_tokens"].as_u64(), kept["summary"].as_str(), kept["messages"][0].as_i64()), (Some("h"), Some(123), Some("s"), Some(2)));
    ws.reset_chat(P, &a.meta.id).unwrap();
    assert!(ws.load_chat(P, &a.meta.id).unwrap().get("summary").is_none());
}

#[test]
fn size_and_z_order_persist_through_save_trash_and_restore() {
    let (_d, ws) = ws();
    let a = ws.create_card(P, new_card("a")).unwrap();
    let b = ws.create_card(P, new_card("b")).unwrap();
    let mut canvas = ws.load_project(P).unwrap().canvas;
    // New cards stack upward.
    assert!(canvas.cards[&b.meta.id].z > canvas.cards[&a.meta.id].z);
    // The UI resizes `a`, sends it to the back, and saves (bad values get sanitized).
    let pa = canvas.cards.get_mut(&a.meta.id).unwrap();
    pa.w = Some(420.0);
    pa.h = Some(f64::NAN);
    pa.z = Some(-5);
    pa.back = true;
    ws.save_canvas(P, &canvas).unwrap();
    let saved = ws.load_project(P).unwrap().canvas.cards[&a.meta.id];
    assert_eq!((saved.w, saved.h, saved.z, saved.back), (Some(420.0), None, Some(-5), true));
    // Trash keeps the whole Pos; restore brings size and stacking back.
    ws.delete_card(P, &a.meta.id).unwrap();
    ws.restore_card(P, &a.meta.id).unwrap();
    assert_eq!(ws.load_project(P).unwrap().canvas.cards[&a.meta.id], saved);
    // A third card goes above everything again.
    let c = ws.create_card(P, new_card("c")).unwrap();
    let cv = ws.load_project(P).unwrap().canvas;
    assert_eq!(cv.cards[&c.meta.id].z, Some(cv.cards[&b.meta.id].z.unwrap() + 1));
}

#[test]
fn trash_reason_label_and_empty_trash() {
    let (_d, ws) = ws();
    let a = ws.create_card(P, new_card("loser")).unwrap();
    let b = ws.create_card(P, new_card("gone")).unwrap();
    ws.trash_card(P, &a.meta.id, "lost to Winner").unwrap();
    ws.delete_card(P, &b.meta.id).unwrap();
    let reasons: Vec<_> = ws.list_trash(P).unwrap().into_iter().map(|i| i.reason).collect();
    assert_eq!(reasons, vec!["lost to Winner", "deleted"]);
    assert_eq!(ws.empty_trash(P).unwrap(), 2);
    assert!(ws.list_trash(P).unwrap().is_empty());
    assert!(!ws.root.join(format!("projects/ideas/trash/{}.md", a.meta.id)).exists());
    assert!(ws.root.join("projects/ideas/trash/trash.json").is_file());
}

#[test]
fn atomic_write_replaces_and_leaves_no_temp_files() {
    let d = TempDir::new().unwrap();
    let p = d.path().join("sub/dir/file.txt");
    atomic_write(&p, b"one").unwrap();
    atomic_write(&p, b"two").unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "two");
    let leftovers: Vec<_> = fs::read_dir(p.parent().unwrap()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(leftovers, vec!["file.txt"]);
}

#[test]
fn viewport_save_and_load() {
    let (_d, ws) = ws();
    let p = ws.create_project("P").unwrap();
    let mut data = ws.load_project(&p.slug).unwrap();
    data.canvas.viewport = Viewport { x: -50.0, y: 20.0, zoom: 0.5 };
    ws.save_canvas(&p.slug, &data.canvas).unwrap();
    assert_eq!(ws.load_project(&p.slug).unwrap().canvas.viewport, Viewport { x: -50.0, y: 20.0, zoom: 0.5 });
}

#[test]
fn media_is_saved_under_the_project_and_rejects_escaping_paths() {
    let (_d, ws) = ws();
    let rel = ws.save_media(P, "photo.PNG", b"\x89PNG-ish").unwrap();
    assert!(rel.starts_with("media/") && rel.ends_with(".png"));
    assert_eq!(ws.read_project_file(P, &rel).unwrap(), b"\x89PNG-ish");
    assert!(ws.read_project_file(P, "../../etc/passwd").is_err());
    assert!(ws.read_project_file(P, "media/nope.png").is_err());
}

#[test]
fn slugify_handles_odd_names() {
    assert_eq!(slugify("  Hello,   World!! "), "hello-world");
    assert_eq!(slugify("***"), "project");
    assert_eq!(slugify("Ünï Cödé 2"), "n-c-d-2");
}

fn img(id: &str, path: &str) -> Attachment {
    Attachment::Image { id: id.into(), path: path.into(), caption: None }
}
fn clip(id: &str, url: &str) -> Attachment {
    serde_json::from_value(json!({"type": "clip", "id": id, "url": url})).unwrap()
}

#[test]
fn new_card_kinds_roundtrip_through_the_file() {
    let (_d, ws) = ws();
    let c = ws
        .create_card(
            P,
            NewCard {
                kind: Some(CardKind::Checklist),
                items: Some(vec![
                    ChecklistItem { text: "a".into(), ..Default::default() },
                    ChecklistItem { id: "q".into(), text: "why?".into(), question: true, answer: Some("because".into()), ..Default::default() },
                ]),
                attachments: Some(vec![img("", "media/a.png"), clip("x", "https://e.com")]),
                ..new_card("list")
            },
        )
        .unwrap();
    assert!(!c.meta.items[0].id.is_empty(), "missing item ids are filled");
    assert!(!c.meta.attachments[0].id().is_empty(), "missing attachment ids are filled");
    let back = ws.read_card(P, &c.meta.id).unwrap();
    assert_eq!(back, c);
    let text = fs::read_to_string(ws.root.join(format!("projects/ideas/cards/{}.md", c.meta.id))).unwrap();
    assert!(text.contains("kind: checklist") && text.contains("type: clip"), "{text}");

    // A plain card file without the new keys reads as kind "card" with no attachments.
    let plain = parse_card("---\ntitle: T\nkind: weird\n---\n", "01P").unwrap();
    assert_eq!((plain.meta.kind, plain.meta.attachments.len()), (CardKind::Card, 0));
    // A malformed attachment entry is skipped, not fatal.
    let bad = parse_card("---\nattachments:\n  - type: video\n  - {type: image, id: i, path: media/x.png}\n---\n", "01Q").unwrap();
    assert_eq!(bad.meta.attachments, vec![img("i", "media/x.png")]);

    // Escaping paths are refused.
    let err = ws.create_card(P, NewCard { attachments: Some(vec![img("", "../x.png")]), ..new_card("x") });
    assert!(matches!(err, Err(AppError::Invalid(_))));
    let u = ws.update_card(P, &c.meta.id, CardPatch { kind: Some(CardKind::Card), ..Default::default() }).unwrap();
    assert_eq!(u.meta.kind, CardKind::Card);
    assert_eq!(u.meta.attachments.len(), 2, "untouched by a patch without attachments");
}

#[test]
fn legacy_image_and_clip_fields_become_attachments_and_leave_on_write() {
    let (_d, ws) = ws();
    let id = "01LEGACY0000000000000000000";
    let path = ws.root.join(format!("projects/ideas/cards/{id}.md"));
    fs::write(&path, "---\ntitle: Old\nfields:\n  image: media/old.png\n  url: https://ex.com\n  clip_title: Ex\n  mood: calm\nattachments:\n  - {type: image, id: a1, path: media/more.png}\nnotes: keep\n---\nbody\n").unwrap();
    let c = ws.read_card(P, id).unwrap();
    let ids: Vec<_> = c.meta.attachments.iter().map(|a| a.id().to_string()).collect();
    assert_eq!(ids, ["legacy-image", "legacy-clip", "a1"], "image first, then clip, then the rest");
    assert!(matches!(&c.meta.attachments[1], Attachment::Clip { title: Some(t), .. } if t == "Ex"));
    assert_eq!(c.meta.fields.keys().collect::<Vec<_>>(), ["mood"]);
    assert_eq!(ws.read_card(P, id).unwrap(), c, "stable ids across reads");
    // Any write drops the legacy keys; unknown keys still pass through.
    ws.update_attachment(P, id, "legacy-image", &json!({"caption": "cover"})).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("clip_title") && !text.contains("  image:") && text.contains("notes: keep") && text.contains("mood: calm"), "{text}");
    let again = ws.read_card(P, id).unwrap();
    assert_eq!(again.meta.attachments.len(), 3);
    assert!(matches!(&again.meta.attachments[0], Attachment::Image { caption: Some(c), .. } if c == "cover"));
}

#[test]
fn attachment_commands_add_update_reorder_remove() {
    let (_d, ws) = ws();
    let c = ws.create_card(P, new_card("a")).unwrap();
    let id = c.meta.id.as_str();
    let rels = ws.save_media_many(P, &[MediaUpload { name_hint: "a.png".into(), bytes: b"1".to_vec() }, MediaUpload { name_hint: "b.jpg".into(), bytes: b"2".to_vec() }]).unwrap();
    assert_eq!(rels.len(), 2);
    assert!(rels[1].ends_with(".jpg"));
    ws.add_attachment(P, id, img("i1", &rels[0])).unwrap();
    ws.add_attachment(P, id, img("i1", &rels[1])).unwrap(); // taken id → fresh one
    let c = ws.add_attachment(P, id, clip("", "https://a.b")).unwrap();
    assert_eq!(c.meta.attachments.len(), 3);
    let i2 = c.meta.attachments[1].id().to_string();
    let cl = c.meta.attachments[2].id().to_string();
    assert_ne!(i2, "i1");
    assert!(ws.add_attachment(P, id, img("", "C:/x.png")).is_err());

    let c = ws.update_attachment(P, id, &cl, &json!({"title": "A", "fetch_error": "timeout", "id": "hijack", "type": "image"})).unwrap();
    assert!(matches!(&c.meta.attachments[2], Attachment::Clip { id, title: Some(t), fetch_error: Some(_), .. } if id == &cl && t == "A"));
    let c = ws.update_attachment(P, id, &cl, &json!({"fetch_error": null})).unwrap();
    assert!(matches!(&c.meta.attachments[2], Attachment::Clip { fetch_error: None, .. }));
    assert!(ws.update_attachment(P, id, &cl, &json!({"thumb": "../t.png"})).is_err());
    assert!(matches!(ws.update_attachment(P, id, "nope", &json!({})), Err(AppError::NotFound(_))));

    let c = ws.reorder_attachments(P, id, &[cl.clone(), i2.clone()]).unwrap();
    let order: Vec<_> = c.meta.attachments.iter().map(|a| a.id().to_string()).collect();
    assert_eq!(order, [cl.clone(), i2.clone(), "i1".into()], "unlisted ones keep their order at the end");
    assert!(ws.reorder_attachments(P, id, &["nope".into()]).is_err());

    let c = ws.remove_attachment(P, id, "i1").unwrap();
    assert_eq!(c.meta.attachments.len(), 2);
    assert!(ws.root.join("projects/ideas").join(&rels[0]).is_file(), "media stays until the Trash is emptied");
    assert!(ws.remove_attachment(P, id, "i1").is_err());
}

#[test]
fn empty_trash_sweeps_only_unreferenced_media() {
    let (_d, ws) = ws();
    let keep = ws.create_card(P, new_card("keep")).unwrap();
    let gone = ws.create_card(P, new_card("gone")).unwrap();
    let r = ws.save_media_many(P, &["a.png", "b.png", "c.png", "d.png"].map(|n| MediaUpload { name_hint: n.into(), bytes: vec![1] })).unwrap();
    ws.add_attachment(P, &keep.meta.id, img("", &r[0])).unwrap();
    ws.add_attachment(P, &keep.meta.id, img("x", &r[1])).unwrap();
    ws.remove_attachment(P, &keep.meta.id, "x").unwrap();
    ws.update_card(P, &keep.meta.id, CardPatch { body: Some(format!("![]({})", r[3])), ..Default::default() }).unwrap();
    ws.add_attachment(P, &gone.meta.id, img("", &r[2])).unwrap();
    ws.delete_card(P, &gone.meta.id).unwrap();
    // Trash keeps attachments: restore brings them back intact.
    let back = ws.restore_card(P, &gone.meta.id).unwrap();
    assert_eq!(back.meta.attachments.len(), 1);
    ws.delete_card(P, &gone.meta.id).unwrap();
    let media = |rel: &str| ws.root.join("projects/ideas").join(rel).is_file();
    assert!(media(&r[1]) && media(&r[2]), "nothing is swept before the Trash is emptied");
    ws.empty_trash(P).unwrap();
    assert!(media(&r[0]), "attached to a live card");
    assert!(media(&r[3]), "mentioned in a live body");
    assert!(!media(&r[1]), "removed attachment");
    assert!(!media(&r[2]), "only used by a card that was in the Trash");
}

#[test]
fn handoff_target_is_remembered_confirmed_and_cleared() {
    let (d, ws) = ws();
    let p = ws.create_project("Fish").unwrap();
    let repo = d.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    let path = repo.display().to_string();
    let patch = |t: Option<&str>, c: Option<&str>| ProjectPatch { handoff_target: t.map(Into::into), handoff_target_confirmed: c.map(Into::into), ..Default::default() };
    assert!(ws.update_project(&p.slug, patch(Some("relative/dir"), None)).is_err(), "must be an absolute, existing folder");
    assert!(ws.update_project(&p.slug, patch(Some(&d.path().join("nope").display().to_string()), None)).is_err());
    ws.update_project(&p.slug, patch(Some(&path), None)).unwrap();
    assert!(ws.update_project(&p.slug, patch(None, Some("C:/other"))).is_err(), "only the current target can be confirmed");
    ws.update_project(&p.slug, patch(None, Some(&path))).unwrap();
    let meta = ws.load_project(&p.slug).unwrap().meta;
    assert_eq!((meta.handoff_target.as_deref(), meta.handoff_target_confirmed.as_deref()), (Some(path.as_str()), Some(path.as_str())));
    ws.update_project(&p.slug, patch(Some(&path), None)).unwrap();
    assert!(ws.load_project(&p.slug).unwrap().meta.handoff_target_confirmed.is_some(), "re-setting the same folder keeps the confirmation");
    ws.update_project(&p.slug, ProjectPatch { name: Some("Fish 2".into()), ..Default::default() }).unwrap();
    assert_eq!(ws.load_project(&p.slug).unwrap().meta.handoff_target.as_deref(), Some(path.as_str()), "other edits keep it");
    ws.update_project(&p.slug, patch(Some(""), None)).unwrap();
    let meta = ws.load_project(&p.slug).unwrap().meta;
    assert!(meta.handoff_target.is_none() && meta.handoff_target_confirmed.is_none());
    // Unknown project.json keys survive.
    let pj = ws.project_dir(&p.slug).unwrap().join("project.json");
    let mut v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&pj).unwrap()).unwrap();
    v["mine"] = json!(1);
    fs::write(&pj, v.to_string()).unwrap();
    ws.update_project(&p.slug, ProjectPatch { name: Some("Fish 3".into()), ..Default::default() }).unwrap();
    assert!(fs::read_to_string(&pj).unwrap().contains("\"mine\""));
}

#[test]
fn one_decisions_card_per_project() {
    let (_d, ws) = ws();
    let dec = |t: &str| NewCard { role: Some("decisions".into()), ..new_card(t) };
    assert_eq!(ws.create_card(P, dec("Project decisions")).unwrap().meta.role.as_deref(), Some(ROLE_DECISIONS));
    assert!(ws.create_card(P, dec("again")).is_err());
    assert!(ws.create_card(P, NewCard { role: Some("tech".into()), ..new_card("t") }).is_ok(), "roles are independent");
}

#[test]
fn only_one_tech_card_per_project() {
    let (_d, ws) = ws();
    let tech = |t: &str| NewCard { role: Some("Tech".into()), ..new_card(t) };
    let a = ws.create_card(P, tech("a")).unwrap();
    assert_eq!(a.meta.role.as_deref(), Some(ROLE_TECH));
    assert!(matches!(ws.create_card(P, tech("b")), Err(AppError::Invalid(_))));
    assert!(ws.create_card(P, NewCard { role: Some("boss".into()), ..new_card("c") }).is_err());
    let b = ws.create_card(P, new_card("b")).unwrap();
    assert!(ws.update_card(P, &b.meta.id, CardPatch { role: Some("tech".into()), ..Default::default() }).is_err());
    assert!(ws.update_card(P, &a.meta.id, CardPatch { role: Some("tech".into()), title: Some("A".into()), ..Default::default() }).is_ok(), "re-setting its own role is fine");
    // Trashed tech card doesn't block; restoring it yields the role to the newer one.
    ws.delete_card(P, &a.meta.id).unwrap();
    ws.update_card(P, &b.meta.id, CardPatch { role: Some("tech".into()), ..Default::default() }).unwrap();
    assert_eq!(ws.restore_card(P, &a.meta.id).unwrap().meta.role, None);
    assert_eq!(ws.read_card(P, &a.meta.id).unwrap().meta.role, None);
    let other = ws.create_project("Other").unwrap();
    assert!(ws.create_card(&other.slug, tech("t")).is_ok(), "per project");
}

#[test]
fn frames_save_and_old_canvas_files_load() {
    let (_d, ws) = ws();
    let p = ws.create_project("P").unwrap();
    let dir = ws.project_dir(&p.slug).unwrap();
    fs::write(dir.join("canvas.json"), r#"{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"cards":{}}"#).unwrap();
    let mut data = ws.load_project(&p.slug).unwrap();
    assert!(data.canvas.frames.is_empty());
    assert_eq!(data.canvas.version, CANVAS_VERSION);
    data.canvas.frames.insert("f1".into(), Frame { x: 10.0, y: f64::NAN, w: 5.0, h: 600.0, title: "Combat".into(), color: Some("#f00".into()), z: 2 });
    ws.save_canvas(&p.slug, &data.canvas).unwrap();
    let f = ws.load_project(&p.slug).unwrap().canvas.frames["f1"].clone();
    assert_eq!(f, Frame { x: 10.0, y: 0.0, w: MIN_FRAME_SIDE, h: 600.0, title: "Combat".into(), color: Some("#f00".into()), z: 2 });
    let raw: Value = serde_json::from_str(&fs::read_to_string(dir.join("canvas.json")).unwrap()).unwrap();
    assert_eq!(raw["version"], CANVAS_VERSION);
}

#[test]
fn model_settings_default_and_reset() {
    let (_d, ws) = ws();
    let s = ws.get_settings().unwrap();
    assert_eq!((s.model_chat.as_str(), s.model_export.as_str()), ("sonnet", "opus"));
    let s = ws.update_settings(SettingsPatch { model_chat: Some(" haiku ".into()), model_export: Some("claude-opus-5-5".into()), ..Default::default() }).unwrap();
    assert_eq!((s.model_chat.as_str(), s.model_export.as_str()), ("haiku", "claude-opus-5-5"));
    assert_eq!(ws.update_settings(SettingsPatch { model_chat: Some(String::new()), ..Default::default() }).unwrap().model_chat, "sonnet");
    assert!(ws.update_settings(SettingsPatch { model_chat: Some("two words".into()), ..Default::default() }).is_err());
    let s = ws.get_settings().unwrap();
    assert_eq!((s.model_router, s.model_fast.as_str(), s.model_deep.as_str()), (true, "haiku", "opus"));
    let s = ws.update_settings(SettingsPatch { model_router: Some(false), model_fast: Some("claude-haiku-4-5".into()), ..Default::default() }).unwrap();
    assert_eq!((s.model_router, s.model_fast.as_str()), (false, "claude-haiku-4-5"));
    assert!(ws.update_settings(SettingsPatch { model_chat: Some("two words".into()), ..Default::default() }).is_err());
}

#[test]
fn proposals_live_beside_the_card_and_go_with_it() {
    let (_d, ws) = ws();
    let c = ws.create_card(P, new_card("A")).unwrap();
    let id = c.meta.id.clone();
    ws.write_proposal(P, &id, &serde_json::json!({ "title": "B", "reason": "r" })).unwrap();
    ws.write_proposal(P, &id, &serde_json::json!({ "title": "C", "reason": "r" })).unwrap();
    let data = ws.load_project(P).unwrap();
    assert_eq!(data.proposals.len(), 1);
    assert_eq!(data.proposals[&id]["title"], "C", "a new proposal replaces the old one");
    assert_eq!(data.cards.len(), 1, "the proposal file is not read as a card");
    assert_eq!(ws.read_card(P, &id).unwrap().meta.title, "A", "the card file is untouched");
    ws.delete_proposal(P, &id).unwrap();
    ws.delete_proposal(P, &id).unwrap();
    assert!(ws.load_project(P).unwrap().proposals.is_empty());
    ws.write_proposal(P, &id, &serde_json::json!({ "body": "x" })).unwrap();
    ws.delete_card(P, &id).unwrap();
    assert!(!ws.root.join(format!("projects/ideas/cards/{id}.proposal.json")).exists(), "trashing the card drops its proposal");
    assert!(ws.write_proposal(P, "01NOSUCHCARD", &serde_json::json!({})).is_err());
}

#[test]
fn card_frames_use_the_card_centre_and_topmost_frame() {
    let (_d, ws) = ws();
    let a = ws.create_card(P, NewCard { x: Some(0.0), y: Some(0.0), ..new_card("A") }).unwrap();
    let b = ws.create_card(P, NewCard { x: Some(2000.0), y: Some(0.0), ..new_card("B") }).unwrap();
    let mut data = ws.load_project(P).unwrap();
    data.canvas.frames.insert("f1".into(), Frame { x: 100.0, y: 50.0, w: 400.0, h: 400.0, title: "Low".into(), color: None, z: 1 });
    data.canvas.frames.insert("f2".into(), Frame { x: 100.0, y: 50.0, w: 400.0, h: 400.0, title: " ".into(), color: None, z: 5 });
    ws.save_canvas(P, &data.canvas).unwrap();
    let frames = ws.card_frames(P).unwrap();
    assert_eq!(frames.get(&a.meta.id).map(String::as_str), Some("Untitled frame"), "centre (118, 75) is inside; topmost wins");
    assert!(!frames.contains_key(&b.meta.id));
}

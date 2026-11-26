//! Media files and clips.
use super::*;

impl Workspace {

    /// Save bytes under the project's `media/` folder with a fresh ULID name, keeping the hinted extension.
    /// Returns the path relative to the project dir (e.g. `media/<ulid>.png`) for storing in a card's `fields`.
    pub fn save_media(&self, slug: &str, name_hint: &str, bytes: &[u8]) -> Result<String> {
        let dir = self.existing_project_dir(slug)?;
        let ext: String = Path::new(name_hint)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "png".into());
        let fname = format!("{}.{}", ulid::Ulid::generate(), ext);
        let media_dir = dir.join("media");
        atomic_write(&media_dir.join(&fname), bytes)?;
        Ok(format!("media/{fname}"))
    }

    /// Writes a fetched clip's files under `media/` (favicon, og:image, `media/clips/<att_id>.md`)
    /// and returns the clip attachment. Re-running with the same id overwrites the excerpt.
    pub fn store_clip(&self, slug: &str, att_id: &str, url: &str, f: crate::clip::Fetched) -> Result<Attachment> {
        check_id(att_id)?;
        let dir = self.existing_project_dir(slug)?;
        let favicon = f.favicon.map(|(b, ext)| self.save_media(slug, &format!("favicon.{ext}"), &b)).transpose()?;
        let thumb = f.image.map(|(b, ext)| self.save_media(slug, &format!("thumb.{ext}"), &b)).transpose()?;
        let excerpt = match &f.excerpt {
            Some(text) => {
                let rel = format!("media/clips/{att_id}.md");
                let title = f.title.as_deref().map(|t| format!("# {t}

")).unwrap_or_default();
                atomic_write(&dir.join(&rel), format!("<{url}>

{title}{text}
").as_bytes())?;
                Some(rel)
            }
            None => None,
        };
        Ok(Attachment::Clip {
            id: att_id.to_string(),
            url: url.trim().to_string(),
            title: f.title,
            description: f.description,
            site: f.site,
            favicon,
            thumb,
            excerpt,
            caption: None,
            fetched_at: Some(now()),
            fetch_error: f.error,
        })
    }

    /// Several files at once; returns their paths in the same order.
    pub fn save_media_many(&self, slug: &str, files: &[MediaUpload]) -> Result<Vec<String>> {
        files.iter().map(|f| self.save_media(slug, &f.name_hint, &f.bytes)).collect()
    }

    /// Deletes files under `media/` that no live card (or variant) mentions. Run only when the
    /// Trash is emptied, so removed attachments and trashed cards stay restorable until then.
    pub(super) fn sweep_media(dir: &Path) -> Result<()> {
        fn walk(d: &Path, out: &mut Vec<PathBuf>) {
            if let Ok(rd) = fs::read_dir(d) {
                for e in rd.filter_map(|e| e.ok()) {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else {
                        out.push(p);
                    }
                }
            }
        }
        let mut media = Vec::new();
        walk(&dir.join("media"), &mut media);
        if media.is_empty() {
            return Ok(());
        }
        let mut card_files = Vec::new();
        walk(&dir.join("cards"), &mut card_files);
        // Raw text, not parsed attachments: a path in a body, a custom field or a variant counts too.
        let text: String = card_files.iter().filter(|p| p.extension().is_some_and(|x| x == "md")).filter_map(|p| fs::read_to_string(p).ok()).collect::<Vec<_>>().join("\n");
        for p in media {
            let Ok(rel) = p.strip_prefix(dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !text.contains(&rel) {
                retry_io(|| fs::remove_file(&p)).map_err(|e| AppError::io(format!("remove {}", p.display()), e))?;
            }
        }
        Ok(())
    }

    /// Read a file back from inside a project (media, briefs...) as bytes, for the UI to show as a data URL.
    /// `rel` must stay inside the project dir.
    pub fn read_project_file(&self, slug: &str, rel: &str) -> Result<Vec<u8>> {
        let dir = self.existing_project_dir(slug)?;
        let rel_path = Path::new(rel);
        if rel_path.is_absolute() || rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(AppError::Invalid(format!("invalid relative path: {rel:?}")));
        }
        let path = dir.join(rel_path);
        fs::read(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { AppError::NotFound(format!("file {rel}")) } else { AppError::io(format!("read {}", path.display()), e) }
        })
    }
}

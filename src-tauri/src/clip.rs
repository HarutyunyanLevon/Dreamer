//! Web clips: fetch a page once, keep its title/description/site, its favicon and og:image under
//! `media/`, and a readable text excerpt as `media/clips/<att-id>.md`. A failed fetch never fails the
//! add: the clip just carries `fetch_error`.

use reqwest::Url;
use std::time::Duration;

const PAGE_CAP: usize = 3 * 1024 * 1024;
const IMAGE_CAP: usize = 2 * 1024 * 1024;
const EXCERPT_CHARS: usize = 6000;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// Everything fetched for one clip, before any of it is written to disk.
#[derive(Default, Debug)]
pub struct Fetched {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site: Option<String>,
    /// (bytes, file extension)
    pub favicon: Option<(Vec<u8>, String)>,
    pub image: Option<(Vec<u8>, String)>,
    pub excerpt: Option<String>,
    pub error: Option<String>,
}

fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(UA)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
}

/// Reads at most `cap` bytes; `None` when the body is larger.
async fn read_capped(mut resp: reqwest::Response, cap: usize) -> reqwest::Result<Option<Vec<u8>>> {
    if resp.content_length().is_some_and(|n| n as usize > cap) {
        return Ok(None);
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        out.extend_from_slice(&chunk);
        if out.len() > cap {
            return Ok(None);
        }
    }
    Ok(Some(out))
}

fn ext_for(content_type: &str, url: &Url) -> Option<String> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let from_ct = match ct.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/x-icon" | "image/vnd.microsoft.icon" | "image/ico" => Some("ico"),
        "image/avif" => Some("avif"),
        _ => None,
    };
    if let Some(e) = from_ct {
        return Some(e.into());
    }
    // Some servers send octet-stream for favicons: trust a known extension then.
    let path_ext = url.path().rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(path_ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico").then_some(path_ext)
}

async fn fetch_image(client: &reqwest::Client, url: &Url) -> Option<(Vec<u8>, String)> {
    let resp = client.get(url.clone()).send().await.ok()?.error_for_status().ok()?;
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ext = ext_for(&ct, resp.url())?;
    let bytes = read_capped(resp, IMAGE_CAP).await.ok()??;
    (!bytes.is_empty()).then_some((bytes, ext))
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|s| !s.is_empty())
}

/// Collapses runs of blank lines and trailing spaces, then cuts at `EXCERPT_CHARS`.
pub fn tidy_excerpt(text: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")) {
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(&line);
    }
    match out.char_indices().nth(EXCERPT_CHARS) {
        Some((i, _)) => format!("{}…", out[..i].trim_end()),
        None => out,
    }
}

/// Pulls metadata and a readable excerpt out of a page. Pure, so it's testable offline.
pub fn parse_page(html: &str, page_url: &Url) -> (Fetched, Option<Url>, Option<Url>) {
    let mut f = Fetched::default();
    let Ok(mut r) = dom_smoothie::Readability::new(html, Some(page_url.as_str()), None) else {
        return (f, None, None);
    };
    let meta = r.get_article_metadata(None);
    f.title = clean(Some(meta.title.clone()));
    f.description = clean(meta.excerpt.clone());
    f.site = clean(meta.site_name.clone());
    let image = meta.image.as_deref().and_then(|u| page_url.join(u).ok());
    let favicon = meta.favicon.as_deref().and_then(|u| page_url.join(u).ok()).or_else(|| page_url.join("/favicon.ico").ok());
    let text = match r.parse() {
        Ok(a) if a.text_content.trim().len() > 80 => a.text_content.to_string(),
        // Readability gave up: fall back to the main content block, or the whole body.
        _ => {
            let doc = &dom_smoothie::Readability::new(html, Some(page_url.as_str()), None).map(|r| r.doc).ok();
            doc.as_ref()
                .map(|d| {
                    let main = d.select("article, main, [role=main]");
                    if main.exists() { main.first().text().to_string() } else { d.select("body").text().to_string() }
                })
                .unwrap_or_default()
        }
    };
    let text = tidy_excerpt(&text);
    f.excerpt = (!text.is_empty()).then_some(text);
    (f, favicon, image)
}

/// Fetches the page and its favicon/og:image. Never errors: failures land in `error`.
pub async fn fetch(url: &str) -> Fetched {
    let page_url = match Url::parse(url.trim()) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => return Fetched { error: Some("not an http(s) URL".into()), ..Default::default() },
    };
    let client = match client() {
        Ok(c) => c,
        Err(e) => return Fetched { error: Some(e.to_string()), ..Default::default() },
    };
    let resp = match client.get(page_url.clone()).send().await.and_then(|r| r.error_for_status()) {
        Ok(r) => r,
        Err(e) => return Fetched { error: Some(short_err(&e)), ..Default::default() },
    };
    let final_url = resp.url().clone();
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    // A direct link to an image: keep it as the clip's thumbnail.
    if ct.starts_with("image/") {
        let ext = ext_for(&ct, &final_url);
        let bytes = read_capped(resp, IMAGE_CAP).await.ok().flatten();
        let name = final_url.path_segments().and_then(|mut s| s.next_back().map(str::to_string)).filter(|s| !s.is_empty());
        return Fetched { title: name, site: final_url.host_str().map(str::to_string), image: bytes.zip(ext), ..Default::default() };
    }
    let bytes = match read_capped(resp, PAGE_CAP).await {
        Ok(Some(b)) => b,
        Ok(None) => return Fetched { error: Some("page is larger than 3 MB".into()), site: final_url.host_str().map(str::to_string), ..Default::default() },
        Err(e) => return Fetched { error: Some(short_err(&e)), ..Default::default() },
    };
    let html = String::from_utf8_lossy(&bytes);
    let (mut f, favicon_url, image_url) = parse_page(&html, &final_url);
    if f.site.is_none() {
        f.site = final_url.host_str().map(|h| h.trim_start_matches("www.").to_string());
    }
    let fav = async {
        match &favicon_url {
            Some(u) => fetch_image(&client, u).await,
            None => None,
        }
    };
    let img = async {
        match &image_url {
            Some(u) => fetch_image(&client, u).await,
            None => None,
        }
    };
    let (fav, img) = tokio::join!(fav, img);
    f.favicon = fav;
    f.image = img;
    f
}

fn short_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if let Some(s) = e.status() {
        format!("HTTP {}", s.as_u16())
    } else if e.is_connect() {
        "could not connect".into()
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meta_and_excerpt() {
        let html = r#"<html><head><title>Hello page</title>
            <meta name="description" content="A  short   description">
            <meta property="og:site_name" content="Example">
            <meta property="og:image" content="/img/cover.png">
            <link rel="icon" href="fav.png"></head>
            <body><nav>menu menu</nav><article><h1>Hello</h1><p>First paragraph of real text that is long enough to count as the article body for readability.</p>
            <p>Second paragraph with even more words so the content scorer picks it up as the main block of the page.</p></article></body></html>"#;
        let base = Url::parse("https://example.com/a/b").unwrap();
        let (f, fav, img) = parse_page(html, &base);
        assert_eq!(f.title.as_deref(), Some("Hello page"));
        assert_eq!(f.description.as_deref(), Some("A short description"));
        assert_eq!(f.site.as_deref(), Some("Example"));
        assert_eq!(img.unwrap().as_str(), "https://example.com/img/cover.png");
        assert_eq!(fav.unwrap().as_str(), "https://example.com/a/fav.png");
        assert!(f.excerpt.unwrap().contains("Second paragraph"));
    }

    #[test]
    fn excerpt_is_tidied_and_capped() {
        assert_eq!(tidy_excerpt("  a  b \n\n\n\n c\n d "), "a b\n\nc\nd");
        let long = "x".repeat(EXCERPT_CHARS + 50);
        assert_eq!(tidy_excerpt(&long).chars().count(), EXCERPT_CHARS + 1);
    }

    #[test]
    fn bad_url_is_a_bare_error() {
        let f = tauri::async_runtime::block_on(fetch("ftp://nope"));
        assert!(f.error.is_some());
    }
}

#[cfg(test)]
mod live {
    /// `cargo test --lib clip::live -- --ignored --nocapture` (needs the network).
    #[test]
    #[ignore]
    fn live_fetch() {
        let f = tauri::async_runtime::block_on(super::fetch("https://en.wikipedia.org/wiki/Roguelike"));
        println!("{:?} {:?} {:?} fav={:?} img={:?} err={:?} excerpt={}", f.title, f.site, f.description, f.favicon.as_ref().map(|x| (x.0.len(), &x.1)), f.image.as_ref().map(|x| (x.0.len(), &x.1)), f.error, f.excerpt.as_deref().unwrap_or("").chars().take(200).collect::<String>());
    }
}

/**
 * A deliberately small markdown-ish renderer: headings, bold/italic, links and lists.
 * Good enough for card notes; not a spec-complete parser (no CDN deps, keeps the bundle tiny).
 */
export function renderMarkdown(src: string): string {
  // Quotes too: link URLs land inside an href="..." attribute, and an unescaped quote there
  // would let a card's text inject attributes (card files can come from anywhere).
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "<em>$1</em>")
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const lines = src.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (h) {
      const level = h[1].length + 2; // keep headings modest inside a card
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (line.trim() === "") {
      out.push("<br />");
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

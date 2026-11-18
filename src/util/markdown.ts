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

/** GitHub-style heading anchor: lowercase, punctuation dropped, each space a hyphen. */
export function headingSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const DOC_LINK = /^(?:\.\/)?((?:docs\/design\/)?(?:\d\d-[\w-]+|CLAUDE|CHANGELOG|QUESTIONS)\.md)?(?:#([\w\p{L}-]+))?$/u;

/**
 * Renders a design doc (the handoff pack) to HTML: headings with anchors, paragraphs, nested and
 * ordered lists, task lists, tables, block quotes, code blocks, rules, inline code, bold/italic,
 * links and images. Everything is escaped first. Images only load from the version's `assets/`
 * (they carry `data-asset`; the reader fills in the source), never from the network. Links to
 * other docs carry `data-doc` / `data-hash`; web links carry `data-external`.
 */
export function renderDoc(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const fmt = (raw: string) =>
    esc(raw)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, href: string) =>
        /^(?:\.\/)?assets\/[\w.-]+$/.test(href)
          ? `<img class="doc-img" data-asset="${href.replace(/^\.\//, "")}" alt="${alt}" />`
          : `<span class="doc-noimg">[image: ${alt || href}]</span>`,
      )
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
        if (/^https?:\/\//i.test(href)) return `<a href="${href}" data-external="">${label}</a>`;
        const m = DOC_LINK.exec(href.replace(/&amp;/g, "&"));
        if (m && (m[1] || m[2])) return `<a href="#" data-doc="${(m[1] ?? "").replace(/^docs\/design\//, "")}" data-hash="${m[2] ?? ""}">${label}</a>`;
        return label;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<![\w*])\*(?!\*)(.+?)\*(?![\w*])/g, "<em>$1</em>")
      .replace(/(?<![\w_])_(?!_)(.+?)_(?![\w_])/g, "<em>$1</em>");
  const inline = (s: string) =>
    s
      .split(/(`[^`]+`)/g)
      .map((p) => (p.length > 1 && p.startsWith("`") && p.endsWith("`") ? `<code>${esc(p.slice(1, -1))}</code>` : fmt(p)))
      .join("");

  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const isBlockStart = (l: string, next?: string) =>
    /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^>\s?/.test(l) || LIST.test(l) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));
  const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const used = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre class="doc-code"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      let id = headingSlug(h[2]);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      out.push(`<h${level} id="${esc(id)}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderDoc(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      type Item = { indent: number; ordered: boolean; html: string };
      const items: Item[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST.exec(l);
        if (m) {
          let text = m[3];
          let box = "";
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
          if (task) {
            box = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"} aria-label="${task[1] === " " ? "To do" : "Done"}" /> `;
            text = task[2];
          }
          items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), html: box + inline(text) });
          i++;
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1].html += `<br />${inline(l.trim())}`;
          i++;
        } else if (!l.trim() && i + 1 < lines.length && (LIST.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
          i++;
        } else break;
      }
      let html = "";
      const stack: { indent: number; tag: string }[] = [];
      for (const it of items) {
        while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop()!.tag}>`;
        const top = stack[stack.length - 1];
        const tag = it.ordered ? "ol" : "ul";
        if (!top || it.indent > top.indent) {
          html += `<${tag}>`;
          stack.push({ indent: it.indent, tag });
        } else if (top.tag !== tag) {
          html += `</li></${top.tag}><${tag}>`;
          top.tag = tag;
        } else html += "</li>";
        html += `<li${it.html.startsWith("<input") ? ' class="task"' : ""}>${it.html}`;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      out.push(html);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    out.push(`<p>${para.map(inline).join(" ")}</p>`);
  }
  return out.join("\n");
}

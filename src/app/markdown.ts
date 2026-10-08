// Small, safe markdown renderer for assistant text. Escapes everything first,
// then re-introduces a fixed set of tags. Links are restricted to http(s).

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function inline(src: string): string {
  const codes: string[] = []
  let s = src.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = esc(s)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      out.push(`<pre><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`)
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = Math.min(h[1].length + 2, 6)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      i++
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>")
      i++
      continue
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""))
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`)
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
      const head = row(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]))
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      )
      continue
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      const ordered = /\d/.test(li[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (m) {
          const nested = m[1].length >= 2
          const task = m[3].match(/^\[([ xX])\]\s+(.*)$/)
          const body = task
            ? `<span class="task ${task[1].trim() ? "done" : ""}"></span>${inline(task[2])}`
            : inline(m[3])
          items.push(`<li${nested ? ' class="nested"' : ""}>${body}</li>`)
          i++
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${inline(lines[i].trim())}</li>`)
          i++
        } else break
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`)
    else {
      out.push(`<p>${inline(line)}</p>`)
      i++
    }
  }
  return out.join("")
}

/** Plain-text preview: markdown syntax stripped, list items kept as bullets. */
export function previewBlocks(src: string): { text: string; bullets: string[] } {
  const lines = src.replace(/```[\s\S]*?```/g, "").split("\n")
  const text: string[] = []
  const bullets: string[] = []
  for (const raw of lines) {
    const l = raw
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#+\s+/, "")
      .trim()
    if (!l) continue
    const li = l.match(/^([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/)
    if (li) bullets.push(li[2])
    else if (!bullets.length) text.push(l)
    else {
      // Text after a list: start over so the preview shows the latest prose.
      text.length = 0
      text.push(l)
      bullets.length = 0
    }
  }
  return { text: text.join(" "), bullets: bullets.slice(-3) }
}

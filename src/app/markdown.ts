// Small, safe markdown renderer for assistant text. Escapes everything first,
// then re-introduces a fixed set of tags. Links are restricted to http(s).

const MAX_QUOTE_DEPTH = 16

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function emphasize(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
}

function splitBareUrl(raw: string): [string, string] {
  let url = raw
  let trail = ""
  while (url.length > 8) {
    const last = url[url.length - 1]
    if (/[.,;:!?]/.test(last)) {
      trail = last + trail
      url = url.slice(0, -1)
    } else if (last === ")") {
      const opens = (url.match(/\(/g) ?? []).length
      const closes = (url.match(/\)/g) ?? []).length
      if (closes > opens) {
        trail = last + trail
        url = url.slice(0, -1)
      } else break
    } else break
  }
  return [url, trail]
}

function inline(src: string): string {
  const codes: string[] = []
  const links: string[] = []
  // Strip control sentinels before allocating placeholder tokens so user text cannot collide.
  let s = src.replace(/\u0000/g, "\uFFFD").replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000C${codes.length - 1}\u0000`
  })
  s = esc(s)
  // Extract markdown links to placeholders before bare autolinks so a URL label cannot double-wrap <a>.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()<>]+|\([^\s()<>]*\))+)\)/g, (_, t, u) => {
    links.push(`<a href="${u}" target="_blank" rel="noreferrer noopener">${emphasize(t)}</a>`)
    return `\u0000L${links.length - 1}\u0000`
  })
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, raw) => {
    const [u, trail] = splitBareUrl(raw)
    if (!u) return pre + raw
    return `${pre}<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>${trail}`
  })
  s = emphasize(s)
  s = s.replace(/\u0000L(\d+)\u0000/g, (_, i) => links[Number(i)] ?? "")
  return s.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? "")
}

function splitTableRow(line: string): string[] {
  const raw = line.trim()
  const out: string[] = []
  let cur = ""
  let inCode = false
  for (let idx = 0; idx < raw.length; idx++) {
    const ch = raw[idx]
    if (ch === "\\" && raw[idx + 1] === "|") {
      cur += "|"
      idx++
      continue
    }
    if (ch === "`") {
      inCode = !inCode
      cur += ch
      continue
    }
    if (ch === "|" && !inCode) {
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  out.push(cur)
  if (out.length && !out[0].trim()) out.shift()
  if (out.length && !out[out.length - 1].trim()) out.pop()
  return out.map((c) => c.trim())
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("-") || (!line.includes("|") && !/^\s*:?-{2,}:?\s*$/.test(line))) return false
  const cells = splitTableRow(line)
  return cells.length >= 1 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/

export function renderMarkdown(src: string, depth = 0): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/)
    if (fence) {
      const marker = fence[1]
      const ch = marker[0]
      const closeRe = new RegExp(`^${ch}{${marker.length},}$`)
      const body: string[] = []
      i++
      while (i < lines.length && !closeRe.test(lines[i].trim())) body.push(lines[i++])
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

    if (HR_RE.test(line)) {
      out.push("<hr>")
      i++
      continue
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""))
      if (depth >= MAX_QUOTE_DEPTH) out.push(`<blockquote><p>${body.map(inline).join("<br>")}</p></blockquote>`)
      else out.push(`<blockquote>${renderMarkdown(body.join("\n"), depth + 1)}</blockquote>`)
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitTableRow(lines[i++]))
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
          if (/\d/.test(m[2]) !== ordered) break
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
      !HR_RE.test(lines[i]) &&
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
  const rawLines = src.replace(/\r\n/g, "\n").split("\n")
  const lines: string[] = []
  let fence: { ch: string; len: number } | null = null
  for (const ln of rawLines) {
    if (fence) {
      const t = ln.trim()
      if (t.length >= fence.len && t.split("").every((c) => c === fence!.ch)) fence = null
      continue
    }
    const m = ln.match(/^\s*(```+|~~~+)/)
    if (m) {
      const rest = ln.slice(m[0].length)
      if (!rest.includes(m[1])) fence = { ch: m[1][0], len: m[1].length }
      continue
    }
    lines.push(ln)
  }
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

import { describe, expect, test } from "bun:test"
import { previewBlocks, renderMarkdown } from "../src/app/markdown"

describe("renderMarkdown — security & escaping", () => {
  test("escapes HTML tags, script payloads, and unsafe URI schemes", () => {
    const xss = renderMarkdown(`<script>alert(1)</script> [bad](javascript:alert(1)) [data](data:text/html,hi) [vb](vbscript:msg)`)
    expect(xss).not.toContain("<script")
    expect(xss).toContain("&lt;script&gt;")
    expect(xss).not.toContain("href=")
  })

  test("strips NUL bytes so user text cannot collide with internal placeholders", () => {
    const out = renderMarkdown("before \u00000\u0000 `inside` \u00001\u0000 [go](https://x.dev)")
    expect(out).not.toContain("\u0000")
    expect(out).toContain("<code>inside</code>")
    expect(out).toContain('href="https://x.dev"')
    expect(out).not.toContain(">inside</a>")
  })
})

describe("renderMarkdown — links & autolinks", () => {
  test("never nests <a> when a markdown link label contains a URL", () => {
    const html = renderMarkdown("[https://example.com](https://target.dev)")
    const anchors = html.match(/<a\b/g) ?? []
    expect(anchors).toHaveLength(1)
    expect(html).toContain('href="https://target.dev"')
    expect(html).toContain(">https://example.com</a>")
  })

  test("formats bold/italic/strike inside markdown link labels without breaking the link", () => {
    const html = renderMarkdown("[**bold** and `code`](https://x.dev/a_b)")
    expect(html).toBe('<p><a href="https://x.dev/a_b" target="_blank" rel="noreferrer noopener"><strong>bold</strong> and <code>code</code></a></p>')
  })

  test("autolinks bare URLs while trimming trailing punctuation and unbalanced parentheses", () => {
    expect(renderMarkdown("Visit https://x.dev/docs.")).toBe(
      '<p>Visit <a href="https://x.dev/docs" target="_blank" rel="noreferrer noopener">https://x.dev/docs</a>.</p>',
    )
    expect(renderMarkdown("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
      '<p>(see <a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer noopener">https://en.wikipedia.org/wiki/Foo_(bar)</a>)</p>',
    )
  })
})

describe("renderMarkdown — fences, rules, lists, tables, blockquotes", () => {
  test("supports 4+ backtick and tilde fences without closing prematurely on shorter inner fences", () => {
    const md = "````md\n```ts\nconst x = 1\n```\n````"
    expect(renderMarkdown(md)).toBe('<pre><code data-lang="md">```ts\nconst x = 1\n```</code></pre>')

    const tilde = "~~~~sh\n~~~\necho hi\n~~~\n~~~~"
    expect(renderMarkdown(tilde)).toBe('<pre><code data-lang="sh">~~~\necho hi\n~~~</code></pre>')
  })

  test("unclosed code fences close cleanly at EOF", () => {
    expect(renderMarkdown("```js\nconst a = 1 < 2")).toBe('<pre><code data-lang="js">const a = 1 &lt; 2</code></pre>')
  })

  test("horizontal rules break preceding paragraphs", () => {
    expect(renderMarkdown("hello\n---")).toBe("<p>hello</p><hr>")
  })

  test("splits unordered and ordered list items into distinct list elements", () => {
    expect(renderMarkdown("- one\n1. two\n- three")).toBe("<ul><li>one</li></ul><ol><li>two</li></ol><ul><li>three</li></ul>")
  })

  test("validates every GFM table separator cell and handles escaped/code pipes inside cells", () => {
    expect(renderMarkdown("| a | b |\n| --- | not-a-sep |\n| 1 | 2 |")).not.toContain("<table>")

    const table = renderMarkdown("| col | val |\n| :--- | ---: |\n| `a | b` | x \\| y |")
    expect(table).toContain("<table>")
    expect(table).toContain("<td><code>a | b</code></td>")
    expect(table).toContain("<td>x | y</td>")
  })

  test("caps deep nested blockquotes cleanly without stack overflow", () => {
    const deep = "> ".repeat(25) + "leaf"
    const html = renderMarkdown(deep)
    expect(html).toContain("<blockquote>")
    expect(html).toContain("leaf")
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(18)
  })
})

describe("previewBlocks — code fence handling", () => {
  test("strips closed, unclosed, and 4+ char fences while keeping prose and bullets", () => {
    expect(previewBlocks("Intro text\n````ts\n- fake bullet inside fence\n````\n- real bullet")).toEqual({
      text: "Intro text",
      bullets: ["real bullet"],
    })
    expect(previewBlocks("Summary\n```py\nprint(1)\n- unclosed")).toEqual({
      text: "Summary",
      bullets: [],
    })
  })
})

import { describe, expect, test } from "bun:test"
import {
  basename,
  describeTool,
  lastAssistantText,
  matchesQuery,
  summarizeTools,
  timeAgo,
  toolOutput,
  toolRow,
  truncate,
} from "../src/app/format"
import { previewBlocks, renderMarkdown } from "../src/app/markdown"
import { buildPreview } from "../src/app/store"
import type { Message } from "../src/app/types"

describe("summarizeTools", () => {
  test("matches the transcript phrasing", () => {
    const tools = [
      ...Array.from({ length: 7 }, (_, i) => ({ name: "edit", input: { path: `f${i}.ts` } })),
      ...Array.from({ length: 12 }, () => ({ name: "shell", input: { command: "ls" } })),
      { name: "read", input: { path: "a.ts" } },
      { name: "read", input: { path: "b.ts" } },
    ]
    expect(summarizeTools(tools)).toBe("Patched 7 files, ran 12 commands, read 2 files")
  })

  test("counts distinct files, singular forms", () => {
    expect(summarizeTools([{ name: "read", input: { path: "a" } }, { name: "read", input: { path: "a" } }])).toBe("Read 1 file")
    expect(summarizeTools([{ name: "grep", input: { pattern: "x" } }])).toBe("Searched 1 pattern")
    expect(summarizeTools([])).toBe("")
  })
})

describe("tool labels", () => {
  test("present tense for cards", () => {
    expect(describeTool("read", { path: "/x/web/sessions.ts" })).toBe("Reading sessions.ts…")
    expect(describeTool("grep", { pattern: "labelState" })).toBe("Searching for labelState…")
    expect(describeTool("shell", { command: "git status\nls" })).toBe("Running git status…")
    expect(describeTool("subagent", { description: "Running Chrome for Testing" })).toBe("Running Chrome for Testing…")
    expect(describeTool("mcp.some_tool")).toBe("Calling some_tool…")
  })

  test("past tense rows", () => {
    expect(toolRow("read", { path: "web/a.ts" })).toEqual(["Read", "web/a.ts"])
    expect(toolRow("shell", { command: "bun test" })).toEqual(["Ran", "bun test"])
  })
})

describe("timeAgo", () => {
  const now = 1_800_000_000_000
  test("buckets", () => {
    expect(timeAgo(now - 10_000, now)).toBe("Just now")
    expect(timeAgo(now - 10 * 60_000, now)).toBe("10 min ago")
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3 hr ago")
    expect(timeAgo(now - 30 * 3600_000, now)).toBe("Yesterday")
  })
})

describe("matchesQuery", () => {
  test("all terms, any field, case-insensitive", () => {
    expect(matchesQuery("open canvas", "OpenCode sessions as an infinite canvas")).toBe(true)
    expect(matchesQuery("open slack", "OpenCode", "canvas")).toBe(false)
    expect(matchesQuery("  ", "anything")).toBe(true)
  })
})

describe("markdown", () => {
  test("escapes HTML", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img")
  })

  test("only http(s) links", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href")
    expect(renderMarkdown("[docs](https://opencode.ai)")).toContain('href="https://opencode.ai"')
  })

  test("blocks", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n```ts\nconst a = 1 < 2\n```\n\nSome **bold** and `code`.")
    expect(html).toContain("<h3>Title</h3>")
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>")
    expect(html).toContain("const a = 1 &lt; 2")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>code</code>")
  })

  test("tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")
    expect(html).toContain("<th>a</th>")
    expect(html).toContain("<td>2</td>")
  })

  test("preview keeps the latest prose and bullets", () => {
    expect(previewBlocks("Intro\n\n- a\n- b")).toEqual({ text: "Intro", bullets: ["a", "b"] })
    expect(previewBlocks("- old\n\nNew **prose** here")).toEqual({ text: "New prose here", bullets: [] })
  })
})

describe("buildPreview", () => {
  const user = (id: string, text: string): Message => ({ type: "user", id, time: { created: 0 }, text })
  const assistant = (id: string, text: string): Message => ({
    type: "assistant",
    id,
    time: { created: 0 },
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: text ? [{ type: "text", text }] : [{ type: "tool", id: "c", name: "read", state: { status: "completed" }, time: { created: 0 } }],
  })

  test("newest assistant text wins; unanswered user message is pending", () => {
    const p = buildPreview([user("u2", "why zero growth?"), assistant("a1", "Done.")])
    expect(p.text).toBe("Done.")
    expect(p.pendingUser).toBe("why zero growth?")
  })

  test("a tool-only reply still counts as an answer", () => {
    const p = buildPreview([assistant("a2", ""), user("u1", "old"), assistant("a1", "Earlier text")])
    expect(p.pendingUser).toBeUndefined()
    expect(p.text).toBe("Earlier text")
  })
})

// ---- T31: the function gaps - toolOutput/lastAssistantText/basename/truncate
// and the switch branches the older describes never reach. ----

describe("basename and truncate", () => {
  test("basename strips trailing slashes and survives empties", () => {
    expect(basename()).toBe("")
    expect(basename(null)).toBe("")
    expect(basename("/home/u/app.ts")).toBe("app.ts")
    expect(basename("a/b///")).toBe("b")
    expect(basename("/")).toBe("/") // last part empty -> falls back to the raw path
    expect(basename("C:\\Users\\torre\\repo")).toBe("repo")
    expect(basename("C:\\Users\\torre\\repo\\\\")).toBe("repo")
  })

  test("truncate collapses whitespace and keeps room for the ellipsis", () => {
    expect(truncate("  a\n  b  ", 10)).toBe("a b")
    expect(truncate("abcdef", 4)).toBe("abc…") // n-1 chars + ellipsis
    expect(truncate("abc", 4)).toBe("abc") // under the limit, untouched
  })
})

describe("timeAgo — edges beyond the buckets", () => {
  const now = 1_800_000_000_000
  test("second/hour/day boundaries, the dated fallback and future clamping", () => {
    expect(timeAgo(now - 44_000, now)).toBe("Just now")
    expect(timeAgo(now - 46_000, now)).toBe("1 min ago")
    expect(timeAgo(now - 59 * 60_000, now)).toBe("59 min ago")
    expect(timeAgo(now - 60 * 60_000, now)).toBe("1 hr ago")
    expect(timeAgo(now - 23 * 3600_000, now)).toBe("23 hr ago")
    expect(timeAgo(now - 24 * 3600_000, now)).toBe("Yesterday")
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe("3 days ago")
    expect(timeAgo(now - 10 * 86_400_000, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/) // dated, not "10 days ago"
    expect(timeAgo(now + 60_000, now)).toBe("Just now") // future timestamps clamp to zero
  })
})

describe("describeTool — the rest of the tool table", () => {
  test("write-family present tense with and without a path", () => {
    for (const n of ["edit", "write", "patch", "apply_patch", "multiedit", "Edit", "WRITE"]) {
      expect(describeTool(n, { path: "/x/y.ts" })).toBe("Editing y.ts…")
    }
    expect(describeTool("write")).toBe("Editing…")
    expect(describeTool("multiedit", { target: "/z" })).toBe("Editing z…") // pathOf target fallback
  })

  test("bash falls back description -> command -> generic", () => {
    expect(describeTool("bash", { command: "ls" })).toBe("Running ls…")
    expect(describeTool("bash")).toBe("Running a command…")
    const long = "x".repeat(100)
    // pinned as-is: an over-limit description double-ellipses (truncate adds
    // one for the 44-cap and the template adds another) - cosmetic, flagged.
    expect(describeTool("bash", { description: long })).toBe(long.slice(0, 43) + "……")
  })

  test("glob/list, websearch, webfetch and skill variants", () => {
    expect(describeTool("glob", { pattern: "*.ts" })).toBe("Finding *.ts…")
    expect(describeTool("list", { path: "/src" })).toBe("Listing files…") // no pattern -> generic; path not consulted
    expect(describeTool("websearch", { query: "bun timers" })).toBe("Searching the web for bun timers…")
    expect(describeTool("websearch")).toBe("Searching the web…")
    expect(describeTool("webfetch", { url: "https://opencode.ai/docs/x" })).toBe("Fetching opencode.ai…")
    expect(describeTool("webfetch", { url: "not a url" })).toBe("Fetching not a url…") // host() falls back to the raw string
    expect(describeTool("webfetch")).toBe("Fetching a page…")
    expect(describeTool("skill", { name: "browser" })).toBe("Loading browser…")
    expect(describeTool("skill")).toBe("Loading a skill…")
  })

  test("question, planning and execute labels; task aliases subagent", () => {
    expect(describeTool("question", { question: "?" })).toBe("Waiting for your answer")
    expect(describeTool("todowrite")).toBe("Planning…")
    expect(describeTool("execute", { code: "1" })).toBe("Running code…")
    expect(describeTool("task", { description: "Do it" })).toBe("Do it…")
  })
})

describe("toolRow — the rest of the row table", () => {
  test("write-family and search rows, including the pathOf fallbacks", () => {
    expect(toolRow("edit", { path: "a" })).toEqual(["Edited", "a"])
    expect(toolRow("patch", { file_path: "b" })).toEqual(["Edited", "b"])
    expect(toolRow("multiedit", { filePath: "c" })).toEqual(["Edited", "c"])
    expect(toolRow("write", { path: "d" })).toEqual(["Wrote", "d"])
    expect(toolRow("grep", { pattern: "x" })).toEqual(["Searched", "x"])
    expect(toolRow("glob", { pattern: "*.ts" })).toEqual(["Listed", "*.ts"])
    expect(toolRow("list", { path: "/src" })).toEqual(["Listed", "/src"]) // path fallback when no pattern
  })

  test("web, subagent, skill and question rows; unknown tools summarise input", () => {
    expect(toolRow("websearch", { query: "q" })).toEqual(["Searched web", "q"])
    expect(toolRow("webfetch", { url: "https://x.dev" })).toEqual(["Fetched", "https://x.dev"])
    expect(toolRow("task", { prompt: "do" })).toEqual(["Subagent", "do"]) // prompt fallback
    expect(toolRow("skill", { name: "chrome" })).toEqual(["Loaded skill", "chrome"])
    expect(toolRow("question", { title: "Ship it?" })).toEqual(["Asked", "Ship it?"]) // title fallback
    expect(toolRow("mcp.foo_bar", { a: 1 })).toEqual(["foo_bar", JSON.stringify({ a: 1 })])
    expect(toolRow("plain")).toEqual(["plain", ""]) // no input at all
  })
})

describe("summarizeTools — remaining buckets", () => {
  test("every bucket in output order", () => {
    const tools = [
      { name: "write", input: { path: "a" } },
      { name: "execute", input: { code: "1" } },
      { name: "read", input: { path: "b" } },
      { name: "grep", input: { pattern: "p" } },
      { name: "webfetch", input: { url: "https://x.dev" } },
      { name: "task", input: { description: "d" } },
      { name: "skill", input: { name: "s" } },
      { name: "mcp.thing", input: {} },
    ]
    expect(summarizeTools(tools)).toBe(
      "Patched 1 file, ran 1 command, read 1 file, searched 1 pattern, fetched 1 page, ran 1 subagent, loaded 1 skill, called 1 tool",
    )
  })

  test("plural forms and the count fallback for pathless patches", () => {
    expect(summarizeTools([{ name: "webfetch", input: {} }, { name: "webfetch", input: {} }])).toBe("Fetched 2 pages")
    expect(summarizeTools([{ name: "task", input: {} }, { name: "task", input: {} }])).toBe("Ran 2 subagents")
    expect(summarizeTools([{ name: "skill", input: {} }, { name: "skill", input: {} }])).toBe("Loaded 2 skills")
    expect(summarizeTools([{ name: "edit", input: {} }, { name: "write", input: {} }])).toBe("Patched 2 files") // no paths -> count
  })
})

describe("toolOutput", () => {
  test("error strings, error objects and missing errors", () => {
    expect(toolOutput({ status: "error", error: "boom" })).toBe("boom")
    expect(toolOutput({ status: "error", error: new Error("kaboom") })).toBe("kaboom") // e.message
    expect(toolOutput({ status: "error" })).toBe("{}") // JSON of an empty object
  })

  test("content text joins; named and unnamed parts get brackets", () => {
    expect(
      toolOutput({ status: "completed", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }),
    ).toBe("one\ntwo")
    expect(toolOutput({ status: "completed", content: [{ type: "image", name: "shot.png" }] })).toBe("[shot.png]")
    expect(toolOutput({ status: "completed", content: [{ type: "image" }] })).toBe("[image]")
    expect(toolOutput({ status: "completed" })).toBe("")
    expect(toolOutput({ status: "completed", content: [] })).toBe("")
  })
})

describe("lastAssistantText", () => {
  const t = (text: string) => ({ type: "text" as const, text })
  test("last non-empty text wins, skipping blanks and tool parts", () => {
    expect(lastAssistantText([t("first"), t("second")])).toBe("second")
    expect(
      lastAssistantText([
        t("keep"),
        t("   "),
        { type: "tool", id: "c", name: "read", state: { status: "completed" }, time: { created: 0 } },
      ]),
    ).toBe("keep")
    expect(lastAssistantText([t("  "), t("\n")])).toBe("")
    expect(lastAssistantText([])).toBe("")
  })
})

// ---- T33: markdown blocks the original describe never reached. ----

describe("markdown — the untested blocks", () => {
  test("hr variants, nested blockquote content and capped heading levels", () => {
    expect(renderMarkdown("---")).toBe("<hr>")
    expect(renderMarkdown("- - -")).toBe("<hr>")
    expect(renderMarkdown("***")).toBe("<hr>")
    expect(renderMarkdown("*_*")).not.toContain("<hr>") // mixed markers do not match (backreference)
    expect(renderMarkdown("> **bold**\n> - item")).toBe(
      "<blockquote><p><strong>bold</strong></p><ul><li>item</li></ul></blockquote>",
    )
    expect(renderMarkdown(">quote")).toBe("<blockquote><p>quote</p></blockquote>") // bare > strips too
    expect(renderMarkdown("#### four")).toBe("<h6>four</h6>") // 4+2 = 6
    expect(renderMarkdown("##### five")).toBe("<h6>five</h6>") // 5+2 capped
    expect(renderMarkdown("###### six")).toBe("<h6>six</h6>") // 6+2 capped
  })

  test("ordered and plus bullets, task checkboxes and nested markers", () => {
    expect(renderMarkdown("1. one\n2) two")).toBe("<ol><li>one</li><li>two</li></ol>")
    expect(renderMarkdown("+ plus")).toBe("<ul><li>plus</li></ul>")
    expect(renderMarkdown("- [ ] todo\n- [x] done\n- [X] caps")).toBe(
      '<ul><li><span class="task "></span>todo</li><li><span class="task done"></span>done</li><li><span class="task done"></span>caps</li></ul>',
    )
    // Nesting is a flat marker, not a nested list.
    expect(renderMarkdown("- outer\n  - inner")).toBe("<ul><li>outer</li><li class=\"nested\">inner</li></ul>")
  })

  test("an indented continuation line joins the previous item", () => {
    expect(renderMarkdown("- first\n  continued\n- second")).toBe("<ul><li>first continued</li><li>second</li></ul>")
  })

  test("fences carry data-lang when named; bare and tilde fences do not", () => {
    expect(renderMarkdown("```ts\nconst a = 1\n```")).toBe('<pre><code data-lang="ts">const a = 1</code></pre>')
    expect(renderMarkdown("```\nplain\n```")).toBe("<pre><code>plain</code></pre>")
    expect(renderMarkdown("~~~js\nconst b = 2\n~~~")).toBe('<pre><code data-lang="js">const b = 2</code></pre>')
    expect(renderMarkdown("```objective-c\nint x;\n```")).toBe('<pre><code data-lang="objective-c">int x;</code></pre>')
  })

  test("underscore strong, em, del, autolinks and code-span protection", () => {
    expect(renderMarkdown("__big__")).toBe("<p><strong>big</strong></p>")
    expect(renderMarkdown("say *hi* now")).toBe("<p>say <em>hi</em> now</p>")
    expect(renderMarkdown("~~gone~~")).toBe("<p><del>gone</del></p>")
    expect(renderMarkdown("see https://x.dev/docs now")).toBe(
      '<p>see <a href="https://x.dev/docs" target="_blank" rel="noreferrer noopener">https://x.dev/docs</a> now</p>',
    )
    // Code spans become placeholders before autolinking: no link inside <code>.
    expect(renderMarkdown("`https://x.dev`")).toBe("<p><code>https://x.dev</code></p>")
  })

  test("a lone pipe line falls through to a paragraph, not a broken table", () => {
    expect(renderMarkdown("| just cells")).toBe("<p>| just cells</p>") // no trailing pipe: plain prose
    expect(renderMarkdown("text\n| a | b |")).toBe("<p>text</p><p>| a | b |</p>") // trailing pipe, no separator row
  })

  test("CRLF input renders the same as LF", () => {
    expect(renderMarkdown("# T\r\n\r\n- a\r\n")).toBe(renderMarkdown("# T\n\n- a\n"))
  })

  test("preview strips fences and markers, keeps the last three bullets", () => {
    expect(previewBlocks("```ts\ncode\n```\n# Heading\nAfter `x` and [a](https://b.dev) # H")).toEqual({
      // ^#+ strips only at line start; a mid-line # is kept as plain text.
      text: "Heading After x and a # H",
      bullets: [],
    })
    expect(previewBlocks("- [ ] todo\n- [x] done")).toEqual({ text: "", bullets: ["todo", "done"] })
    expect(previewBlocks("- a\n- b\n- c\n- d\n- e")).toEqual({ text: "", bullets: ["c", "d", "e"] })
  })
})

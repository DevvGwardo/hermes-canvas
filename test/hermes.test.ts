import { describe, expect, jest, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import {
  type CanvasEvent,
  createSessionRow,
  defaultModel,
  hermesBin,
  hermesHome,
  listFolders,
  listModels,
  mapMessages,
  mapOutcome,
  mapSession,
  parseModel,
  prettyToolText,
  projectIDFor,
  projectNameFor,
  searchSessions,
  sessionDir,
  sessionMessages,
  setSessionYolo,
  startWatcher,
} from "../src/server/hermes"
import { makeHermesHome } from "./helpers"

describe("hermes row mapping", () => {
  test("splits provider/model and maps tokens, cost, project", () => {
    const s = mapSession({
      id: "abc", source: "cli", model: "google/gemma-4-12b", billing_provider: "google",
      parent_session_id: null, started_at: 1000, ended_at: 1100, end_reason: "cli_close",
      message_count: 4, input_tokens: 10, output_tokens: 20, reasoning_tokens: 3,
      cache_read_tokens: 40, cache_write_tokens: 5, cwd: "/repo/x", git_repo_root: "/repo/x",
      estimated_cost_usd: 0.02, actual_cost_usd: null, title: "Hi", archived: 0, hidden: 0,
    })
    expect(s.model).toMatchObject({ id: "gemma-4-12b", providerID: "google" })
    expect(s.tokens).toMatchObject({ input: 10, output: 20, reasoning: 3 })
    expect(s.tokens.cache).toMatchObject({ read: 40, write: 5 })
    expect(s.cost).toBeCloseTo(0.02)
    expect(s.outcome).toBe("succeeded")
    expect(s.time.created).toBe(1_000_000)
    expect(s.projectID).toBe(projectIDFor("/repo/x"))
    expect(s.location.directory).toBe("/repo/x")
  })

  test("open sessions stay outcome-less and idle at the last message", () => {
    const s = mapSession({
      id: "abc", source: "a2a", model: null, billing_provider: "custom",
      parent_session_id: null, started_at: 1000, ended_at: null, end_reason: null,
      message_count: 1, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, cwd: null, git_repo_root: null,
      estimated_cost_usd: null, actual_cost_usd: null, title: null, archived: 0, hidden: 0,
    }, { lastMsgAt: 2_000_000 })
    expect(s.outcome).toBeUndefined()
    expect(s.time.idle).toBe(2_000_000)
    expect(s.model?.providerID).toBe("custom")
  })

  test("running sessions have no idle marker", () => {
    const s = mapSession({
      id: "abc", source: "cli", model: "m", billing_provider: null,
      parent_session_id: null, started_at: 1000, ended_at: null, end_reason: null,
      message_count: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, cwd: "/r", git_repo_root: null,
      estimated_cost_usd: null, actual_cost_usd: null, title: null, archived: 0, hidden: 0,
    }, { running: true })
    expect(s.time.idle).toBeUndefined()
  })

  test("parseModel falls back to billing provider", () => {
    expect(parseModel("", "custom")).toMatchObject({ providerID: "custom" })
    expect(parseModel(null, null).id).toBe("hermes")
  })

  test("folds tool rows into the assistant turn that issued them", () => {
    const msgs = mapMessages(
      [
        { id: 3, role: "tool", content: "out", tool_call_id: "call_1", tool_calls: null, tool_name: "terminal", timestamp: 3, finish_reason: null, reasoning: null },
        { id: 2, role: "assistant", content: "doing", tool_call_id: null, tool_calls: JSON.stringify([{ call_id: "call_1", function: { name: "terminal", arguments: "{}" } }]), tool_name: null, timestamp: 2, finish_reason: "tool_calls", reasoning: null },
        { id: 1, role: "user", content: "hi", tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 1, finish_reason: null, reasoning: null },
      ],
      "cli",
      { id: "m", providerID: "custom" },
    )
    expect(msgs.map((m) => m.type)).toEqual(["assistant", "user"])
    const a = msgs[0]
    expect(a.content[0]).toMatchObject({ type: "text", text: "doing" })
    expect(a.content[1]).toMatchObject({ type: "tool", id: "call_1", name: "terminal" })
    expect(a.content[1].state.content[0].text).toBe("out")
  })

  // ---- T34: the envelope branches the fold test never reaches. ----

  test("prettyToolText unwraps output and error envelopes", () => {
    expect(prettyToolText('{"output": "hello", "exit_code": 0}')).toBe("hello")
    expect(prettyToolText('{"error": "boom"}')).toBe("error: boom")
    expect(prettyToolText('{"output": ""}')).toBe('{"output": ""}') // empty output is not truthy: raw stays
    expect(prettyToolText('{"nested": 1}')).toBe('{"nested": 1}') // no output/error keys: raw stays
    expect(prettyToolText("{not json}")).toBe("{not json}") // parse throws: fall through
    expect(prettyToolText("plain text")).toBe("plain text")
  })

  test("malformed tool_calls JSON degrades to no tools", () => {
    const base = (tool_calls: string | null) => ({
      id: 2, role: "assistant", content: "hi", tool_call_id: null, tool_calls, tool_name: null,
      timestamp: 2, finish_reason: null, reasoning: null,
    })
    const opts = { id: "m", providerID: "custom" }
    expect(mapMessages([base("{oops") as any], "cli", opts)[0].content).toEqual([{ type: "text", text: "hi" }])
    expect(mapMessages([base('"a string"') as any], "cli", opts)[0].content).toEqual([{ type: "text", text: "hi" }])
    expect(mapMessages([base("[]") as any], "cli", opts)[0].content).toEqual([{ type: "text", text: "hi" }])
  })

  test("bad tool arguments become a capped raw stub", () => {
    const row = (args: string) => ({
      id: 2, role: "assistant", content: null, tool_call_id: null, tool_name: null, timestamp: 2,
      finish_reason: null, reasoning: null,
      tool_calls: JSON.stringify([{ call_id: "c1", function: { name: "shell", arguments: args } }]),
    })
    const msgs = mapMessages([row("{bad") as any], "cli", { id: "m", providerID: "custom" })
    expect(msgs[0].content[0].state.input).toEqual({ _raw: "{bad" })
    const long = mapMessages([row("x".repeat(2500)) as any], "cli", { id: "m", providerID: "custom" })
    expect(long[0].content[0].state.input._raw).toHaveLength(2000) // capped raw
  })

  test("finish reasons other than stop/tool_calls are surfaced", () => {
    const row = (finish_reason: string | null, reasoning: string | null = null) => ({
      id: 2, role: "assistant", content: "cut", tool_call_id: null, tool_calls: null, tool_name: null,
      timestamp: 2, finish_reason, reasoning,
    })
    const opts = { id: "m", providerID: "custom" }
    expect(mapMessages([row("length") as any], "cli", opts)[0].finish).toBe("length")
    expect(mapMessages([row("stop") as any], "cli", opts)[0].finish).toBeUndefined()
    expect(mapMessages([row("tool_calls") as any], "cli", opts)[0].finish).toBeUndefined()
    const withReasoning = mapMessages([row("length", "why") as any], "cli", opts)
    expect(withReasoning[0].content.map((p: any) => p.type)).toEqual(["reasoning", "text"])
  })

  test("orphan tool rows wrap themselves with fallback id and name", () => {
    const opts = { id: "m", providerID: "custom" }
    const orphan = mapMessages(
      [{ id: 5, role: "tool", content: '{"output": "late"}', tool_call_id: "lost_1", tool_name: null, tool_calls: null, timestamp: 5, finish_reason: null, reasoning: null } as any],
      "cli", opts,
    )
    expect(orphan).toHaveLength(1)
    expect(orphan[0].type).toBe("assistant") // its own wrapper, id hma_t_5
    expect(orphan[0].id).toBe("hma_t_5")
    expect(orphan[0].content[0]).toMatchObject({ type: "tool", id: "lost_1", name: "tool" })
    expect(orphan[0].content[0].state.content[0].text).toBe("late") // envelope unwrapped too
    const named = mapMessages(
      [{ id: 9, role: "tool", content: "x", tool_call_id: null, tool_name: "grep", tool_calls: null, timestamp: 9, finish_reason: null, reasoning: null } as any],
      "cli", opts,
    )
    expect(named[0].content[0]).toMatchObject({ id: "hm_9", name: "grep" })
  })

  test("system and unknown roles become system messages", () => {
    const row = (id: number, role: string) => ({
      id, role, content: role === "system" ? "sys" : "?", tool_call_id: null, tool_calls: null,
      tool_name: null, timestamp: id, finish_reason: null, reasoning: null,
    })
    const msgs = mapMessages([row(3, "system"), row(2, "weird"), row(1, "user")] as any, "cli", { id: "m", providerID: "custom" })
    expect(msgs.map((m) => m.type)).toEqual(["system", "system", "user"])
    expect(msgs[0]).toMatchObject({ role: "system", text: "sys" })
    expect(msgs[1]).toMatchObject({ role: "weird", text: "?" })
  })
})

describe("project grouping", () => {
  test("sessionDir prefers the git root, then cwd, then a per-source folder", () => {
    expect(sessionDir({ git_repo_root: "/repo", cwd: "/repo/sub", source: "cli" })).toBe("/repo")
    expect(sessionDir({ git_repo_root: null, cwd: "/repo/sub", source: "cli" })).toBe("/repo/sub")
    expect(sessionDir({ git_repo_root: null, cwd: null, source: "cli" })).toBe(join(homedir(), "hermes-cli"))
    expect(sessionDir({ git_repo_root: null, cwd: null, source: null })).toBe(join(homedir(), "hermes"))
  })

  test("projectNameFor is the folder name, on either separator style", () => {
    expect(projectNameFor("/repo/storefront-web")).toBe("storefront-web")
    expect(projectNameFor("C:\\repos\\storefront-web")).toBe("storefront-web")
    expect(projectNameFor("/repo/storefront-web/")).toBe("storefront-web") // trailing slash
  })

  test("generated hermes-* folders are named by source instead", () => {
    expect(projectNameFor("/home/u/hermes-cli", "cli")).toBe("hermes/cli")
    expect(projectNameFor("/home/u/hermes-cli", null)).toBe("hermes")
    expect(projectNameFor("", "chat")).toBe("hermes/chat")
  })

  test("a session's project name comes from its git root", () => {
    const s = mapSession({
      id: "abc", source: "cli", model: null, billing_provider: null,
      parent_session_id: null, started_at: 1000, ended_at: null, end_reason: null,
      message_count: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, cwd: "/repo/storefront-web/apps/web",
      git_repo_root: "/repo/storefront-web", estimated_cost_usd: null, actual_cost_usd: null,
      title: null, archived: 0, hidden: 0,
    })
    expect(s.location.directory).toBe("/repo/storefront-web")
    expect(projectNameFor(s.location.directory, "cli")).toBe("storefront-web")
  })
})

describe("hermesHome", () => {
  // Windows-only branch (the LOCALAPPDATA default, T53). Skipped elsewhere
  // rather than faked: process.platform is not injectable.
  test.skipIf(process.platform !== "win32")("defaults under LOCALAPPDATA, falling back to homedir", () => {
    const savedHome = process.env.HERMES_HOME
    const savedLa = process.env.LOCALAPPDATA
    try {
      delete process.env.HERMES_HOME
      process.env.LOCALAPPDATA = "C:\\Users\\tester\\AppData\\Local"
      expect(hermesHome()).toBe(join("C:\\Users\\tester\\AppData\\Local", "hermes"))
      delete process.env.LOCALAPPDATA // no LOCALAPPDATA: falls back under homedir
      expect(hermesHome()).toBe(join(homedir(), "AppData", "Local", "hermes"))
    } finally {
      if (savedHome !== undefined) process.env.HERMES_HOME = savedHome
      else delete process.env.HERMES_HOME
      if (savedLa !== undefined) process.env.LOCALAPPDATA = savedLa
      else delete process.env.LOCALAPPDATA
    }
  })
})

describe("createSessionRow", () => {
  test("untitled canvas sessions do not collide on the unique title index", () => {
    makeHermesHome()
    const a = createSessionRow("/repo/a")
    const b = createSessionRow("/repo/b")
    expect(a.id).not.toBe(b.id)
    // The Hermes schema has `CREATE UNIQUE INDEX ... ON sessions(title)
    // WHERE title IS NOT NULL`; a shared default title made the second
    // canvas session a 500. New sessions stay untitled (the UI shows
    // "New session") so the partial index ignores them.
    expect(a.title).toBeUndefined()
    expect(b.title).toBeUndefined()

    const yolo = createSessionRow("/repo/y", "custom/m", "Yolo", true)
    expect(yolo.title).toBe("Yolo")
    expect(yolo.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
  })
})

describe("store edge fixes (outcomes, FTS, folders, config, watcher)", () => {
  test("mapOutcome classifies failure, interrupt, and success end_reasons", () => {
    expect(mapOutcome("cli_close")).toBe("succeeded")
    expect(mapOutcome("error")).toBe("failed")
    expect(mapOutcome("crash_timeout")).toBe("failed")
    expect(mapOutcome("interrupted")).toBe("interrupted")
    expect(mapOutcome("cancelled_by_user")).toBe("interrupted")
    expect(mapOutcome("sigint")).toBe("interrupted")
    const s = mapSession({
      id: "y1", source: "cli", model: null, billing_provider: null, parent_session_id: null,
      started_at: 100, ended_at: 200, end_reason: "error", message_count: 0,
      input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      cwd: "/r", git_repo_root: null, estimated_cost_usd: null, actual_cost_usd: null, title: null, archived: 1, hidden: 0,
    }, { yolo: true })
    expect(s.outcome).toBe("failed")
    expect(s.time.archived).toBe(200_000)
    expect(s.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
    setSessionYolo("y_live", true)
    expect(mapSession({
      id: "y_live", source: "cli", model: null, billing_provider: null, parent_session_id: null,
      started_at: 100, ended_at: null, end_reason: null, message_count: 0,
      input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      cwd: "/r", git_repo_root: null, estimated_cost_usd: null, actual_cost_usd: null, title: null, archived: 0, hidden: 0,
    }).permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
    setSessionYolo("y_live", false)
  })

  test("mapMessages uses deterministic timestamp when timestamp is null", () => {
    const msgs = mapMessages(
      [
        { id: 2, role: "assistant", content: "hi", tool_call_id: null, tool_calls: null, tool_name: null, timestamp: null, finish_reason: null, reasoning: null },
        { id: 1, role: "user", content: "hey", tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 12, finish_reason: null, reasoning: null },
      ],
      "cli",
      { id: "m", providerID: "p" },
    )
    expect(msgs[0].time.created).toBe(12_000)
    expect(msgs[1].time.created).toBe(12_000)

    const noTs = mapMessages(
      [{ id: 1, role: "user", content: "x", tool_call_id: null, tool_calls: null, tool_name: null, timestamp: null, finish_reason: null, reasoning: null }],
      "cli",
      { id: "m", providerID: "p" },
    )
    expect(noTs[0].time.created).toBe(0)
  })

  test("sessionMessages rejects non-numeric cursor", () => {
    makeHermesHome()
    expect(() => sessionMessages("ses_new_1", 10, "not-a-number")).toThrow(RangeError)
    expect(() => sessionMessages("ses_new_1", 10, "-5")).toThrow(RangeError)
  })

  test("searchSessions supports FTS5 messages_fts and falls back safely on LIKE wildcards", () => {
    const savedDb = process.env.HERMES_CANVAS_DB
    const tmp = mkdtempSync(join(tmpdir(), "hermes-fts-"))
    const dbFile = join(tmp, "state.db")
    const db = new Database(dbFile, { create: true })
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, model TEXT, billing_provider TEXT,
        parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
        message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        cwd TEXT, git_repo_root TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
        title TEXT, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0, created_source TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
        finish_reason TEXT, reasoning TEXT
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(session_id UNINDEXED, content);
    `)
    db.prepare("INSERT INTO sessions (id, source, started_at, title) VALUES (?, 'cli', ?, ?)").run("ses_fts", 200, "Ordinary Title")
    db.prepare("INSERT INTO sessions (id, source, started_at, title) VALUES (?, 'cli', ?, ?)").run("ses_pct", 100, "100% real_match")
    db.prepare("INSERT INTO sessions (id, source, started_at, title) VALUES (?, 'cli', ?, ?)").run("ses_wild", 90, "1000x realxmatch")
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)").run("ses_fts", "xylophone telemetry", 200)
    db.prepare("INSERT INTO messages_fts (session_id, content) VALUES (?, ?)").run("ses_fts", "xylophone telemetry")
    db.close()

    process.env.HERMES_CANVAS_DB = dbFile
    try {
      const viewed = new Map([["ses_fts", 999]])
      const running = new Set(["ses_fts"])
      const ftsHits = searchSessions("xylophone", 50, viewed, running)
      expect(ftsHits.map((s) => s.id)).toEqual(["ses_fts"])
      expect(ftsHits[0].time.viewed).toBe(999)
      expect(ftsHits[0].time.idle).toBeUndefined()

      // Invalid FTS5 syntax ("100% real_") falls back to LIKE and must NOT match wildcards against ses_wild.
      const likeHits = searchSessions("100% real_", 50)
      expect(likeHits.map((s) => s.id)).toEqual(["ses_pct"])
    } finally {
      if (savedDb === undefined) delete process.env.HERMES_CANVAS_DB
      else process.env.HERMES_CANVAS_DB = savedDb
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test("listFolders filters non-dirs, sorts entries, and validates paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hermes-folders-"))
    try {
      mkdirSync(join(tmp, "zeta"))
      mkdirSync(join(tmp, "alpha"))
      writeFileSync(join(tmp, "file.txt"), "hi")
      expect(listFolders(tmp)).toEqual([join(tmp, "alpha"), join(tmp, "zeta")])
      expect(() => listFolders("")).toThrow("missing path")
      expect(() => listFolders(join(tmp, "file.txt"))).toThrow("not a directory")
      if (process.platform === "win32") {
        expect(Array.isArray(listFolders("C:"))).toBe(true)
      }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test("config.yaml handles CRLF, quotes, inline comments, and model scoping", () => {
    const savedHome = process.env.HERMES_HOME
    const tmp = mkdtempSync(join(tmpdir(), "hermes-yaml-"))
    try {
      process.env.HERMES_HOME = tmp
      writeFileSync(
        join(tmp, "config.yaml"),
        [
          "other_section:",
          "  default: should/ignore # not inside model:",
          "model:",
          '  default: "google/gemma-4-12b" # primary default',
          "custom_providers:",
          "  - name: 'myprov' # inline comment",
          "    models:",
          "      # disabled: {}",
          "      fast-1: {} # comment",
          '      "quoted-2": {}',
          "trailing: true",
          "",
        ].join("\r\n"),
      )
      expect(defaultModel()).toEqual({ id: "gemma-4-12b", providerID: "google", name: "google/gemma-4-12b" })
      const models = listModels()
      expect(models).toContainEqual({ id: "fast-1", providerID: "myprov", name: "myprov/fast-1" })
      expect(models).toContainEqual({ id: "quoted-2", providerID: "myprov", name: "myprov/quoted-2" })
      expect(models.some((m) => m.id.includes("disabled"))).toBe(false)
    } finally {
      if (savedHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = savedHome
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  test("hermesBin falls back when HERMES_BIN is whitespace", () => {
    const saved = process.env.HERMES_BIN
    try {
      process.env.HERMES_BIN = "   "
      expect(hermesBin()).toBe("hermes")
    } finally {
      if (saved === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = saved
    }
  })

  test("startWatcher primes empty DBs, diffs renames/models/outcomes/deletes, and deduplicates local creates", () => {
    const savedDb = process.env.HERMES_CANVAS_DB
    const tmp = mkdtempSync(join(tmpdir(), "hermes-watch-"))
    const dbFile = join(tmp, "state.db")
    const db = new Database(dbFile, { create: true })
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, model TEXT, billing_provider TEXT,
        parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
        message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        cwd TEXT, git_repo_root TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
        title TEXT, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0, created_source TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
        finish_reason TEXT, reasoning TEXT
      );
    `)
    process.env.HERMES_CANVAS_DB = dbFile

    jest.useFakeTimers()
    const events: CanvasEvent[] = []
    const stopW = startWatcher((ev) => events.push(ev), 1000)
    try {
      // Starting on an empty DB must still detect the first external session created afterwards.
      db.prepare("INSERT INTO sessions (id, source, started_at, cwd, title, model) VALUES (?, 'cli', ?, '/repo/e', 'First', 'custom/m1')").run("ses_e1", 100)
      jest.advanceTimersByTime(1000)
      expect(events.map((e) => e.type)).toEqual(["session.created"])

      // Local createSessionRow suppresses duplicate session.created from the watcher.
      events.length = 0
      const local = createSessionRow("/repo/local")
      jest.advanceTimersByTime(1000)
      expect(events).toHaveLength(0)

      // External rename + model change + failed ending emit granular events.
      events.length = 0
      db.prepare("UPDATE sessions SET title = ?, model = ?, ended_at = ?, end_reason = ? WHERE id = ?").run(
        "Renamed", "google/gemma-4-12b", 200, "error", "ses_e1",
      )
      jest.advanceTimersByTime(1000)
      expect(events.map((e) => e.type)).toEqual([
        "session.renamed",
        "session.model.selected",
        "session.execution.failed",
      ])

      // Archiving emits session.deleted.
      events.length = 0
      db.prepare("UPDATE sessions SET archived = 1 WHERE id = ?").run(local.id)
      jest.advanceTimersByTime(1000)
      expect(events.map((e) => e.type)).toEqual(["session.deleted"])
    } finally {
      stopW()
      jest.useRealTimers()
      db.close()
      if (savedDb === undefined) delete process.env.HERMES_CANVAS_DB
      else process.env.HERMES_CANVAS_DB = savedDb
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Build an isolated HERMES_HOME with a seeded state.db; point env at it. */
export function makeHermesHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hermes-canvas-test-"))
  const db = new Database(join(home, "state.db"), { create: true })
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
  const t = Date.now() / 1000
  const addSession = db.prepare(
    `INSERT INTO sessions (id, source, model, billing_provider, started_at, cwd, git_repo_root, title, estimated_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  addSession.run("ses_new_1", "cli", "custom/deepseek-v4.1-flash", "custom", t - 60, "/repo/alpha", "/repo/alpha", "Alpha session", 0.01)
  addSession.run("ses_old_1", "cli", "google/gemma-4-12b", "google", t - 100000, "/repo/beta", null, "Beta session", 0.02)
  addSession.run("ses_arch_1", "cli", "custom/x", "custom", t - 50, "/repo/gamma", null, "Hidden", 0)
  db.exec(`UPDATE sessions SET archived = 1 WHERE id = 'ses_arch_1'`)
  const addMsg = db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  addMsg.run("ses_new_1", "user", "hello alpha", null, null, null, t - 60, null, null)
  addMsg.run(
    "ses_new_1", "assistant", "working on it",
    null,
    JSON.stringify([{ call_id: "call_1", type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "ls" }) } }]),
    null, t - 59, "tool_calls", "thinking hard",
  )
  addMsg.run("ses_new_1", "tool", '{"output":"a\nb","exit_code":0}', "call_1", null, "terminal", t - 58, null, null)
  addMsg.run("ses_old_1", "user", "hello beta", null, null, null, t - 100000, null, null)
  db.close()

  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, "config.yaml"),
    `model:\n  provider: custom\n  default: custom/deepseek-v4.1-flash\ncustom_providers:\n  - name: custom\n    models:\n      deepseek-v4.1-flash: {}\n`,
  )

  process.env.HERMES_HOME = home
  process.env.HERMES_CANVAS_DB = join(home, "state.db")
  process.env.HERMES_CANVAS_VIEWED = join(home, "canvas_viewed.json")
  process.env.HERMES_BIN = `bun ${join(import.meta.dir, "fake-hermes.ts")}`
  process.env.HERMES_CANVAS_PROMPT_CWD = home
  return home
}

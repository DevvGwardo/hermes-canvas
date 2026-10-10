import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import { mapMessages, mapSession, parseModel, projectIDFor, projectNameFor, sessionDir } from "../src/server/hermes"

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

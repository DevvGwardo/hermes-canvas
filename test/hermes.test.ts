import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import { mapMessages, mapSession, parseModel, prettyToolText, projectIDFor, projectNameFor, sessionDir } from "../src/server/hermes"

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

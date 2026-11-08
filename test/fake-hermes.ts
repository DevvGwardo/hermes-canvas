// Fake `hermes` executable for hermes-canvas tests (HERMES_BIN="bun fake-hermes.ts").
// Speaks just enough CLI + stream-json to exercise prompt/interrupt/rename.
//
//   HERMES_FAKE_MODE=fast       init + text + tool_use + tool_result + result, then exit 0
//   HERMES_FAKE_MODE=hang       init, then sleep 30s (lets tests exercise interrupt)
//   HERMES_FAKE_MODE=errtool    init + text + tool_use (no tool_call_id) + failing tool_result + result
//   HERMES_FAKE_MODE=malformed  init + garbage line + text + tool_use + tool_result + result
//   HERMES_FAKE_MODE=noresult   init + text + tool_use + tool_result, exit 0 without a result line
//   HERMES_FAKE_MODE=failresult init + text + result (exit_code 1), then exit 0
//   HERMES_FAKE_MODE=create     Session: stderr line + result with minted local id
//   HERMES_FAKE_MODE=notfound   result exit_code 1 with "No session found matching" stderr

export {}

const args = process.argv.slice(2)
const mode = process.env.HERMES_FAKE_MODE ?? "fast"

const emit = (o: unknown) => {
  process.stdout.write(JSON.stringify(o) + "\n")
}

if (args[0] === "sessions" && args[1] === "rename") {
  process.exit(0)
}

if (args[0] === "chat") {
  const qi = args.indexOf("-q")
  const query = qi >= 0 ? (args[qi + 1] ?? "") : ""
  const ri = args.indexOf("--resume")
  const sessionId = ri >= 0 ? (args[ri + 1] ?? "test-session") : "test-session"
  emit({ type: "system", subtype: "init", model: "fake/model", session_id: sessionId, timestamp: Date.now() })
  if (mode === "hang") {
    await new Promise((r) => setTimeout(r, 30_000))
    process.exit(0)
  }
  if (mode === "malformed") {
    process.stdout.write("this is not json {{{\n")
    process.stdout.write("\n")
  }
  if (mode === "create") {
    process.stderr.write("Session: local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
  }
  if (mode === "notfound") {
    emit({ type: "result", session_id: "", exit_code: 1, text: "", tokens: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 }, duration_ms: 50, error: "No session found matching 'ses_new_1'", timestamp: Date.now() })
    process.stderr.write(`No session found matching 'ses_new_1'.\n`)
    process.exit(1)
  }
  emit({ type: "text", text: `heard: ${query}`, timestamp: Date.now() })
  if (mode === "create") {
    emit({
      type: "result", session_id: "local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", exit_code: 0, text: `heard: ${query}`,
      tokens: { input: 10, output: 5, total: 15, cache_read: 0, cache_write: 0 },
      duration_ms: 50, timestamp: Date.now(),
    })
    process.exit(0)
  }
  if (mode === "errtool") {
    emit({ type: "tool_use", name: "terminal", input: { command: "false" }, timestamp: Date.now() })
    emit({ type: "tool_result", name: "terminal", output: "disk full: no space left", is_error: true, timestamp: Date.now() })
    emit({
      type: "result", session_id: sessionId, exit_code: 0, text: `heard: ${query}`,
      tokens: { input: 10, output: 5, total: 15, cache_read: 0, cache_write: 0 },
      duration_ms: 50, timestamp: Date.now(),
    })
    process.exit(0)
  }
  if (mode === "failresult") {
    emit({
      type: "result", session_id: sessionId, exit_code: 1, text: `heard: ${query}`, error: "boom",
      tokens: { input: 10, output: 0, total: 10, cache_read: 0, cache_write: 0 },
      duration_ms: 50, timestamp: Date.now(),
    })
    process.exit(0)
  }
  emit({ type: "tool_use", name: "terminal", tool_call_id: "call_fake_1", input: { command: "echo hi" }, timestamp: Date.now() })
  emit({ type: "tool_result", name: "terminal", tool_call_id: "call_fake_1", output: "hi", duration_ms: 5, is_error: false, timestamp: Date.now() })
  if (mode === "noresult") {
    process.exit(0)
  }
  emit({
    type: "result", session_id: sessionId, exit_code: 0, text: `heard: ${query}`,
    tokens: { input: 10, output: 5, total: 15, cache_read: 0, cache_write: 0 },
    duration_ms: 50, timestamp: Date.now(),
  })
  process.exit(0)
}

console.error(`fake-hermes: unknown args ${args.join(" ")}`)
process.exit(2)

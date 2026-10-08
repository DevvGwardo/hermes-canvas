// Fake `hermes` executable for hermes-canvas tests (HERMES_BIN="bun fake-hermes.ts").
// Speaks just enough CLI + stream-json to exercise prompt/interrupt/rename.
//
//   HERMES_FAKE_MODE=fast  init + text + tool_use + tool_result + result, then exit 0
//   HERMES_FAKE_MODE=hang  init, then sleep 30s (lets tests exercise interrupt)

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
  emit({ type: "text", text: `heard: ${query}`, timestamp: Date.now() })
  emit({ type: "tool_use", name: "terminal", tool_call_id: "call_fake_1", input: { command: "echo hi" }, timestamp: Date.now() })
  emit({ type: "tool_result", name: "terminal", tool_call_id: "call_fake_1", output: "hi", duration_ms: 5, is_error: false, timestamp: Date.now() })
  emit({
    type: "result", session_id: sessionId, exit_code: 0, text: `heard: ${query}`,
    tokens: { input: 10, output: 5, total: 15, cache_read: 0, cache_write: 0 },
    duration_ms: 50, timestamp: Date.now(),
  })
  process.exit(0)
}

console.error(`fake-hermes: unknown args ${args.join(" ")}`)
process.exit(2)

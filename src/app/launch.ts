// Helpers for the launchpad: turn one typed task into a single Hermes session,
// or a lead session that fans the work out through Hermes' native
// `delegate_task` tool. Kept pure so the UI layer stays thin and testable.

export interface LaunchDestination {
  label: string
  directory: string
}

export interface MentionResult {
  /** The task text with a leading `@project` token removed. */
  text: string
  /** Set when the token matched one of the known destinations. */
  directory?: string
}

const TEAM_RULES = `

---

Hermes Canvas team launch. You are the lead agent for this task.

- Plan first, then split the work into independent subtasks. Use the delegate_task tool for the actual work, not just planning. Unless the task is trivially small, use at least two subagents, batching parallel tasks in one call where possible.
- Run subtasks in parallel only when they are independent; sequence work that would edit the same files or depend on another subtask's output.
- Give every subagent a self-contained goal and the context it needs; it starts with a fresh conversation and only returns its final summary.
- Verify and integrate the subagents' results instead of forwarding them blindly.
- Make reasonable assumptions and proceed; do not stop to ask for confirmation.
- Finish with a concise summary of what changed, where, and what remains.

If the delegate_task tool is unavailable, do the work directly.`

/** Wrap a task for a team launch without burying the user's own words. */
export function teamPrompt(text: string): string {
  const body = text.trim()
  return body ? `${body}${TEAM_RULES}` : ""
}

/** The exact prompt sent to a newly created session. */
export function launchPrompt(text: string, team: boolean): string {
  return team ? teamPrompt(text) : text.trim()
}

const base = (p: string) => p.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() ?? ""

/**
 * Read a leading `@project` (or `@folder-name`) token from a task.
 *
 * Only a token that matches a known destination is consumed, so prose and
 * reply handles are left alone. The label wins over the folder basename; a
 * unique prefix match is the last resort.
 */
export function parseMention(text: string, destinations: LaunchDestination[]): MentionResult {
  const raw = text.trim()
  const m = /^@([^\s]+)\s+([\s\S]+)$/.exec(raw)
  if (!m) return { text: raw }
  const token = m[1].toLowerCase()
  const task = m[2].trim()
  if (!task) return { text: raw }

  let hit = destinations.find((d) => d.label.toLowerCase() === token)
  if (!hit) hit = destinations.find((d) => base(d.directory) === token)
  if (!hit) {
    const prefixed = destinations.filter(
      (d) => d.label.toLowerCase().startsWith(token) || base(d.directory).startsWith(token),
    )
    if (prefixed.length === 1) hit = prefixed[0]
  }
  return hit ? { text: task, directory: hit.directory } : { text: raw }
}

/** Short task description for the launch strip (first line, trimmed). */
export function missionLabel(text: string, max = 46): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ""
  if (!line) return "Untitled task"
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 46
  if (cap === 0) return ""
  if (line.length <= cap) return line
  if (cap === 1) return "…"
  return `${line.slice(0, cap - 1).trimEnd()}…`
}

import { describe, expect, it } from "bun:test"
import { launchPrompt, missionLabel, parseMention, teamPrompt } from "../src/app/launch"

const groups = [
  { label: "hermes-canvas", directory: "/home/t/code/hermes-canvas" },
  { label: "hermes-ui", directory: "/home/t/code/hermes-ui" },
  { label: "dotfiles", directory: "/home/t/dotfiles" },
  { label: "billing-service", directory: "/home/t/work/billing-service" },
]

describe("teamPrompt", () => {
  it("keeps the user's task first so it drives the session title", () => {
    const out = teamPrompt("Fix the failing layout tests")
    expect(out.startsWith("Fix the failing layout tests")).toBe(true)
    expect(out).toContain("delegate_task")
    expect(out).toContain("subagents")
  })

  it("trims surrounding whitespace but leaves the body intact", () => {
    const out = teamPrompt("  ship it  ")
    expect(out.startsWith("ship it\n")).toBe(true)
  })

  it("returns empty string for empty or whitespace-only tasks", () => {
    expect(teamPrompt("")).toBe("")
    expect(teamPrompt("   \n\t ")).toBe("")
  })
})

describe("launchPrompt", () => {
  it("adds team rules only in team mode", () => {
    expect(launchPrompt("do work", false)).toBe("do work")
    expect(launchPrompt("do work", true)).toContain("delegate_task")
  })

  it("returns empty string for blank tasks in either mode", () => {
    expect(launchPrompt("   ", true)).toBe("")
    expect(launchPrompt("   ", false)).toBe("")
  })
})

describe("parseMention", () => {
  it("strips a matching project label and returns its directory", () => {
    expect(parseMention("@hermes-canvas fix the tests", groups)).toEqual({
      text: "fix the tests",
      directory: "/home/t/code/hermes-canvas",
    })
  })

  it("matches labels case-insensitively and by folder name", () => {
    expect(parseMention("@HERMES-CANVAS fix", groups).directory).toBe("/home/t/code/hermes-canvas")
    expect(parseMention("@billing-service audit", groups).directory).toBe("/home/t/work/billing-service")
  })

  it("accepts a unique prefix", () => {
    expect(parseMention("@billing audit", groups)).toEqual({
      text: "audit",
      directory: "/home/t/work/billing-service",
    })
  })

  it("leaves ambiguous or unknown handles alone", () => {
    expect(parseMention("@h fix", groups)).toEqual({ text: "@h fix" })
    expect(parseMention("@nobody fix", groups)).toEqual({ text: "@nobody fix" })
    expect(parseMention("email @here please", groups)).toEqual({ text: "email @here please" })
  })

  it("does not consume a mention with no task after it", () => {
    expect(parseMention("@hermes-canvas", groups)).toEqual({ text: "@hermes-canvas" })
    expect(parseMention("@hermes-canvas   ", groups)).toEqual({ text: "@hermes-canvas" })
  })

  it("handles Windows backslash paths and single-destination label/folder prefix overlap", () => {
    const winGroups = [
      { label: "Alpha App", directory: "C:\\Users\\dev\\code\\alpha-repo\\" },
      { label: "Beta", directory: "D:\\work\\beta" },
    ]
    expect(parseMention("@alpha-repo ship it", winGroups)).toEqual({
      text: "ship it",
      directory: "C:\\Users\\dev\\code\\alpha-repo\\",
    })
    expect(parseMention("@alp check status", winGroups)).toEqual({
      text: "check status",
      directory: "C:\\Users\\dev\\code\\alpha-repo\\",
    })
  })
})

describe("missionLabel", () => {
  it("uses the first line and caps long labels", () => {
    expect(missionLabel("Fix the tests\nand then deploy")).toBe("Fix the tests")
    expect(missionLabel("Line one\r\nLine two")).toBe("Line one")
    expect(missionLabel("x".repeat(80))).toHaveLength(46)
    expect(missionLabel("   ")).toBe("Untitled task")
  })

  it("handles small or non-finite max bounds cleanly", () => {
    expect(missionLabel("abcdef", 0)).toBe("")
    expect(missionLabel("abcdef", -3)).toBe("")
    expect(missionLabel("abcdef", 1)).toBe("…")
    expect(missionLabel("a", 1)).toBe("a")
    expect(missionLabel("x".repeat(80), Number.NaN)).toHaveLength(46)
  })
})

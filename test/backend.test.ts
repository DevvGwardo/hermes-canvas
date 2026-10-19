import { describe, expect, it } from "bun:test"
import type { FileAttachment } from "../src/app/types"
import { attachmentSrc } from "../src/app/backend"

// T53: attachmentSrc is the transcript's file-src resolver (transcript.ts
// maps message files through it when rendering attachments). It had zero
// coverage - the panel's chips read a.uri directly, so the uri-source and
// inline-base64 branches were pinned by nothing.

const f = (over: Partial<FileAttachment> = {}): FileAttachment =>
  ({ name: "a.png", mime: "image/png", ...over }) as FileAttachment

describe("attachmentSrc", () => {
  it("prefers the direct uri", () => {
    expect(attachmentSrc(f({ uri: "file:///x/a.png" }))).toBe("file:///x/a.png")
  })

  it("falls back to a uri-typed source", () => {
    expect(attachmentSrc(f({ source: { type: "uri", uri: "https://h/i.png" } }))).toBe("https://h/i.png")
  })

  it("builds a data uri from inline base64", () => {
    expect(attachmentSrc(f({ data: "QUFB" }))).toBe("data:image/png;base64,QUFB")
  })

  it("resolves to undefined when there is nothing to resolve", () => {
    expect(attachmentSrc(f())).toBeUndefined()
  })
})

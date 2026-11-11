import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { toast } from "../src/app/toast"

class FakeEl {
  tag: string
  className = ""
  textContent = ""
  attrs: Record<string, string> = {}
  children: FakeEl[] = []
  parentElement: FakeEl | null = null
  ownerDocument: any

  constructor(tag: string, ownerDocument?: any) {
    this.tag = tag
    this.ownerDocument = ownerDocument
  }

  get isConnected() {
    let cur: FakeEl | null = this
    while (cur.parentElement) cur = cur.parentElement
    return cur === this.ownerDocument?.body || cur.tag === "body"
  }

  get classList() {
    const self = this
    return {
      add: (...cs: string[]) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const c of cs) s.add(c)
        self.className = [...s].join(" ")
      },
      remove: (...cs: string[]) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const c of cs) s.delete(c)
        self.className = [...s].join(" ")
      },
      contains: (c: string) => self.className.split(/\s+/).includes(c),
    }
  }

  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }

  append(...nodes: FakeEl[]) {
    for (const n of nodes) {
      n.remove()
      n.parentElement = this
      this.children.push(n)
    }
  }

  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
    this.parentElement = null
  }
}

function makeDoc() {
  const doc: any = {
    createElement: (tag: string) => new FakeEl(tag, doc),
  }
  doc.body = new FakeEl("body", doc)
  return doc
}

let savedDoc: unknown
let savedRaf: unknown
let rafQueue: Array<() => void> = []

beforeEach(() => {
  jest.useFakeTimers()
  savedDoc = (globalThis as any).document
  savedRaf = (globalThis as any).requestAnimationFrame
  ;(globalThis as any).document = makeDoc()
  rafQueue = []
  ;(globalThis as any).requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
})

afterEach(() => {
  ;(globalThis as any).document = savedDoc
  ;(globalThis as any).requestAnimationFrame = savedRaf
  jest.useRealTimers()
})

describe("toast", () => {
  it("creates a polite status host on document.body, animates in, and removes after timeout", () => {
    toast("Saved", 1200)
    const body = (globalThis as any).document.body as FakeEl
    expect(body.children).toHaveLength(1)
    const host = body.children[0]!
    expect(host.className).toBe("toasts")
    expect(host.attrs["role"]).toBe("status")
    expect(host.attrs["aria-live"]).toBe("polite")
    expect(host.children).toHaveLength(1)
    const item = host.children[0]!
    expect(item.textContent).toBe("Saved")
    expect(item.classList.contains("in")).toBe(false)

    rafQueue.splice(0).forEach((fn) => fn())
    expect(item.classList.contains("in")).toBe(true)

    jest.advanceTimersByTime(1200)
    expect(item.classList.contains("in")).toBe(false)
    expect(host.children).toHaveLength(1) // exit fade runs for 300ms

    jest.advanceTimersByTime(300)
    expect(host.children).toHaveLength(0)
  })

  it("re-attaches a fresh host when document or body changes or previous host was detached", () => {
    toast("First doc")
    const firstBody = (globalThis as any).document.body as FakeEl
    expect(firstBody.children).toHaveLength(1)

    // Detached/cleared body on the same document recovers cleanly.
    firstBody.children[0]!.remove()
    toast("Recovered")
    expect(firstBody.children).toHaveLength(1)
    expect(firstBody.children[0]!.children[0]!.textContent).toBe("Recovered")

    // Switching to a fresh document stub (like isolated test suites or DOM rebuilds) creates a host in the new document.
    const nextDoc = makeDoc()
    ;(globalThis as any).document = nextDoc
    toast("Second doc")
    expect(nextDoc.body.children).toHaveLength(1)
    expect(nextDoc.body.children[0]!.children[0]!.textContent).toBe("Second doc")
  })

  it("caps concurrent toasts at 5 by evicting the oldest", () => {
    for (let i = 1; i <= 7; i++) toast(`Notice ${i}`, 5000)
    const body = (globalThis as any).document.body as FakeEl
    const host = body.children[0]!
    expect(host.children.map((c) => c.textContent)).toEqual([
      "Notice 3",
      "Notice 4",
      "Notice 5",
      "Notice 6",
      "Notice 7",
    ])
  })

  it("adds .in immediately when requestAnimationFrame is unavailable and no-ops without document.body", () => {
    delete (globalThis as any).requestAnimationFrame
    toast("No rAF")
    const body = (globalThis as any).document.body as FakeEl
    expect(body.children[0]!.children[0]!.classList.contains("in")).toBe(true)

    ;(globalThis as any).document = { createElement: () => new FakeEl("div"), body: null }
    expect(() => toast("No body")).not.toThrow()

    delete (globalThis as any).document
    expect(() => toast("No document")).not.toThrow()
  })
})

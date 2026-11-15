/*
 * Minimal stand-ins for the DOM pieces the Settings scroll code touches, so it runs under the node test
 * environment: a scroller with sections, rows, an event surface, a ResizeObserver and rAF.
 */

// -- Test Imports --
import { vi } from "vitest";

export type Listener = (e: unknown) => void;

export class FakeSurface {
  listeners = new Map<string, Set<Listener>>();
  addEventListener = (name: string, fn: Listener) => {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  };
  removeEventListener = (name: string, fn: Listener) => {
    this.listeners.get(name)?.delete(fn);
  };
  fire(name: string, event: unknown = {}) {
    this.listeners.get(name)?.forEach((fn) => fn(event));
  }
  count(name: string): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}

export class FakeObserver {
  static all: FakeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(public callback: () => void) {
    FakeObserver.all.push(this);
  }
  observe(el: unknown) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  static fireAll() {
    FakeObserver.all.filter((o) => !o.disconnected).forEach((o) => o.callback());
  }
}

/** A row or section element with a fixed top. */
export function fakeEl(top: number, extra: Record<string, unknown> = {}) {
  return {
    getBoundingClientRect: () => ({ top }),
    dataset: {} as Record<string, string>,
    ...extra,
  };
}

/** A scroller whose sections sit at the given tops (null leaves a section absent). */
export function fakeViewport(sectionTops: Record<string, number | null> = {}) {
  const surface = new FakeSurface();
  const own = new FakeSurface();
  const tops = new Map<string, number>();
  for (const [id, top] of Object.entries(sectionTops)) if (top != null) tops.set(id, top);
  // A section's rect follows the scroll position, as a real one does.
  const sections = {
    get: (id: string) =>
      tops.has(id) ? fakeEl(0, { getBoundingClientRect: () => ({ top: tops.get(id)! - viewport.scrollTop }) }) : undefined,
  };
  const setTop = (id: string, top: number) => tops.set(id, top);
  const viewport = {
    scrollTop: 0,
    clientHeight: 500,
    scrollHeight: 3000,
    parentElement: surface,
    firstElementChild: { name: "content" },
    scrollTo: vi.fn(),
    contains: (el: unknown) => el != null,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: (sel: string) => sections.get(/"(\w+)"/.exec(sel)?.[1] ?? "") ?? null,
    addEventListener: own.addEventListener,
    removeEventListener: own.removeEventListener,
  };
  return { viewport: viewport as unknown as HTMLElement & typeof viewport, surface, own, setTop };
}

/** Installs the globals the scroll code reads. Call unstub with vi.unstubAllGlobals(). */
export function stubBrowser(opts: { reduced?: boolean; rows?: Record<string, unknown> } = {}) {
  const rows = opts.rows ?? {};
  const doc = new FakeSurface();
  FakeObserver.all = [];
  const frames: Array<() => void> = [];
  vi.stubGlobal("document", {
    getElementById: (id: string) => rows[id] ?? null,
    addEventListener: doc.addEventListener,
    removeEventListener: doc.removeEventListener,
    activeElement: null,
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: !!opts.reduced }) });
  vi.stubGlobal("ResizeObserver", FakeObserver);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return { rows, doc, runFrames: () => frames.splice(0).forEach((fn) => fn()) };
}

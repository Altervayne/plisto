// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createThumbs, thumbKey, type ThumbDeps, type ThumbEntry } from "./thumbs";
import { thumbEntries } from "./useKindThumbs";

// -- State Imports --
import { manifest, row, visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";

const ID = "com.example.rings/aurora-rings";

const entry = (sig: string): ThumbEntry => ({
  id: ID,
  pluginId: "com.example.rings",
  kindId: "aurora-rings",
  sig,
});

function setup(stored: ArrayBuffer | null = null, heldIds = new Set<string>()) {
  const urls: string[] = [];
  const revoked: string[] = [];
  const shown: Record<string, string | null> = {};
  let active = 0;
  let overlap = 0;
  const deps: ThumbDeps = {
    get: vi.fn(() => Promise.resolve(stored)),
    put: vi.fn(async () => {}),
    render: vi.fn(async () => {
      overlap = Math.max(overlap, ++active);
      await Promise.resolve();
      active -= 1;
      return new Uint8Array([1, 2, 3]);
    }),
    makeUrl: () => {
      const url = `blob:${urls.length}`;
      urls.push(url);
      return url;
    },
    revokeUrl: (url) => void revoked.push(url),
    publish: (key, url) => {
      shown[key] = url;
    },
    held: (id) => heldIds.has(id),
    later: (run) => void Promise.resolve().then(run),
  };
  return { deps, urls, revoked, shown, overlap: () => overlap, thumbs: createThumbs(deps) };
}

describe("plugin kind thumbnails", () => {
  it("renders, stores and shows a thumbnail per theme when none is stored", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(2);
    for (const theme of ["light", "dark"]) {
      expect(s.deps.put).toHaveBeenCalledWith(
        "com.example.rings",
        "aurora-rings",
        theme,
        expect.any(Uint8Array),
      );
    }
    expect(s.shown[thumbKey(ID, "light")]).toMatch(/^blob:/);
    expect(s.shown[thumbKey(ID, "dark")]).toMatch(/^blob:/);
    expect(s.overlap()).toBe(1);
  });

  it("shows a stored thumbnail without rendering", async () => {
    const s = setup(new ArrayBuffer(4));
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    expect(s.deps.render).not.toHaveBeenCalled();
    expect(s.deps.put).not.toHaveBeenCalled();
    expect(s.urls).toHaveLength(2);
  });

  it("renders again and revokes the old images when the build changes", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    const first = [...s.urls];
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(2);
    s.thumbs.sync([entry("2|b|9")]);
    expect(first.every((url) => s.revoked.includes(url))).toBe(true);
    expect(s.shown[thumbKey(ID, "light")]).toBeNull();
    await s.thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(4);
    expect(s.shown[thumbKey(ID, "dark")]).toMatch(/^blob:/);
  });

  it("never retries a kind with no still under the same build", async () => {
    const s = setup();
    s.deps.render = vi.fn(async () => null);
    const thumbs = createThumbs(s.deps);
    thumbs.sync([entry("1|a|1")]);
    await thumbs.idle();
    thumbs.sync([entry("1|a|1")]);
    await thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(2);
    expect(s.urls).toHaveLength(0);
  });

  it("drops the images of a kind that is gone", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    s.thumbs.sync([]);
    expect(s.revoked).toHaveLength(2);
    expect(s.shown[thumbKey(ID, "dark")]).toBeNull();
  });
});

describe("plugin kind thumbnails: nets, store and lifetime", () => {
  it("never mounts a held kind and leaves its tile on the glyph, then renders once it is free", async () => {
    const heldIds = new Set([ID]);
    const s = setup(null, heldIds);
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    expect(s.deps.get).not.toHaveBeenCalled();
    expect(s.deps.render).not.toHaveBeenCalled();
    expect(s.urls).toHaveLength(0);
    heldIds.clear();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(2);
  });

  it("skips a kind that became held while it waited in the queue", async () => {
    const heldIds = new Set<string>();
    const s = setup(null, heldIds);
    s.thumbs.sync([entry("1|a|1")]);
    heldIds.add(ID);
    await s.thumbs.idle();
    expect(s.deps.render).not.toHaveBeenCalled();
  });

  it("shows a rendered thumbnail whose store failed, without marking the kind failed", async () => {
    const s = setup();
    s.deps.put = vi.fn(() => Promise.reject(new Error("disk full")));
    const thumbs = createThumbs(s.deps);
    thumbs.sync([entry("1|a|1")]);
    await thumbs.idle();
    expect(s.shown[thumbKey(ID, "light")]).toMatch(/^blob:/);
    expect(s.shown[thumbKey(ID, "dark")]).toMatch(/^blob:/);
  });

  it("keeps the shown images through a recheck until the store answers, then swaps them", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    const first = [...s.urls];
    const before = { ...s.shown };
    const published: (string | null)[] = [];
    const publish = s.deps.publish;
    s.deps.publish = (key, url) => {
      published.push(url);
      publish(key, url);
    };
    s.thumbs.recheck("com.example.rings");
    s.thumbs.sync([entry("1|a|1")]);
    expect(s.revoked).toEqual([]);
    expect(s.shown).toEqual(before);
    await s.thumbs.idle();
    expect(s.deps.get).toHaveBeenCalledTimes(4);
    expect(s.urls).toHaveLength(4);
    expect(published).not.toContain(null);
    expect(s.revoked.sort()).toEqual([...first].sort());
    expect(first).not.toContain(s.shown[thumbKey(ID, "dark")]);
  });

  it("drops a shown image when the recheck finds none for the kind", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    s.deps.render = vi.fn(async () => null);
    s.thumbs.recheck("com.example.rings");
    await s.thumbs.idle();
    expect(s.shown[thumbKey(ID, "light")]).toBeNull();
    expect(s.revoked).toHaveLength(2);
  });

  it("stores nothing from a render that began before a build change or a recheck", async () => {
    for (const change of ["build", "recheck"] as const) {
      const s = setup();
      const finishes: ((png: Uint8Array) => void)[] = [];
      s.deps.render = vi.fn(() => new Promise<Uint8Array>((resolve) => finishes.push(resolve)));
      s.thumbs.sync([entry("1|a|1")]);
      await vi.waitFor(() => expect(finishes).toHaveLength(1));
      if (change === "build") s.thumbs.sync([entry("2|b|2")]);
      else s.thumbs.recheck("com.example.rings");
      finishes[0](new Uint8Array([9]));
      await vi.waitFor(() => expect(finishes).toHaveLength(2));
      expect(s.deps.put).not.toHaveBeenCalled();
      expect(s.urls).toHaveLength(0);
      // The two themes of the current build, each rendered once.
      for (let i = 1; i < 3; i++) {
        await vi.waitFor(() => expect(finishes.length).toBeGreaterThan(i));
        finishes[i](new Uint8Array([i]));
      }
      await s.thumbs.idle();
      expect(s.deps.put).toHaveBeenCalledTimes(2);
      expect(s.deps.put).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        new Uint8Array([9]),
      );
    }
  });

  it("keeps the shown image and marks nothing when the read of a recheck fails", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    const before = { ...s.shown };
    s.deps.get = vi.fn(() => Promise.reject(new Error("busy")));
    s.thumbs.recheck("com.example.rings");
    await s.thumbs.idle();
    expect(s.shown).toEqual(before);
    expect(s.revoked).toEqual([]);
    expect(s.deps.render).toHaveBeenCalledTimes(2);
    // Not marked failed: a sync with no image shown tries the kind again.
    s.thumbs.sync([entry("2|b|2")]);
    await s.thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(2);
    s.deps.get = vi.fn(() => Promise.resolve(null));
    s.thumbs.sync([entry("2|b|2")]);
    await s.thumbs.idle();
    expect(s.deps.render).toHaveBeenCalledTimes(4);
  });

  it("renders a replaced build again without reading the store, as its rows arrive", async () => {
    const s = setup(new ArrayBuffer(4));
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    expect(s.deps.get).toHaveBeenCalledTimes(2);
    s.thumbs.rebuild("com.example.rings");
    s.thumbs.sync([entry("1|a|2")]);
    await s.thumbs.idle();
    expect(s.deps.get).toHaveBeenCalledTimes(2);
    expect(s.deps.render).toHaveBeenCalledTimes(2);
    expect(s.deps.put).toHaveBeenCalledTimes(2);
    expect(s.shown[thumbKey(ID, "light")]).toMatch(/^blob:/);
    // A later recheck reads the store first again.
    s.thumbs.recheck("com.example.rings");
    await s.thumbs.idle();
    expect(s.deps.get).toHaveBeenCalledTimes(4);
    expect(s.deps.render).toHaveBeenCalledTimes(2);
  });

  it("stops its work and revokes its images on dispose", async () => {
    const s = setup();
    s.thumbs.sync([entry("1|a|1")]);
    await s.thumbs.idle();
    s.thumbs.sync([entry("1|a|1")]);
    s.deps.render = vi.fn(async () => new Uint8Array([1]));
    s.thumbs.dispose();
    expect(s.revoked).toHaveLength(2);
    expect(s.shown[thumbKey(ID, "dark")]).toBeNull();
    s.thumbs.sync([entry("9|z|9")]);
    await s.thumbs.idle();
    expect(s.deps.render).not.toHaveBeenCalled();
    expect(s.urls).toHaveLength(2);
  });

  it("aborts a render in flight and shows nothing from it after dispose", async () => {
    const s = setup();
    let signal!: AbortSignal;
    let finish: (png: Uint8Array) => void = () => {};
    s.deps.render = vi.fn((_id, _theme, sig) => {
      signal = sig;
      return new Promise<Uint8Array>((resolve) => (finish = resolve));
    });
    const thumbs = createThumbs(s.deps);
    thumbs.sync([entry("1|a|1")]);
    await vi.waitFor(() => expect(s.deps.render).toHaveBeenCalled());
    thumbs.dispose();
    expect(signal.aborted).toBe(true);
    finish(new Uint8Array([1]));
    await thumbs.idle();
    expect(s.urls).toHaveLength(0);
  });
});

describe("thumbnail entries", () => {
  it("lists the kinds of enabled, ready plugins with a build signature", () => {
    const rows = [
      visRow("com.example.rings", "Rings", [decl(), decl({ id: "second" })], {
        version: "2.0.0",
        installed_at: 5,
      }),
      visRow("com.example.off", "Off", [decl()], { enabled: false }),
      row({ id: "plain", manifest: manifest() }),
    ];
    const entries = thumbEntries(rows);
    expect(entries.map((e) => e.id)).toEqual(["com.example.rings/aurora-rings", "com.example.rings/second"]);
    expect(entries[0].sig).toBe("2.0.0|hash-1|5");
  });
});

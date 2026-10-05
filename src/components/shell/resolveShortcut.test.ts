// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { resolveShortcut } from "./resolveShortcut";

// -- Type Imports --
import type { ShortcutKey, ShortcutScope } from "./resolveShortcut";

/** A bare keydown: no modifiers, nothing consumed. */
function press(key: string, mods: Partial<ShortcutKey> = {}): ShortcutKey {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...mods,
  };
}

/** A library view with a track loaded, focus on nothing, no overlay. */
function scope(over: Partial<ShortcutScope> = {}): ShortcutScope {
  return {
    typing: false,
    overlay: false,
    editorSession: false,
    focusVisible: false,
    playback: true,
    canGoBack: false,
    canSelectAll: true,
    ...over,
  };
}

const ctrl = { ctrlKey: true };
const meta = { metaKey: true };
const shift = { shiftKey: true };

describe("resolveShortcut: the key map", () => {
  it("maps the playback keys", () => {
    expect(resolveShortcut(press(" "), scope())).toBe("togglePlay");
    expect(resolveShortcut(press("ArrowRight", ctrl), scope())).toBe("next");
    expect(resolveShortcut(press("ArrowLeft", ctrl), scope())).toBe("prev");
    expect(resolveShortcut(press("ArrowRight", shift), scope())).toBe("seekForward");
    expect(resolveShortcut(press("ArrowLeft", shift), scope())).toBe("seekBack");
    expect(resolveShortcut(press("ArrowUp", ctrl), scope())).toBe("volumeUp");
    expect(resolveShortcut(press("ArrowDown", ctrl), scope())).toBe("volumeDown");
  });

  it("maps the navigation and editing keys", () => {
    expect(resolveShortcut(press("k", ctrl), scope())).toBe("finder");
    expect(resolveShortcut(press("f", ctrl), scope())).toBe("find");
    expect(resolveShortcut(press("a", ctrl), scope())).toBe("selectAll");
    expect(resolveShortcut(press("Escape"), scope({ canGoBack: true }))).toBe("back");
    expect(resolveShortcut(press("z", ctrl), scope())).toBe("undo");
    expect(resolveShortcut(press("Z", { ctrlKey: true, shiftKey: true }), scope())).toBe("redo");
    expect(resolveShortcut(press("y", ctrl), scope())).toBe("redo");
  });

  it("opens the sheet on ? as it arrives on AZERTY and QWERTY: the glyph with Shift held", () => {
    expect(resolveShortcut(press("?", shift), scope())).toBe("shortcuts");
    expect(resolveShortcut(press("?"), scope())).toBe("shortcuts");
  });

  it("treats Meta exactly like Ctrl", () => {
    expect(resolveShortcut(press("k", meta), scope())).toBe("finder");
    expect(resolveShortcut(press("f", meta), scope())).toBe("find");
    expect(resolveShortcut(press("a", meta), scope())).toBe("selectAll");
    expect(resolveShortcut(press("z", meta), scope())).toBe("undo");
    expect(resolveShortcut(press("y", meta), scope())).toBe("redo");
    expect(resolveShortcut(press("ArrowRight", meta), scope())).toBe("next");
    expect(resolveShortcut(press("ArrowDown", meta), scope())).toBe("volumeDown");
  });

  it("matches a letter whatever its case", () => {
    expect(resolveShortcut(press("K", ctrl), scope())).toBe("finder");
    expect(resolveShortcut(press("A", ctrl), scope())).toBe("selectAll");
  });

  it("leaves unmapped keys and mixed modifiers alone", () => {
    expect(resolveShortcut(press("ArrowRight"), scope())).toBeNull();
    expect(resolveShortcut(press("ArrowUp", shift), scope())).toBeNull();
    expect(resolveShortcut(press("ArrowRight", { ctrlKey: true, shiftKey: true }), scope())).toBeNull();
    expect(resolveShortcut(press(" ", ctrl), scope())).toBeNull();
    expect(resolveShortcut(press("f", { ctrlKey: true, shiftKey: true }), scope())).toBeNull();
    expect(resolveShortcut(press("q"), scope())).toBeNull();
  });

  it("ignores AltGr, which arrives as Ctrl+Alt", () => {
    expect(resolveShortcut(press("ArrowRight", { ctrlKey: true, altKey: true }), scope())).toBeNull();
    expect(resolveShortcut(press("f", { ctrlKey: true, altKey: true }), scope())).toBeNull();
    expect(resolveShortcut(press("a", { ctrlKey: true, altKey: true }), scope())).toBeNull();
  });
});

describe("resolveShortcut: while typing", () => {
  const typing = scope({ typing: true, canGoBack: true });

  it("still opens the finder and the view search", () => {
    expect(resolveShortcut(press("k", ctrl), typing)).toBe("finder");
    expect(resolveShortcut(press("f", ctrl), typing)).toBe("find");
  });

  it("leaves everything else, Escape included, to the field", () => {
    for (const key of [
      press(" "),
      press("?", shift),
      press("Escape"),
      press("a", ctrl),
      press("z", ctrl),
      press("y", ctrl),
      press("ArrowRight", ctrl),
      press("ArrowLeft", shift),
      press("ArrowUp", ctrl),
    ]) {
      expect(resolveShortcut(key, typing)).toBeNull();
    }
  });
});

describe("resolveShortcut: under a modal or a menu", () => {
  const overlay = scope({ overlay: true, canGoBack: true });

  it("swallows Ctrl+K and Ctrl+F so the webview never acts on them", () => {
    expect(resolveShortcut(press("k", ctrl), overlay)).toBe("swallow");
    expect(resolveShortcut(press("f", ctrl), overlay)).toBe("swallow");
  });

  it("keeps undo and redo, as before", () => {
    expect(resolveShortcut(press("z", ctrl), overlay)).toBe("undo");
    expect(resolveShortcut(press("y", ctrl), overlay)).toBe("redo");
  });

  it("leaves every other key to the open surface", () => {
    for (const key of [
      press(" "),
      press("?", shift),
      press("Escape"),
      press("a", ctrl),
      press("ArrowRight", ctrl),
      press("ArrowLeft", shift),
    ]) {
      expect(resolveShortcut(key, overlay)).toBeNull();
    }
  });
});

describe("resolveShortcut: a key a surface already consumed", () => {
  it("never backs out over a drawer, sheet or selection that took Escape", () => {
    expect(
      resolveShortcut(press("Escape", { defaultPrevented: true }), scope({ canGoBack: true })),
    ).toBeNull();
  });

  it("never doubles a step a focused slider already took", () => {
    expect(
      resolveShortcut(press("ArrowUp", { ctrlKey: true, defaultPrevented: true }), scope()),
    ).toBeNull();
  });
});

describe("resolveShortcut: the Track Editor with a session open", () => {
  const editor = scope({ editorSession: true, canGoBack: true });

  it("leaves Space, the arrows and Escape to the workbench", () => {
    expect(resolveShortcut(press(" "), editor)).toBeNull();
    expect(resolveShortcut(press("Escape"), editor)).toBeNull();
    expect(resolveShortcut(press("ArrowRight", ctrl), editor)).toBeNull();
    expect(resolveShortcut(press("ArrowLeft", shift), editor)).toBeNull();
    expect(resolveShortcut(press("ArrowUp", ctrl), editor)).toBeNull();
  });

  it("still opens the finder and the sheet", () => {
    expect(resolveShortcut(press("k", ctrl), editor)).toBe("finder");
    expect(resolveShortcut(press("?", shift), editor)).toBe("shortcuts");
  });
});

describe("resolveShortcut: availability", () => {
  it("does nothing on the playback keys with no track or the player off", () => {
    const idle = scope({ playback: false });
    for (const key of [
      press(" "),
      press("ArrowRight", ctrl),
      press("ArrowLeft", ctrl),
      press("ArrowRight", shift),
      press("ArrowLeft", shift),
      press("ArrowUp", ctrl),
      press("ArrowDown", ctrl),
    ]) {
      expect(resolveShortcut(key, idle)).toBeNull();
    }
  });

  it("lets Space activate an element reached by keyboard", () => {
    expect(resolveShortcut(press(" "), scope({ focusVisible: true }))).toBeNull();
  });

  it("backs out only from an open full pane", () => {
    expect(resolveShortcut(press("Escape"), scope())).toBeNull();
  });

  it("selects all only in a view that registered it", () => {
    expect(resolveShortcut(press("a", ctrl), scope({ canSelectAll: false }))).toBeNull();
  });
});

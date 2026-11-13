// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  advancePrompt,
  advanceToast,
  closePrompt,
  closeToast,
  currentPrompt,
  currentToast,
  dropPromptPlugins,
  dropToastPlugins,
  emptyPromptQueue,
  emptyToastQueue,
  pushPrompt,
  pushToast,
  setPromptHeld,
} from "./uiQueue";

// -- Type Imports --
import type { PluginUiEvent } from "../../types";

const toast = (request_id: string, id = "p"): PluginUiEvent => ({
  request_id,
  id,
  kind: "toast",
  payload: { text: "hi", action: null },
});

const confirm = (request_id: string, id = "p"): PluginUiEvent => ({
  request_id,
  id,
  kind: "confirm",
  payload: { title: "T", body: "B", confirm_label: "Ok", cancel_label: null },
});

const ids = (items: readonly { request_id: string }[]) => items.map((item) => item.request_id);

describe("toast queue", () => {
  const filled = () => [toast("r1"), toast("r2"), toast("r3", "q")].reduce(pushToast, emptyToastQueue());

  it("keeps arrival order and shows only the head", () => {
    const queue = filled();
    expect(ids(queue.items)).toEqual(["r1", "r2", "r3"]);
    expect(currentToast(queue)?.request_id).toBe("r1");
    expect(currentToast(emptyToastQueue())).toBeNull();
  });

  it("ignores other kinds and a request id already queued", () => {
    const queue = filled();
    expect(pushToast(queue, confirm("r9"))).toBe(queue);
    expect(pushToast(queue, toast("r2"))).toBe(queue);
  });

  it("advances to the next toast", () => {
    const next = advanceToast(filled());
    expect(currentToast(next)?.request_id).toBe("r2");
    expect(advanceToast(emptyToastQueue()).items).toEqual([]);
  });

  it("closes the shown toast and a waiting one", () => {
    expect(currentToast(closeToast(filled(), "r1"))?.request_id).toBe("r2");
    expect(ids(closeToast(filled(), "r2").items)).toEqual(["r1", "r3"]);
    const queue = filled();
    expect(closeToast(queue, "missing")).toBe(queue);
  });

  it("drops the toasts of plugins that are no longer live", () => {
    const kept = dropToastPlugins(filled(), new Set(["q"]));
    expect(ids(kept.items)).toEqual(["r3"]);
    const queue = filled();
    expect(dropToastPlugins(queue, new Set(["p", "q"]))).toBe(queue);
  });
});

describe("prompt queue", () => {
  const filled = () => [confirm("r1"), confirm("r2", "q")].reduce(pushPrompt, emptyPromptQueue());

  it("shows the head in arrival order", () => {
    const queue = filled();
    expect(ids(queue.items)).toEqual(["r1", "r2"]);
    expect(currentPrompt(queue)?.request_id).toBe("r1");
    expect(currentPrompt(advancePrompt(queue))?.request_id).toBe("r2");
    expect(currentPrompt(emptyPromptQueue())).toBeNull();
  });

  it("ignores other kinds and a request id already queued", () => {
    const queue = filled();
    expect(pushPrompt(queue, toast("r5"))).toBe(queue);
    expect(pushPrompt(queue, confirm("r1"))).toBe(queue);
  });

  it("holds the head while a sheet is open and releases it", () => {
    const held = setPromptHeld(filled(), true);
    expect(currentPrompt(held)).toBeNull();
    expect(ids(held.items)).toEqual(["r1", "r2"]);
    const released = setPromptHeld(held, false);
    expect(currentPrompt(released)?.request_id).toBe("r1");
  });

  it("returns the head when a sheet opens mid-show, unanswered", () => {
    const showing = filled();
    expect(currentPrompt(showing)?.request_id).toBe("r1");
    const held = setPromptHeld(showing, true);
    expect(currentPrompt(held)).toBeNull();
    expect(currentPrompt(setPromptHeld(held, false))?.request_id).toBe("r1");
  });

  it("queues behind a sheet and keeps the hold flag through pushes and closes", () => {
    const held = setPromptHeld(emptyPromptQueue(), true);
    const queue = pushPrompt(held, confirm("r1"));
    expect(queue.held).toBe(true);
    expect(currentPrompt(queue)).toBeNull();
    expect(closePrompt(queue, "r1").held).toBe(true);
    expect(setPromptHeld(queue, true)).toBe(queue);
  });

  it("closes the shown prompt and a waiting one", () => {
    expect(currentPrompt(closePrompt(filled(), "r1"))?.request_id).toBe("r2");
    expect(ids(closePrompt(filled(), "r2").items)).toEqual(["r1"]);
    const queue = filled();
    expect(closePrompt(queue, "missing")).toBe(queue);
  });

  it("drops the prompts of plugins that are no longer live", () => {
    expect(ids(dropPromptPlugins(filled(), new Set(["q"])).items)).toEqual(["r2"]);
    const queue = filled();
    expect(dropPromptPlugins(queue, new Set(["p", "q"]))).toBe(queue);
  });
});

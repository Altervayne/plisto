// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { notifyBuildReplaced, onBuildReplaced } from "./buildReplaced";

describe("build replaced signal", () => {
  it("tells each listener the plugin id until it is released", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = onBuildReplaced(a);
    onBuildReplaced(b);
    notifyBuildReplaced("com.example.rings");
    stopA();
    notifyBuildReplaced("other");
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith("com.example.rings");
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("calls every other listener when one throws, and never throws to the caller", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    const stops = [
      onBuildReplaced(() => {
        throw new Error("broken listener");
      }),
      onBuildReplaced(after),
    ];
    expect(() => notifyBuildReplaced("com.example.rings")).not.toThrow();
    expect(after).toHaveBeenCalledWith("com.example.rings");
    for (const stop of stops) stop();
    error.mockRestore();
  });
});

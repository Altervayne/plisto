import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginKindId } from "../pluginVisualizers";
import {
  TRIAL_MS,
  createResetSentinel,
  type LossTarget,
  type ResetKind,
  type TrialKind,
} from "./useResetSentinel";

const kindOf = (kindId: string, ready = true): TrialKind => ({
  kind: `com.example.rings/${kindId}` as PluginKindId,
  pluginId: "com.example.rings",
  kindId,
  ready,
});
const bare = ({ kind, pluginId, kindId }: TrialKind): ResetKind => ({ kind, pluginId, kindId });
const AURORA = kindOf("aurora");
const HALO = kindOf("halo");

function setup(began = true) {
  let lost: (() => void) | null = null;
  const targets: LossTarget[] = [];
  const open = vi.fn((): LossTarget => {
    const target: LossTarget = {
      addEventListener: vi.fn((_type, listener: () => void) => (lost = listener)),
      removeEventListener: vi.fn(() => (lost = null)),
      release: vi.fn(),
    };
    targets.push(target);
    return target;
  });
  const begin = vi.fn((_id: string, _kind: string) => Promise.resolve(began));
  const end = vi.fn((_id: string, _kind: string, _passed: boolean) => Promise.resolve());
  const onLoss = vi.fn();
  const sentinel = createResetSentinel({ begin, end, onLoss, target: open });
  return { sentinel, begin, end, onLoss, open, targets, lose: () => lost?.() };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("graphics-reset sentinel", () => {
  it("begins a kind's trial when it shows and passes it at the trial's end", async () => {
    const s = setup();
    s.sentinel.set([AURORA]);
    await settle();
    expect(s.begin).toHaveBeenCalledWith("com.example.rings", "aurora");
    expect(s.open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TRIAL_MS - 1);
    expect(s.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", true);
  });

  it("begins while the kind compiles, and starts the pass clock only once it drew", async () => {
    const s = setup();
    s.sentinel.set([kindOf("aurora", false)]);
    await settle();
    expect(s.begin).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TRIAL_MS * 2);
    expect(s.end).not.toHaveBeenCalled();
    s.sentinel.set([AURORA]);
    vi.advanceTimersByTime(TRIAL_MS - 1);
    expect(s.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", true);
    expect(s.begin).toHaveBeenCalledTimes(1);
  });

  it("ends the trial unpassed when the kind leaves early, and begins again when it returns", async () => {
    const s = setup();
    s.sentinel.set([AURORA]);
    await settle();
    vi.advanceTimersByTime(TRIAL_MS / 2);
    s.sentinel.set([]);
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", false);
    vi.advanceTimersByTime(TRIAL_MS);
    expect(s.end).toHaveBeenCalledTimes(1);
    s.sentinel.set([AURORA]);
    await settle();
    expect(s.begin).toHaveBeenCalledTimes(2);
  });

  it("ends a trial whose kind left before the begin answered", async () => {
    const s = setup();
    s.sentinel.set([AURORA]);
    s.sentinel.set([]);
    await settle();
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", false);
  });

  it("lays one loss on every kind inside its trial, compiling ones included", async () => {
    const s = setup();
    s.sentinel.set([AURORA]);
    await settle();
    vi.advanceTimersByTime(TRIAL_MS);
    const veil = kindOf("veil", false);
    s.sentinel.set([AURORA, kindOf("halo", false), veil]);
    await settle();
    s.lose();
    expect(s.onLoss).toHaveBeenCalledTimes(1);
    expect(s.onLoss).toHaveBeenCalledWith([bare(HALO), bare(veil)]);
  });

  it("runs no trial for a kind already trialed under its build", async () => {
    const s = setup(false);
    s.sentinel.set([AURORA]);
    await settle();
    s.lose();
    vi.advanceTimersByTime(TRIAL_MS);
    expect(s.onLoss).not.toHaveBeenCalled();
    expect(s.end).not.toHaveBeenCalled();
  });

  it("ends every trial unpassed on dispose", async () => {
    const s = setup();
    s.sentinel.set([AURORA, HALO]);
    await settle();
    s.sentinel.dispose();
    expect(s.end).toHaveBeenCalledTimes(2);
    expect(s.end.mock.calls.every(([, , passed]) => passed === false)).toBe(true);
  });
});

describe("graphics-reset sentinel context", () => {
  it("gives its context back once no trial needs it", async () => {
    const s = setup();
    s.sentinel.set([AURORA]);
    await settle();
    s.sentinel.set([]);
    const [target] = s.targets;
    expect(target.removeEventListener).toHaveBeenCalled();
    expect(target.release).toHaveBeenCalledTimes(1);
  });

  it("drops a lost context without giving it back, and opens a fresh one for the next change", async () => {
    const s = setup();
    s.sentinel.set([AURORA, HALO]);
    await settle();
    s.lose();
    expect(s.onLoss).toHaveBeenCalledWith([bare(AURORA), bare(HALO)]);
    const [dead] = s.targets;
    expect(dead.release).not.toHaveBeenCalled();
    s.sentinel.set([HALO]);
    expect(s.open).toHaveBeenCalledTimes(2);
    s.sentinel.set([]);
    expect(dead.release).not.toHaveBeenCalled();
    expect(s.targets[1].release).toHaveBeenCalledTimes(1);
  });
});

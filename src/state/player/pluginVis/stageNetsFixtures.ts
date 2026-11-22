/*
 * Fakes shared by the stage nets tests: a stage handle with its live state in the open, and the nets'
 * display loop and beat driven by hand.
 */

// -- Test Imports --
import { vi } from "vitest";

// -- Local Imports --
import { registerStage, type StageHandle } from "./frameCache";
import type { NetsDeps } from "./stageNets";
import type { StagePhase } from "./stageMount";
import type { TransportStats } from "./transport";

// -- Type Imports --
import type { PluginVisKindState } from "../../../types";
import type { FlashReading } from "../../../visRuntime/protocol";
import type { PluginKindId } from "../pluginVisualizers";

export const KIND = "com.example.rings/aurora" as PluginKindId;
export const HALO = "com.example.rings/halo" as PluginKindId;
export const AURORA_RESET = { kind: KIND, pluginId: "com.example.rings", kindId: "aurora" };
export const HALO_RESET = { kind: HALO, pluginId: "com.example.rings", kindId: "halo" };
export const HOST = `pv-${"a".repeat(32)}.invalid`;
export const READING: FlashReading = { flashesPerSec: 6, redFlashesPerSec: 0, area: 0.4 };

export const kindState = (over: Partial<PluginVisKindState>): PluginVisKindState => ({
  id: "com.example.rings",
  kind: "aurora",
  flashing: false,
  graphics_reset: false,
  turned_back_on: false,
  trialed: false,
  ...over,
});

export interface FakeLive {
  phase: StagePhase;
  shown: boolean;
  visible: boolean;
  stats: TransportStats;
  flash: FlashReading | null;
}

export interface FakeHandle extends StageHandle {
  live: FakeLive;
  ended: number;
  meters: boolean[];
}

export function fakeHandle(kind: PluginKindId = KIND): FakeHandle {
  const live = {
    phase: "ready" as StagePhase,
    shown: true,
    visible: true,
    flash: null as FlashReading | null,
    stats: {
      visible: true,
      visibleSince: 0,
      sent: 4,
      acked: 2,
      outstanding: 2,
      lastSentAt: 0,
      lastAckAt: 0,
      lastAckMs: 4,
      withheld: 0,
    } as TransportStats,
  };
  const out: FakeHandle = {
    surface: "player",
    kind,
    live,
    ended: 0,
    meters: [],
    phase: () => live.phase,
    visible: () => live.visible,
    shown: () => live.shown,
    stats: () => live.stats,
    url: () => `https://${HOST}/vis/rings.html`,
    metered: () => true,
    flash: () => live.flash,
    setMeter: (on) => out.meters.push(on),
    hold: () => {},
    end: () => {
      out.ended++;
      live.phase = "dropped";
    },
  };
  return out;
}

export function harness() {
  const frames: ((now: number) => void)[] = [];
  const beats: (() => void)[] = [];
  const deps: NetsDeps = {
    frame: (step) => frames.push(step),
    cancelFrame: vi.fn(),
    every: vi.fn((_ms: number, beat: () => void) => {
      beats.push(beat);
      return beats.length as unknown as ReturnType<typeof setInterval>;
    }),
    stopEvery: vi.fn(),
    report: vi.fn(),
    notice: vi.fn(),
    log: vi.fn(),
    onKinds: vi.fn(),
    docVisible: () => doc.visible,
  };
  const tick = (now: number) => frames.splice(0).forEach((step) => step(now));
  const run = (from: number, to: number) => {
    for (let now = from; now <= to; now += 16) tick(now);
  };
  return { deps, beats, tick, run };
}

export const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

export const doc = { visible: true };

const releases: (() => void)[] = [];
export const mount = (handle: StageHandle) => {
  const release = registerStage(handle);
  releases.push(release);
  return release;
};

/** Releases every stage the test mounted. */
export const releaseAll = () => releases.splice(0).forEach((release) => release());

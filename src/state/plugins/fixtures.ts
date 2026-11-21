/*
 * Test fixtures for the plugin tests: a registry row, a manifest summary and an inspection with the
 * realistic fields filled, each overridable.
 */

// -- Type Imports --
import type { PluginInspection, PluginManifestSummary, PluginRow, PluginStatus } from "../../types";
import type { PluginVisualizerDecl } from "./visualizerDecl";

export const manifest = (over: Partial<PluginManifestSummary> = {}): PluginManifestSummary => ({
  name: "Lyrics",
  author: "Lyric Works",
  homepage: "https://lyrics.example.com",
  capabilities: ["playback.read", "network"],
  origins: ["lyrics.example.com"],
  native_reason: null,
  sidebar_items: 1,
  compat: { state: "compatible" },
  modes: ["player"],
  sidebar: null,
  entry: "index.html",
  page: null,
  listing: "plugins",
  visualizers: [],
  ...over,
});

export const row = (over: Partial<PluginRow> = {}): PluginRow => ({
  id: "lyrics",
  version: "1.3.0",
  tier: "ui",
  enabled: true,
  granted: ["playback.read", "network"],
  granted_origins: ["lyrics.example.com"],
  installed_at: 1,
  manifest_hash: "hash-1",
  state: "ready",
  source_path: null,
  sidebar_collapsed: false,
  problem: null,
  manifest: manifest(),
  ...over,
});

export const inspection = (over: Partial<PluginInspection> = {}): PluginInspection => ({
  token: "tok",
  id: "lyrics",
  name: "Lyrics",
  version: "1.4.0",
  author: "Lyric Works",
  tier: "ui",
  capabilities: ["network", "playback.read", "library.read"],
  native_reason: null,
  homepage: null,
  compat: { state: "compatible" },
  file_count: 3,
  total_bytes: 1200,
  installed: null,
  origins: ["lyrics.example.com", "notes.example.com"],
  sidebar_items: 1,
  leftover_data: false,
  listing: "plugins",
  visualizers: [],
  ...over,
});

/** A UI plugin that holds the stream capability and the network origin it plays from. */
export const streamInspection = (over: Partial<PluginInspection> = {}): PluginInspection =>
  inspection({
    id: "night-radio",
    name: "Night Radio",
    capabilities: ["playback.stream", "network"],
    origins: ["streams.nightradio.example"],
    ...over,
  });

/** The installed row of the same plugin, granted the stream capability. */
export const streamRow = (over: Partial<PluginRow> = {}): PluginRow =>
  row({
    id: "night-radio",
    granted: ["playback.stream", "network"],
    granted_origins: ["streams.nightradio.example"],
    manifest: manifest({
      name: "Night Radio",
      capabilities: ["playback.stream", "network"],
      origins: ["streams.nightradio.example"],
    }),
    ...over,
  });

export const visualizerDecl = (over: Partial<PluginVisualizerDecl> = {}): PluginVisualizerDecl => ({
  id: "aurora-rings",
  name: "Aurora rings",
  api: 1,
  page: "vis/rings.html",
  shader: null,
  look: { light: { composite: "ink", blend: "multiply" }, dark: { composite: "light", blend: "screen" } },
  fills_stage: false,
  dark_only: false,
  needs: { fine: false, cover: false, pointer: false, waveform: false },
  aliases: [],
  settings: [],
  presets: [],
  ...over,
});

/** A ready, enabled plugin that only brings visualizers. */
export const visualizerRow = (
  id: string,
  name: string,
  visualizers: PluginVisualizerDecl[],
  over: Partial<PluginRow> = {},
): PluginRow => row({ id, manifest: manifest({ name, entry: null, listing: "catalog", visualizers }), ...over });

export const status = (over: Partial<PluginStatus> = {}): PluginStatus =>
  ({
    id: "lyrics",
    host: "running",
    reported: null,
    takeover: false,
    takeover_revoked: null,
    crash: null,
    protocol_errors: 0,
    rev: 1,
    ...over,
  }) as PluginStatus;

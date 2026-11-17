/*
 * The listeners and syncs the shell mounts once and keeps for its life: the player engine feeds, the
 * library sync, and the plugin runtime relays. They hold no output; each writes into its own store.
 */

// -- Hook Imports --
import { useWarmCurrentVisualizer } from "../player/visualizers/useWarmVisualizers";

// -- State Imports --
import { usePlayerSync } from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";
import { useResumeWriter } from "../../state/player/useResumeWriter";
import { useLibrarySync } from "../../state/useLibrarySync";
import { usePluginsSync } from "../../state/plugins/usePluginsSync";
import { useSandboxCheck } from "../../state/plugins/sandboxStore";
import { usePluginStatusSync } from "../../state/plugins/usePluginStatus";
import { usePluginNet } from "../../state/plugins/usePluginNet";
import { usePluginPageEvents } from "../../state/plugins/usePluginPageEvents";
import { usePluginStreamEvents } from "../../state/plugins/usePluginStreamEvents";
import { usePluginEvents } from "../../state/plugins/usePluginEvents";
import { useLibraryWatch } from "../../state/plugins/useLibraryWatch";
import { usePluginUi } from "../../state/plugins/usePluginUi";

export function useShellSync(): void {
  useWarmCurrentVisualizer();
  // One listener for the app's life, following the engine's status and error events into the store.
  usePlayerSync();
  // Saves the library session for the next launch. This shell only mounts in the main window.
  useResumeWriter();
  // The live spectrum feed into its own off-render singleton, running the app's life alongside the status.
  useSpectrumSync();
  // The background library sync feeds its progress, row changes and root states in for the shell's life.
  useLibrarySync();
  // The plugin registry, read at boot and kept live by the backend's change event.
  usePluginsSync();
  // The sandbox self-check of this start, which decides whether plugins wear the unsandboxed tag.
  useSandboxCheck();
  // The supervised status of every serving plugin, for the rail dots, pages and hub lines.
  usePluginStatusSync();
  // The toasts, prompts, chips and item states plugins set, fed in for the shell's life.
  usePluginUi();
  // Stream chunks and socket messages from Rust, relayed to the plugin's page.
  usePluginNet();
  // A native plugin's page events, relayed to its open page.
  usePluginPageEvents();
  // App event topics, relayed to the frames that subscribed; library edits reported to Rust.
  usePluginEvents();
  useLibraryWatch();
  // The seated stream's events, relayed to the plugin that owns it.
  usePluginStreamEvents();
}

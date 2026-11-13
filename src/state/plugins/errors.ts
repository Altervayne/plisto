/*
 * The plugin commands reject with `{ code, detail }`. The code maps to a message in the dictionary; the
 * detail is an English line for logs and is never shown. A rejection of any other shape reads as unknown.
 */

// -- Type Imports --
import type { PluginInstallErrorCode } from "../../types";

/** Every code, keyed so a code added to the union fails the build until it is listed here. */
const CODES: Record<PluginInstallErrorCode, true> = {
  not_found: true,
  too_large: true,
  too_many_files: true,
  unsafe_path: true,
  link_not_allowed: true,
  stream_not_allowed: true,
  name_collision: true,
  bad_archive: true,
  invalid_manifest: true,
  bad_icon: true,
  missing_file: true,
  already_installed: true,
  unknown_token: true,
  registry_unavailable: true,
  io: true,
  not_installed: true,
  tier_changed: true,
  incompatible: true,
  broken: true,
  manifest_changed: true,
  consent_mismatch: true,
  native_ack_required: true,
  needs_reinstall: true,
  busy: true,
};

export const INSTALL_ERROR_CODES = Object.keys(CODES) as PluginInstallErrorCode[];

/** A code the dictionary has a message for, or "unknown" for anything else. */
export type PluginErrorKey = PluginInstallErrorCode | "unknown";

const isCode = (value: unknown): value is PluginInstallErrorCode =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(CODES, value);

/** Reads a rejection into its message key and its log detail. */
export function readInstallError(error: unknown): { key: PluginErrorKey; detail: string } {
  if (error && typeof error === "object") {
    const { code, detail } = error as { code?: unknown; detail?: unknown };
    return {
      key: isCode(code) ? code : "unknown",
      detail: typeof detail === "string" ? detail : String(code ?? ""),
    };
  }
  return { key: "unknown", detail: String(error) };
}

/** Reads a rejection and logs its detail to the console, returning the key to show. */
export function logInstallError(what: string, error: unknown): PluginErrorKey {
  const { key, detail } = readInstallError(error);
  console.warn(`plugin ${what} failed: ${key}: ${detail}`);
  return key;
}

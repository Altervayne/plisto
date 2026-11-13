/*
 * One icon read per plugin version. Reads are cached by key (an id with its manifest hash, or a staged
 * token) so a list re-render never asks the backend again. A null answer is cached; a rejected read is
 * not, so the next mount tries again. Only an image data URL is ever returned. An update can change the
 * icon file without changing the manifest hash, so an id's entries are dropped when it is updated or
 * removed, and a staged token's when its sheet closes.
 */

// -- IPC Imports --
import { pluginIcon, pluginStagedIcon } from "../../lib/ipc";

/** Where an icon comes from: an installed plugin at a manifest version, or a staged inspection. */
export type IconSource = { kind: "installed"; id: string; hash: string } | { kind: "staged"; token: string };

const cache = new Map<string, Promise<string | null>>();

export const iconKey = (source: IconSource): string =>
  source.kind === "installed" ? `i:${source.id}:${source.hash}` : `s:${source.token}`;

/** The icon's image data URL, or null when it has none, cannot be read, or is not an image. */
export function loadIcon(source: IconSource): Promise<string | null> {
  const key = iconKey(source);
  const hit = cache.get(key);
  if (hit) return hit;
  const read = (source.kind === "installed" ? pluginIcon(source.id) : pluginStagedIcon(source.token))
    .then((url) => (typeof url === "string" && url.startsWith("data:image/") ? url : null))
    .catch(() => {
      cache.delete(key);
      return null;
    });
  cache.set(key, read);
  return read;
}

/** Forgets every cached icon of an installed plugin. */
export function dropInstalledIcons(id: string): void {
  const prefix = `i:${id}:`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/** Forgets a staged inspection's icon. */
export function dropStagedIcon(token: string): void {
  cache.delete(`s:${token}`);
}

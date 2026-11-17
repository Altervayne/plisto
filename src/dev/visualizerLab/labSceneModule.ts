/*
 * Loads a scene module the registry does not hold, so a scene can be drawn and measured before it is
 * wired in. A scene id `neon-highway` resolves to `gl/neonHighway.ts`, which exports `createNeonHighway`. The
 * scene draws the way the whole-stage kinds do: an opaque image with a normal blend in both themes.
 */

// -- Local Imports --
import { registryScene, type SceneResolver, type SceneSource } from "../../components/player/visualizers/gl/renderer";

// -- Type Imports --
import type { Candidate, Kit } from "../../components/player/visualizers/gl/kit";
import type { GlKind } from "../../state/player/visualizerKind";

const MODULES = import.meta.glob<Record<string, unknown>>(
  ["../../components/player/visualizers/gl/*.ts", "!../../components/player/visualizers/gl/*.test.ts"],
);

/** A loaded scene: its source for the renderer, and whether it has no light look. */
export interface LabScene {
  id: string;
  source: SceneSource;
  darkOnly: boolean;
}

function camel(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Imports the module for `id` and reads its factory. Throws when the convention is not met. */
export async function loadScene(id: string, darkOnly: boolean): Promise<LabScene> {
  const name = camel(id);
  const load = MODULES[`../../components/player/visualizers/gl/${name}.ts`];
  if (!load) throw new Error(`no scene module gl/${name}.ts`);
  const mod = await load();
  const pascal = name[0].toUpperCase() + name.slice(1);
  const create = mod[`create${pascal}`];
  if (typeof create !== "function") throw new Error(`gl/${name}.ts does not export create${pascal}`);
  return {
    id,
    darkOnly,
    source: {
      factory: create as (kit: Kit) => Candidate,
      descriptor: { fillsStage: true, blend: { light: "normal", dark: "normal" } },
    },
  };
}

/** A renderer resolver that answers `scene` for its id and the registry for every other kind. */
export function resolverWith(scene: LabScene | null): SceneResolver<string> {
  return (kind) => (scene && kind === scene.id ? scene.source : registryScene(kind as GlKind));
}

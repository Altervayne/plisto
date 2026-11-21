/*
 * Holds the runtime and the author types to one another at compile time: `tsc` fails here when an export
 * of `src/visRuntime/index.ts` is not assignable to the author `.d.ts`, or the other way round. String
 * constants are compared as `string`, since the runtime's own are literal types of whole shaders.
 */

/// <reference path="../../plugin-kit/visualizers/types/plisto-vis-1.d.ts" />

// -- Local Imports --
import type * as runtime from "./index";

type Runtime = typeof runtime;
type Authored = typeof plistoVis;
type Wide<T> = { [K in keyof T]: T[K] extends string ? string : T[K] };

declare const fromRuntime: Wide<Runtime>;
declare const fromAuthor: Wide<Authored>;

export const runtimeFitsTypes: Wide<Authored> = fromRuntime;
export const typesFitRuntime: Wide<Runtime> = fromAuthor;

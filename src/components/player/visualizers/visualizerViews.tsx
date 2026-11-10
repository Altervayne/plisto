/*
 * The UI half of the visualizer registry: each kind's label, glyph and, for a GL kind, the factory the
 * renderer builds it with, plus the pre-rendered thumbnails. Keyed by kind, so a kind missing here fails
 * the typecheck.
 */

// -- Framework Imports --
import type { ReactNode } from "react";

// -- Local Imports --
import { createBloom, BLOOM_PROGRAMS } from "./gl/bloom";
import { createDotCover, DOT_COVER_PROGRAMS } from "./gl/dotCover";
import { createDotSpectrum, DOT_SPECTRUM_PROGRAMS } from "./gl/dotSpectrum";
import { createFireflies, FIREFLIES_PROGRAMS } from "./gl/fireflies";
import { createGlass, GLASS_PROGRAMS } from "./gl/glass";
import { createHalftone, HALFTONE_PROGRAMS } from "./gl/halftone";
import { createInk, INK_PROGRAMS } from "./gl/ink";
import { createLake, LAKE_PROGRAMS } from "./gl/lake";
import { createLatte, LATTE_PROGRAMS } from "./gl/latte";
import { createLiquid, LIQUID_PROGRAMS } from "./gl/liquid";
import { createMercury, MERCURY_PROGRAMS } from "./gl/mercury";
import { createNebula, NEBULA_PROGRAMS } from "./gl/nebula";
import { createPond, POND_PROGRAMS } from "./gl/pond";
import { createRecord, RECORD_PROGRAMS } from "./gl/record";
import { createSilk, SILK_PROGRAMS } from "./gl/silk";
import { createSnowfall, SNOWFALL_PROGRAMS } from "./gl/snowfall";
import { createTerrain, TERRAIN_PROGRAMS } from "./gl/terrain";
import { createTrain, TRAIN_PROGRAMS } from "./gl/train";
import { createWarp, WARP_PROGRAMS } from "./gl/warp";
import { createWindow, WINDOW_PROGRAMS } from "./gl/window";

// -- Type Imports --
import type { Candidate, Kit, ProgramSource } from "./gl/kit";
import type { Dict } from "../../../i18n/en";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

export interface VisualizerView {
  // The localized name, as an accessor for `t`.
  label: (d: Dict) => string;
  // The mark, drawn on the 24-unit stroke grid the app's icon set uses.
  glyph: ReactNode;
  factory?: (kit: Kit) => Candidate;
  // Every program the factory's candidate compiles, for warming the shader cache.
  programs?: readonly ProgramSource[];
}

export const VISUALIZER_VIEWS: Record<VisualizerKind, VisualizerView> = {
  ridge: {
    label: (d) => d.player.visualizerRidge,
    glyph: <path d="M2 20c3-1 4-9 8-9s4 6 7 6 3-5 5-6v9z" fill="currentColor" fillOpacity={0.3} />,
  },
  terrain: {
    label: (d) => d.player.visualizerTerrain,
    glyph: (
      <>
        <path d="M2 8c3 0 4-3 6-3s3 3 5 3 3-2 5-2 3 2 4 2" />
        <path d="M2 13c3 0 4-4 6-4s3 4 5 4 3-3 5-3 3 3 4 3" />
        <path d="M2 19c3 0 4-5 6-5s3 5 5 5 3-4 5-4 3 4 4 4" />
      </>
    ),
    factory: createTerrain,
    programs: TERRAIN_PROGRAMS,
  },
  liquid: {
    label: (d) => d.player.visualizerLiquid,
    glyph: (
      <>
        <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
        <path d="M9 15.5a3 3 0 0 0 3 3" opacity={0.6} />
      </>
    ),
    factory: createLiquid,
    programs: LIQUID_PROGRAMS,
  },
  warp: {
    label: (d) => d.player.visualizerWarp,
    glyph: (
      <>
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="5.5" />
        <circle cx="12" cy="12" r="2" />
        <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" opacity={0.6} />
      </>
    ),
    factory: createWarp,
    programs: WARP_PROGRAMS,
  },
  nebula: {
    label: (d) => d.player.visualizerNebula,
    glyph: (
      <>
        <circle cx="12" cy="12" r="2.2" />
        <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-24 12 12)" />
        <circle cx="19.5" cy="7.2" r="1.2" />
        <circle cx="5" cy="16.5" r=".8" />
      </>
    ),
    factory: createNebula,
    programs: NEBULA_PROGRAMS,
  },
  bloom: {
    label: (d) => d.player.visualizerBloom,
    glyph: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5" />
      </>
    ),
    factory: createBloom,
    programs: BLOOM_PROGRAMS,
  },
  halftone: {
    label: (d) => d.player.visualizerHalftone,
    glyph: (
      <g fill="currentColor" stroke="none">
        <circle cx="4.5" cy="19.5" r="2.5" />
        <circle cx="12" cy="19.5" r="2.5" />
        <circle cx="19.5" cy="19.5" r="2.5" />
        <circle cx="8.25" cy="13" r="1.8" />
        <circle cx="15.75" cy="13" r="1.8" />
        <circle cx="4.5" cy="6.5" r="1.1" />
        <circle cx="12" cy="6.5" r="1.1" />
        <circle cx="19.5" cy="6.5" r="1.1" />
      </g>
    ),
    factory: createHalftone,
    programs: HALFTONE_PROGRAMS,
  },
  "dot-spectrum": {
    label: (d) => d.player.visualizerDotSpectrum,
    glyph: (
      <g fill="currentColor">
        <circle cx="5" cy="19" r="1.6" />
        <circle cx="12" cy="19" r="1.6" />
        <circle cx="19" cy="19" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
        <circle cx="12" cy="5" r="1.6" />
      </g>
    ),
    factory: createDotSpectrum,
    programs: DOT_SPECTRUM_PROGRAMS,
  },
  "dot-cover": {
    label: (d) => d.player.visualizerDotCover,
    glyph: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <g fill="currentColor" stroke="none">
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12" cy="8" r="1.3" />
          <circle cx="16" cy="8" r="1.3" />
          <circle cx="8" cy="12" r="1.3" />
          <circle cx="12" cy="12" r="1.3" />
          <circle cx="16" cy="12" r="1.3" />
          <circle cx="8" cy="16" r="1.3" />
          <circle cx="12" cy="16" r="1.3" />
          <circle cx="16" cy="16" r="1.3" />
        </g>
      </>
    ),
    factory: createDotCover,
    programs: DOT_COVER_PROGRAMS,
  },
  ink: {
    label: (d) => d.player.visualizerInk,
    glyph: (
      <>
        <path d="M12 3c-1.2 2.2-3 3.4-3 5.5a3 3 0 0 0 6 0c0-2.1-1.8-3.3-3-5.5z" />
        <path d="M10 14.5c-2 1-4 2.5-4 5.5M14 14.5c2 1 4 2.5 4 5.5M12 15v6" opacity={0.6} />
      </>
    ),
    factory: createInk,
    programs: INK_PROGRAMS,
  },
  mercury: {
    label: (d) => d.player.visualizerMercury,
    glyph: (
      <>
        <ellipse cx="12" cy="15" rx="9" ry="5" />
        <path d="M7 14.5c1.5-1.3 3.5-2 6-2" opacity={0.6} />
        <circle cx="17" cy="5.5" r="2" />
      </>
    ),
    factory: createMercury,
    programs: MERCURY_PROGRAMS,
  },
  glass: {
    label: (d) => d.player.visualizerGlass,
    glyph: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M15 6.5v4" opacity={0.6} />
        <path d="M15 12c-1.2 1.7-2 2.8-2 3.8a2 2 0 0 0 4 0c0-1-.8-2.1-2-3.8z" fill="currentColor" />
        <g fill="currentColor" stroke="none">
          <circle cx="8" cy="9" r="0.8" />
          <circle cx="9" cy="15" r="0.8" />
        </g>
      </>
    ),
    factory: createGlass,
    programs: GLASS_PROGRAMS,
  },
  silk: {
    label: (d) => d.player.visualizerSilk,
    glyph: (
      <>
        <path d="M3 6c3-2 6-2 9 0s6 2 9 0v12c-3 2-6 2-9 0s-6-2-9 0z" />
        <path d="M9 5.2c1 4.3 1 9.3 0 13.6" opacity={0.6} />
      </>
    ),
    factory: createSilk,
    programs: SILK_PROGRAMS,
  },
  pond: {
    label: (d) => d.player.visualizerPond,
    glyph: (
      <>
        <ellipse cx="12" cy="16.5" rx="10" ry="5" opacity={0.6} />
        <ellipse cx="12" cy="16.5" rx="4.5" ry="2" />
        <path d="M12 2.5c-1 1.7-2 2.8-2 4a2 2 0 0 0 4 0c0-1.2-1-2.3-2-4z" fill="currentColor" />
      </>
    ),
    factory: createPond,
    programs: POND_PROGRAMS,
  },
  train: {
    label: (d) => d.player.visualizerTrain,
    glyph: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="4" />
        <path d="M2 15.5c3 0 4.5-2.5 7.5-2.5s4.5 2.5 12.5 2.5" opacity={0.6} />
        <path d="M9.5 8 6.5 10.5M15.5 8l-3 2.5" />
      </>
    ),
    factory: createTrain,
    programs: TRAIN_PROGRAMS,
  },
  record: {
    label: (d) => d.player.visualizerRecord,
    glyph: (
      <>
        <circle cx="9.5" cy="13" r="8" />
        <circle cx="9.5" cy="13" r="2.4" />
        <path d="M20.5 3.5V12l-4.5 4" />
      </>
    ),
    factory: createRecord,
    programs: RECORD_PROGRAMS,
  },
  snowfall: {
    label: (d) => d.player.visualizerSnowfall,
    glyph: (
      <>
        <path d="M9 4v12M3.8 7l10.4 6M3.8 13l10.4-6" />
        <g fill="currentColor" stroke="none">
          <circle cx="18.5" cy="5.5" r="1.3" />
          <circle cx="19.5" cy="13.5" r="1.3" />
          <circle cx="6" cy="20.5" r="1.3" />
          <circle cx="14.5" cy="20" r="1.3" />
        </g>
      </>
    ),
    factory: createSnowfall,
    programs: SNOWFALL_PROGRAMS,
  },
  latte: {
    label: (d) => d.player.visualizerLatte,
    glyph: (
      <>
        <circle cx="10.5" cy="12" r="8" />
        <path d="M18.5 9.5h1.5a2.5 2.5 0 0 1 0 5h-1.5" />
        <path
          d="M10.5 15.5c-2.5-1.5-3.9-2.9-3.9-4.5a1.95 1.95 0 0 1 3.9-.4 1.95 1.95 0 0 1 3.9.4c0 1.6-1.4 3-3.9 4.5z"
          fill="currentColor"
        />
      </>
    ),
    factory: createLatte,
    programs: LATTE_PROGRAMS,
  },
  fireflies: {
    label: (d) => d.player.visualizerFireflies,
    glyph: (
      <>
        <path d="M2 21h20" />
        <g opacity={0.6}>
          <path d="M6 21c-.3-2.4-1-3.9-2.2-5M6 21c.3-2.8 1-4.3 2.4-5.6" />
          <path d="M17 21c-.3-2.4-1-3.9-2.2-5M17 21c.3-2.8 1-4.3 2.4-5.6" />
        </g>
        <g fill="currentColor" stroke="none">
          <circle cx="7.5" cy="8" r="3.4" fillOpacity={0.25} />
          <circle cx="7.5" cy="8" r="1.5" />
          <circle cx="14" cy="4.5" r="1.2" />
          <circle cx="18.5" cy="9.5" r="1.4" />
          <circle cx="12.5" cy="12.5" r="1" />
        </g>
      </>
    ),
    factory: createFireflies,
    programs: FIREFLIES_PROGRAMS,
  },
  window: {
    label: (d) => d.player.visualizerWindow,
    glyph: (
      <>
        <rect x="4" y="3" width="16" height="15.5" rx="1.5" />
        <path d="M12 3v15.5M4 10.75h16" />
        <path d="M2 21.5h20" />
      </>
    ),
    factory: createWindow,
    programs: WINDOW_PROGRAMS,
  },
  lake: {
    label: (d) => d.player.visualizerLake,
    glyph: (
      <>
        <path d="M17 3.5a4 4 0 1 0 0 7 4.5 4.5 0 0 1 0-7z" fill="currentColor" />
        <path d="M2 13.5h20" />
        <path d="M12 17h5.5M13 20.5h3.5M4 17h3.5" opacity={0.6} />
      </>
    ),
    factory: createLake,
    programs: LAKE_PROGRAMS,
  },
  off: {
    label: (d) => d.player.visualizerOff,
    glyph: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m5.6 5.6 12.8 12.8" />
      </>
    ),
  },
};

/** The programs a kind compiles, or an empty list for a kind that draws without WebGL. */
export function programsOf(kind: VisualizerKind): readonly ProgramSource[] {
  return VISUALIZER_VIEWS[kind].programs ?? [];
}

// The stills ship as files and resolve to URLs, so none of them lands in a JS chunk.
const THUMBS = import.meta.glob<string>("../../../assets/visualizer-thumbs/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});

/** The URL of a kind's pre-rendered still in a theme, or null when none was captured. */
export function thumbFor(kind: VisualizerKind, theme: "light" | "dark"): string | null {
  return THUMBS[`../../../assets/visualizer-thumbs/${kind}-${theme}.webp`] ?? null;
}

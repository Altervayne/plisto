/*
 * The UI half of the visualizer registry: each kind's label, glyph and, for a GL kind, the factory the
 * renderer builds it with. Keyed by kind, so a kind missing here fails the typecheck.
 */

// -- Framework Imports --
import type { ReactNode } from "react";

// -- Local Imports --
import { createBloom } from "./gl/bloom";
import { createDotCover } from "./gl/dotCover";
import { createDotSpectrum } from "./gl/dotSpectrum";
import { createGlass } from "./gl/glass";
import { createHalftone } from "./gl/halftone";
import { createInk } from "./gl/ink";
import { createLiquid } from "./gl/liquid";
import { createMercury } from "./gl/mercury";
import { createNebula } from "./gl/nebula";
import { createSilk } from "./gl/silk";
import { createTerrain } from "./gl/terrain";
import { createWarp } from "./gl/warp";

// -- Type Imports --
import type { Candidate, Kit } from "./gl/kit";
import type { Dict } from "../../../i18n/en";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

export interface VisualizerView {
  // The localized name, as an accessor for `t`.
  label: (d: Dict) => string;
  // The mark, drawn on the 24-unit stroke grid the app's icon set uses.
  glyph: ReactNode;
  factory?: (kit: Kit) => Candidate;
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

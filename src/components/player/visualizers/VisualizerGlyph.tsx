// -- Type Imports --
import type { ReactNode } from "react";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

// Each visualizer's mark, drawn on the 24-unit stroke grid the app's icon set uses.
const PATHS: Record<VisualizerKind, ReactNode> = {
  ridge: <path d="M2 20c3-1 4-9 8-9s4 6 7 6 3-5 5-6v9z" fill="currentColor" fillOpacity={0.3} />,
  terrain: (
    <>
      <path d="M2 8c3 0 4-3 6-3s3 3 5 3 3-2 5-2 3 2 4 2" />
      <path d="M2 13c3 0 4-4 6-4s3 4 5 4 3-3 5-3 3 3 4 3" />
      <path d="M2 19c3 0 4-5 6-5s3 5 5 5 3-4 5-4 3 4 4 4" />
    </>
  ),
  liquid: (
    <>
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
      <path d="M9 15.5a3 3 0 0 0 3 3" opacity={0.6} />
    </>
  ),
  warp: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" opacity={0.6} />
    </>
  ),
  nebula: (
    <>
      <circle cx="12" cy="12" r="2.2" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-24 12 12)" />
      <circle cx="19.5" cy="7.2" r="1.2" />
      <circle cx="5" cy="16.5" r=".8" />
    </>
  ),
  bloom: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5" />
    </>
  ),
  off: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>
  ),
};

/** A visualizer's glyph for the picker rows, stroked in the current color. */
export function VisualizerGlyph({ kind, size = 16 }: { kind: VisualizerKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[kind]}
    </svg>
  );
}

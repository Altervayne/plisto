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
  halftone: (
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
  "dot-spectrum": (
    <g fill="currentColor">
      <circle cx="5" cy="19" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
      <circle cx="19" cy="19" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
      <circle cx="12" cy="5" r="1.6" />
    </g>
  ),
  "dot-cover": (
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
  ink: (
    <>
      <path d="M12 3c-1.2 2.2-3 3.4-3 5.5a3 3 0 0 0 6 0c0-2.1-1.8-3.3-3-5.5z" />
      <path d="M10 14.5c-2 1-4 2.5-4 5.5M14 14.5c2 1 4 2.5 4 5.5M12 15v6" opacity={0.6} />
    </>
  ),
  mercury: (
    <>
      <ellipse cx="12" cy="15" rx="9" ry="5" />
      <path d="M7 14.5c1.5-1.3 3.5-2 6-2" opacity={0.6} />
      <circle cx="17" cy="5.5" r="2" />
    </>
  ),
  glass: (
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
  silk: (
    <>
      <path d="M3 6c3-2 6-2 9 0s6 2 9 0v12c-3 2-6 2-9 0s-6-2-9 0z" />
      <path d="M9 5.2c1 4.3 1 9.3 0 13.6" opacity={0.6} />
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

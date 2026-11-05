/*
 * The words for each levelling state: a status line, an optional progress line (with its bar fraction),
 * and an optional note. Pure over the translator, so every state is testable without a render.
 */

// -- Utils Imports --
import { measuringProgress } from "./coverageState";

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { LoudnessCoverage } from "../../types";
import type { CoverageState } from "./coverageState";

export interface CoverageText {
  status: string | null;
  progress: { text: string; fraction: number } | null;
  note: string | null;
}

const NONE: CoverageText = { status: null, progress: null, note: null };

export function coverageText(
  state: CoverageState,
  coverage: LoudnessCoverage | null,
  t: Translate,
): CoverageText {
  if (coverage == null || state === "off" || state === "loading") return NONE;

  if (state === "empty") {
    return {
      status: t((d) => d.sound.levellingEmpty),
      progress: null,
      note: t((d) => d.sound.levellingEmptyNote),
    };
  }

  if (state === "measuring" || state === "paused") {
    const { done, of } = measuringProgress(coverage);
    const vars = { done, of };
    return {
      status: t((d) => d.sound.levellingPending, { n: coverage.pending }),
      progress: {
        text: t(
          (d) => (state === "paused" ? d.sound.levellingPaused : d.sound.levellingMeasuring),
          vars,
        ),
        fraction: of > 0 ? done / of : 0,
      },
      note: null,
    };
  }

  const withData = coverage.tagged + coverage.measured;
  const status =
    coverage.unmeasurable === 0
      ? t((d) => d.sound.levellingAll, { n: coverage.total })
      : t((d) => d.sound.levellingSome, { n: withData });
  let note: string | null = null;
  if (state === "nothingToMeasure") note = t((d) => d.sound.levellingAllTagged);
  else if (coverage.unmeasurable > 0) {
    note = t((d) => d.sound.levellingUnreadable, { n: coverage.unmeasurable });
  }
  return { status, progress: null, note };
}

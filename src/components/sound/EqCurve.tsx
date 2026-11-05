// -- Framework Imports --
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

// -- Utils Imports --
import { GAIN_MAX_DB, GAIN_MIN_DB, BANDS } from "../../state/sound/settings";
import { GAIN_STEP_DB } from "../../state/sound/presets";
import { BAND_LABELS, curvePaths, frameOf, gainAtY, PAD_X, xOf, yOf } from "./eqGeometry";
import { formatDb } from "./formatDb";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./EqCurve.module.css";

const COARSE_STEP_DB = 2;

/**
 * The EQ curve: the drawn response of the eight bands with one handle per band, dragged up and down only,
 * in half-decibel steps. Handles are sliders: Up and Down nudge by a step (Shift for a coarse one), Home
 * returns the handle to 0, Left and Right move focus to the neighbouring band. `width` is the view-box
 * width; the drawing scales to its container. While a handle is held or being nudged, a bubble shows its
 * value. With the EQ off the curve greys and the handles go inert.
 */
export function EqCurve({
  gains,
  on,
  width,
  plotHeight,
  onGain,
  idleNote = null,
}: {
  gains: readonly number[];
  on: boolean;
  width: number;
  plotHeight: number;
  onGain: (band: number, gainDb: number) => void;
  /** A dimmed line under the curve, for a state where the curve has nothing to act on yet. */
  idleNote?: string | null;
}) {
  const t = useT();
  const frame = useMemo(() => frameOf(width, plotHeight), [width, plotHeight]);
  const paths = useMemo(() => curvePaths(frame, gains), [frame, gains]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const handleRefs = useRef<(SVGGElement | null)[]>([]);
  const dragging = useRef<number | null>(null);
  // The band whose value bubble is showing.
  const [shown, setShown] = useState<number | null>(null);

  const gainFromPointer = (clientY: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return 0;
    return gainAtY(frame, (clientY - rect.top) * (frame.height / rect.height));
  };

  const onPointerDown = (band: number) => (event: PointerEvent<SVGGElement>) => {
    if (!on) return;
    dragging.current = band;
    setShown(band);
    svgRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
    onGain(band, gainFromPointer(event.clientY));
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (dragging.current === null) return;
    onGain(dragging.current, gainFromPointer(event.clientY));
  };

  const endDrag = () => {
    if (dragging.current === null) return;
    dragging.current = null;
    setShown(null);
  };

  const onKeyDown = (band: number) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      handleRefs.current[band + (event.key === "ArrowRight" ? 1 : -1)]?.focus();
      return;
    }
    const step = event.shiftKey ? COARSE_STEP_DB : GAIN_STEP_DB;
    let next: number;
    if (event.key === "ArrowUp") next = gains[band] + step;
    else if (event.key === "ArrowDown") next = gains[band] - step;
    else if (event.key === "Home") next = 0;
    else return;
    event.preventDefault();
    setShown(band);
    onGain(band, next);
  };

  const y0 = yOf(frame, 0);
  const bubble = shown === null ? null : bubbleSpot(frame, shown, gains[shown]);

  return (
    <div className={`${styles.eq} ${on ? "" : styles.off}`} style={{ maxWidth: width }}>
      <div className={styles.stage}>
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShown(null);
          }}
        >
          <line className={styles.zero} x1={PAD_X} x2={width - PAD_X} y1={y0} y2={y0} />
          <path className={styles.area} d={paths.area} />
          <path className={styles.line} d={paths.line} />
          {BANDS.map((band, i) => (
            <text
              key={`l${band.freqHz}`}
              className={styles.label}
              x={xOf(frame, band.freqHz)}
              y={frame.height - 4}
            >
              {BAND_LABELS[i]}
            </text>
          ))}
          {BANDS.map((band, i) => (
            <g
              key={band.freqHz}
              ref={(node) => {
                handleRefs.current[i] = node;
              }}
              className={`${styles.handle} ${shown === i ? styles.active : ""}`}
              transform={`translate(${xOf(frame, band.freqHz).toFixed(1)},${yOf(frame, gains[i]).toFixed(1)})`}
              tabIndex={on ? 0 : -1}
              role="slider"
              aria-orientation="vertical"
              aria-disabled={!on}
              aria-label={t((d) => d.sound.bandGain, { freq: BAND_LABELS[i] })}
              aria-valuemin={GAIN_MIN_DB}
              aria-valuemax={GAIN_MAX_DB}
              aria-valuenow={gains[i]}
              aria-valuetext={formatDb(gains[i])}
              onPointerDown={onPointerDown(i)}
              onKeyDown={onKeyDown(i)}
              onFocus={() => {
                if (dragging.current === null) setShown(null);
              }}
            >
              <circle className={styles.hit} r={15} />
              <circle className={styles.ring} r={12} />
              <circle className={styles.knob} r={5.5} />
            </g>
          ))}
        </svg>
        {bubble ? (
          <div className={styles.bubble} style={{ left: bubble.left, top: bubble.top }}>
            {formatDb(gains[shown ?? 0])}
            <small>{t((d) => d.sound.bubbleHz, { freq: BAND_LABELS[shown ?? 0] })}</small>
          </div>
        ) : null}
      </div>
      {idleNote ? <p className={styles.idle}>{idleNote}</p> : null}
    </div>
  );
}

/** Where the value bubble floats: over its handle, kept clear of the side edges. */
function bubbleSpot(
  frame: ReturnType<typeof frameOf>,
  band: number,
  gainDb: number,
): { left: string; top: string } {
  const x = Math.max(48, Math.min(frame.width - 48, xOf(frame, BANDS[band].freqHz)));
  const y = yOf(frame, gainDb);
  return {
    left: `${(x / frame.width) * 100}%`,
    top: `max(-6px, calc(${(y / frame.height) * 100}% - 40px))`,
  };
}

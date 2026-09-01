// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Local Imports --
import type { DerivedSegment, Marker } from "./cutModel";

// -- Type Imports --
import type { Peak, SilenceSpan } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./WaveformLane.module.css";

/** The zoom step: fit the whole file to the lane, or widen it to a scrollable virtual width. */
export type Zoom = "fit" | "medium" | "fine";

/** How far each step widens the lane past the viewport. Fit maps the whole file to the lane width. */
const ZOOM_FACTOR: Record<Zoom, number> = { fit: 1, medium: 3, fine: 8 };

// A pointer that moves less than this many pixels between press and release reads as a click, not a
// drag: on the lane it drops a marker, on a handle it deletes one.
const DRAG_SLOP = 4;

/** Clamps a ratio into 0..1. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// Paints the peaks onto a canvas at its current size, DPR, and the given ink. Scales the backing
// store by the device pixel ratio while drawing in CSS pixels, and takes the min/max extent of the
// buckets falling in each pixel column, so paint cost follows the canvas width, not the bucket count.
// Shared by the main lane and the overview: they differ only in element width, never in the peaks.
function drawPeaks(canvas: HTMLCanvasElement, peaks: Peak[], color: string): void {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = color;

  const mid = cssH / 2;
  const n = peaks.length;
  if (n === 0) return;

  // One column per CSS pixel; each takes the extent of the buckets mapping into it.
  for (let x = 0; x < cssW; x++) {
    const b0 = Math.floor((x / cssW) * n);
    const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / cssW) * n));
    let min = 1;
    let max = -1;
    for (let b = b0; b < b1 && b < n; b++) {
      if (peaks[b].min < min) min = peaks[b].min;
      if (peaks[b].max > max) max = peaks[b].max;
    }
    if (max < min) continue;
    // Peaks are normalized -1..1: the max rides above the center line, the min below it.
    const top = mid - max * mid;
    const bottom = mid - min * mid;
    // A hairline at the center keeps a silent column visible rather than vanishing to nothing.
    const h = Math.max(1, bottom - top);
    ctx.fillRect(x, top, 1, h);
  }
}

/** The optional editing layer: the markers over the lane and the callbacks that move them. */
interface MarkerLayer {
  markers: Marker[];
  segments: DerivedSegment[];
  onAddMarker: (frame: number) => void;
  onRemoveMarker: (id: string) => void;
  onMoveMarker: (id: string, frame: number) => void;
  onPlayAcross: (frame: number) => void;
  hoveredSegmentId: string | null;
  selectedSegmentId: string | null;
  onHoverSegment: (id: string | null) => void;
}

/** The optional cropper layer: the two trim handles and the callbacks that move them. */
interface CropLayer {
  inFrame: number;
  outFrame: number;
  onMoveIn: (frame: number) => void;
  onMoveOut: (frame: number) => void;
}

/**
 * The waveform lane: one canvas painting only the peaks, with the silence bands, the playhead, the
 * cut markers, and the segment highlight as DOM overlays above it. Canvas cannot read theme tokens,
 * so the peak ink is read from `--ink-3` via getComputedStyle at paint and repainted whenever the
 * theme flips or the system scheme changes. The peaks downsample to one min/max column per device
 * pixel, so paint cost follows the lane width, not the bucket count.
 *
 * Zoom is a pure client re-render: a finer step widens the virtual lane and the shared scroll
 * container carries the canvas and every overlay together so they stay aligned. Past fit, an overview
 * strip stands in for the native scrollbar: a second canvas of the whole file, a draggable lens over
 * the visible window, and hairline landmarks for the cuts or the trim edges. Scrubbing maps the
 * pointer x to a time through the full duration. The `edit` layer is optional: with it, a click on
 * the empty lane drops a marker, a click on a marker handle deletes it, and a handle drag moves it.
 * The `crop` layer is the cropper's parallel: two draggable trim handles with the trimmed-away ends
 * dimmed, never a marker in sight.
 */
export function WaveformLane({
  peaks,
  silence,
  totalFrames,
  durationSecs,
  playheadSecs,
  zoom,
  onScrub,
  edit,
  crop,
}: {
  peaks: Peak[];
  silence: SilenceSpan[];
  totalFrames: number;
  durationSecs: number;
  playheadSecs: number;
  zoom: Zoom;
  onScrub: (secs: number) => void;
  edit?: MarkerLayer;
  crop?: CropLayer;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  // The visible width of the scroll viewport, tracked so the virtual lane and the canvas size off it.
  const [viewportW, setViewportW] = useState(0);
  // The live scroll offset of the zoomed lane. The overview's lens rides it; a wheel or trackpad pan
  // of the main lane updates it through onScroll, so the lens follows either way.
  const [scrollLeft, setScrollLeft] = useState(0);
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);

  const laneWidth = Math.round(viewportW * ZOOM_FACTOR[zoom]);
  // The overview only earns its keep once the lane overflows the viewport; at fit there is nothing to
  // navigate, so it never renders.
  const hasOverview = laneWidth > viewportW;

  // Paints both canvases from the one peak array and the one theme ink. The lane carries
  // `color: var(--ink-3)`, so its resolved color is the peak ink in concrete rgb - the token seam
  // without a hard-coded fallback, re-resolved whenever the theme flips. The canvases differ only in
  // width: the main lane is the zoomed file, the overview is the whole file at the viewport width.
  const paintAll = useCallback(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const color = getComputedStyle(lane).color;
    const canvas = canvasRef.current;
    if (canvas) drawPeaks(canvas, peaks, color);
    const overview = overviewCanvasRef.current;
    if (overview) drawPeaks(overview, peaks, color);
  }, [peaks]);

  // Hold the latest paint so the theme observers, which outlive a single render, always call the
  // current closure over the current peaks.
  const paintRef = useRef(paintAll);
  paintRef.current = paintAll;

  // Track the viewport width: the lane sizes off it, and a width or DPR change repaints.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measure = () => setViewportW(scroll.clientWidth);
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      paintRef.current();
    });
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  // Repaint on the token seam: the manual theme toggle stamps data-theme on the root, and the system
  // scheme shifts under the un-stamped default. Both change what `--ink-3` resolves to.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => paintRef.current());
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => paintRef.current();
    media.addEventListener("change", onScheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onScheme);
    };
  }, []);

  // Repaint whenever the peaks or the lane size change. laneWidth flipping past the viewport also
  // mounts the overview canvas, so this covers its first paint too.
  useEffect(() => {
    paintAll();
  }, [paintAll, laneWidth, hasOverview]);

  // Track the live scroll offset so the lens can read a post-clamp value: the browser clamps
  // scrollLeft on a resize or a zoom-out, and that fires scroll, so the state stays valid.
  const onScroll = () => {
    const scroll = scrollRef.current;
    if (scroll) setScrollLeft(scroll.scrollLeft);
  };

  // Pan from the overview: the pointer's fraction across the strip centers the visible window there,
  // clamped to the scrollable range. Setting scrollLeft moves the lane; the lens state is also updated
  // straight from the clamped result, since a programmatic scrollLeft does not reliably fire onScroll
  // (so relying on it alone would leave the lens lagging behind a drag).
  const panning = useRef(false);
  const panTo = (clientX: number) => {
    const el = overviewRef.current;
    const scroll = scrollRef.current;
    if (!el || !scroll) return;
    const rect = el.getBoundingClientRect();
    const frac = clamp01((clientX - rect.left) / rect.width);
    const max = Math.max(0, laneWidth - viewportW);
    scroll.scrollLeft = Math.min(max, Math.max(0, frac * laneWidth - viewportW / 2));
    // Drive the lens off the browser's clamped value rather than waiting for a scroll event.
    setScrollLeft(scroll.scrollLeft);
  };
  const onOverviewDown = (e: PointerEvent<HTMLDivElement>) => {
    panning.current = true;
    e.currentTarget.dataset.panning = "";
    e.currentTarget.setPointerCapture(e.pointerId);
    panTo(e.clientX);
  };
  const onOverviewMove = (e: PointerEvent<HTMLDivElement>) => {
    if (panning.current) panTo(e.clientX);
  };
  const onOverviewUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!panning.current) return;
    panning.current = false;
    delete e.currentTarget.dataset.panning;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // The seconds under the pointer, from its x within the lane. The lane spans the whole file, so the
  // time maps through the full duration regardless of zoom or scroll offset.
  const secsFromPointer = (clientX: number): number => {
    const lane = laneRef.current;
    if (!lane || durationSecs <= 0) return 0;
    const rect = lane.getBoundingClientRect();
    return clamp01((clientX - rect.left) / rect.width) * durationSecs;
  };

  // The frame under a client x, mapped through the whole file the same way.
  const frameFromClientX = (clientX: number): number => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    return Math.round(clamp01((clientX - rect.left) / rect.width) * totalFrames);
  };

  // Scrub state: a press that stays within the slop is a click (drops a marker); once it passes the
  // slop it is a scrub drag and no marker lands on release.
  const scrub = useRef<{ x: number; dragged: boolean } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    scrub.current = { x: e.clientX, dragged: false };
    laneRef.current?.setPointerCapture(e.pointerId);
    onScrub(secsFromPointer(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = scrub.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) > DRAG_SLOP) s.dragged = true;
    onScrub(secsFromPointer(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const s = scrub.current;
    if (!s) return;
    scrub.current = null;
    laneRef.current?.releasePointerCapture(e.pointerId);
    if (!s.dragged && edit) edit.onAddMarker(frameFromClientX(e.clientX));
  };

  // Marker drag: a press on a handle either deletes it (click) or moves it (drag). The handle owns
  // the pointer so a drag that leaves it keeps steering, and the lane never scrubs under it.
  const markerDrag = useRef<{ id: string; x: number; dragged: boolean } | null>(null);
  const onHandleDown = (e: PointerEvent<HTMLDivElement>, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    markerDrag.current = { id, x: e.clientX, dragged: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = markerDrag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) > DRAG_SLOP) d.dragged = true;
    if (d.dragged && edit) edit.onMoveMarker(d.id, frameFromClientX(e.clientX));
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>, id: string) => {
    const d = markerDrag.current;
    if (!d) return;
    e.stopPropagation();
    markerDrag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d.dragged && edit) edit.onRemoveMarker(id);
  };

  // Trim-handle drag: a press on either handle steers its trim point through the pointer, capturing so
  // the drag keeps tracking off the handle and the lane never scrubs under it. No click action - the
  // cropper's handles only move, never delete.
  const trimDrag = useRef<"in" | "out" | null>(null);
  const onTrimDown = (e: PointerEvent<HTMLDivElement>, which: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    trimDrag.current = which;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onTrimMove = (e: PointerEvent<HTMLDivElement>) => {
    const which = trimDrag.current;
    if (!which || !crop) return;
    const frame = frameFromClientX(e.clientX);
    if (which === "in") crop.onMoveIn(frame);
    else crop.onMoveOut(frame);
  };
  const onTrimUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!trimDrag.current) return;
    e.stopPropagation();
    trimDrag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const playheadPct = durationSecs > 0 ? clamp01(playheadSecs / durationSecs) * 100 : 0;

  // The segment the highlight tracks: a hovered row wins over a selected one. Its span bands the lane
  // and its bounding markers light up.
  const activeSeg = useMemo(() => {
    if (!edit) return null;
    const id = edit.hoveredSegmentId ?? edit.selectedSegmentId;
    if (id == null) return null;
    return edit.segments.find((s) => s.id === id) ?? null;
  }, [edit]);

  const pct = (frame: number) => (totalFrames > 0 ? (frame / totalFrames) * 100 : 0);

  // The lens over the overview: it maps the visible window onto the full strip. The overview spans the
  // viewport width, so the scroll offset and the visible slice scale straight through laneWidth.
  const lensLeft = laneWidth > 0 ? (scrollLeft / laneWidth) * viewportW : 0;
  const lensWidth = laneWidth > 0 ? (viewportW / laneWidth) * viewportW : viewportW;

  return (
    <div className={styles.wrap}>
      <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
        <div
          className={styles.lane}
          ref={laneRef}
          style={{ width: laneWidth || "100%" } as CSSProperties}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <canvas className={styles.canvas} ref={canvasRef} />
          {silence.map((span, i) => {
            const left = pct(span.start_frame);
            const width = pct(span.end_frame - span.start_frame);
            return (
              <div
                key={i}
                className={styles.silence}
                style={{ left: `${left}%`, width: `${width}%` }}
                aria-hidden="true"
              />
            );
          })}

          {activeSeg ? (
            <div
              className={styles.highlight}
              style={{ left: `${pct(activeSeg.start)}%`, width: `${pct(activeSeg.end - activeSeg.start)}%` }}
              aria-hidden="true"
            />
          ) : null}

          {edit
            ? edit.markers.map((m) => {
                const bound =
                  activeSeg != null && (activeSeg.start === m.frame || activeSeg.end === m.frame);
                const shown = hoveredMarker === m.id;
                return (
                  <div key={m.id} className={styles.marker} style={{ left: `${pct(m.frame)}%` }}>
                    <div className={styles.markerLine} data-bound={bound ? "" : undefined} aria-hidden="true" />
                    <div
                      className={styles.handle}
                      role="button"
                      tabIndex={0}
                      aria-label={t((d) => d.splice.removeMarker)}
                      data-bound={bound ? "" : undefined}
                      onPointerDown={(e) => onHandleDown(e, m.id)}
                      onPointerMove={onHandleMove}
                      onPointerUp={(e) => onHandleUp(e, m.id)}
                      onPointerCancel={(e) => onHandleUp(e, m.id)}
                      onPointerEnter={() => {
                        setHoveredMarker(m.id);
                        edit.onHoverSegment(m.id);
                      }}
                      onPointerLeave={() => {
                        setHoveredMarker(null);
                        edit.onHoverSegment(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          edit.onRemoveMarker(m.id);
                        }
                      }}
                    />
                    {shown ? (
                      <button
                        type="button"
                        className={styles.across}
                        aria-label={t((d) => d.splice.playAcross)}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          edit.onPlayAcross(m.frame);
                        }}
                      >
                        <Play size={11} strokeWidth={2} />
                      </button>
                    ) : null}
                  </div>
                );
              })
            : null}

          {crop ? (
            <>
              {/* The trimmed-away ends read as dimmed veil, never danger: the source is never modified. */}
              <div
                className={styles.trimVeil}
                style={{ left: 0, width: `${pct(crop.inFrame)}%` }}
                aria-hidden="true"
              />
              <div
                className={styles.trimVeil}
                style={{ left: `${pct(crop.outFrame)}%`, right: 0 }}
                aria-hidden="true"
              />
              <div className={styles.trimHandle} style={{ left: `${pct(crop.inFrame)}%` }}>
                <div className={styles.trimLine} aria-hidden="true" />
                <div
                  className={styles.trimGrip}
                  role="button"
                  tabIndex={0}
                  aria-label={t((d) => d.splice.trimHandleIn)}
                  onPointerDown={(e) => onTrimDown(e, "in")}
                  onPointerMove={onTrimMove}
                  onPointerUp={onTrimUp}
                  onPointerCancel={onTrimUp}
                />
              </div>
              <div className={styles.trimHandle} style={{ left: `${pct(crop.outFrame)}%` }}>
                <div className={styles.trimLine} aria-hidden="true" />
                <div
                  className={styles.trimGrip}
                  role="button"
                  tabIndex={0}
                  aria-label={t((d) => d.splice.trimHandleOut)}
                  onPointerDown={(e) => onTrimDown(e, "out")}
                  onPointerMove={onTrimMove}
                  onPointerUp={onTrimUp}
                  onPointerCancel={onTrimUp}
                />
              </div>
            </>
          ) : null}

          <div className={styles.playhead} style={{ left: `${playheadPct}%` }} aria-hidden="true" />
        </div>
      </div>

      {hasOverview ? (
        <div
          className={styles.overview}
          ref={overviewRef}
          onPointerDown={onOverviewDown}
          onPointerMove={onOverviewMove}
          onPointerUp={onOverviewUp}
          onPointerCancel={onOverviewUp}
        >
          <canvas className={styles.overviewCanvas} ref={overviewCanvasRef} />

          {silence.map((span, i) => (
            <div
              key={i}
              className={styles.ovSilence}
              style={{ left: `${pct(span.start_frame)}%`, width: `${pct(span.end_frame - span.start_frame)}%` }}
              aria-hidden="true"
            />
          ))}

          {/* Landmark ticks: one hairline per cut so a glance at the strip finds the cuts up close. */}
          {edit
            ? edit.markers.map((m) => (
                <div
                  key={m.id}
                  className={styles.ovTick}
                  style={{ left: `${pct(m.frame)}%` }}
                  aria-hidden="true"
                />
              ))
            : null}

          {/* The cropper's trimmed ends dim faintly and the two kept edges get an accent hairline. */}
          {crop ? (
            <>
              <div className={styles.ovVeil} style={{ left: 0, width: `${pct(crop.inFrame)}%` }} aria-hidden="true" />
              <div className={styles.ovVeil} style={{ left: `${pct(crop.outFrame)}%`, right: 0 }} aria-hidden="true" />
              <div className={styles.ovEdge} style={{ left: `${pct(crop.inFrame)}%` }} aria-hidden="true" />
              <div className={styles.ovEdge} style={{ left: `${pct(crop.outFrame)}%` }} aria-hidden="true" />
            </>
          ) : null}

          <div className={styles.ovPlayhead} style={{ left: `${playheadPct}%` }} aria-hidden="true" />
          <div className={styles.window} style={{ left: `${lensLeft}px`, width: `${lensWidth}px` }} aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

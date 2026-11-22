// -- Hook Imports --
import { useFeedControl } from "../../../../state/player/pluginVis/feedControl";
import { useStageReadout, type MeterReading } from "../../../../state/player/pluginVis/stageReadout";

// -- State Imports --
import { useDevMode } from "../../../../state/plugins/store";
import type { StageSurface } from "../../../../state/player/pluginVis/frameCache";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./StageReadout.module.css";

interface Props {
  kind: string;
  surface: StageSurface;
  // Whether this kind is the stage's shown kind.
  shown: boolean;
}

const METER_KEY = {
  on: "meterOn",
  unwatched: "meterOff",
  unknown: "meterUnknown",
} as const satisfies Record<MeterReading, string>;

/**
 * The developer-mode readout on a live plugin stage: frame rate, frame cost, ticks in flight and the flash
 * meter, with a Record feed button. It renders nothing, and samples nothing, unless developer mode is on and
 * the kind is shown. Only the button takes pointer events; the chip is a sibling of the inert frame slot.
 * It ignores Ambient's idle fade on purpose, because it is developer-only.
 */
export function StageReadout({ kind, surface, shown }: Props) {
  const devMode = useDevMode();
  if (!devMode || !shown) return null;
  return <Chip kind={kind} surface={surface} />;
}

function Chip({ kind, surface }: Omit<Props, "shown">) {
  const t = useT();
  const r = useStageReadout(kind, surface, true);
  const [feed, press] = useFeedControl(kind);
  const o = (key: "fps" | "frameTime" | "inFlight" | "meter") => t((d) => d.plugins.vis.readout[key]);
  const none = "-";
  const outcome = feed.outcome;
  const line = !outcome
    ? null
    : outcome.ok
      ? t((d) => d.plugins.vis.readout.saved, { file: outcome.file })
      : [t((d) => d.plugins.vis.readout[outcome.reason]), outcome.detail].filter(Boolean).join(" ");
  const cell = (label: string, value: string) => (
    <span className={styles.cell}>
      <span className={styles.value}>{value}</span>
      <span className={styles.label}>{label}</span>
    </span>
  );
  return (
    <div className={styles.chip} role="group" aria-label={t((d) => d.plugins.vis.readout.label)}>
      <div className={styles.cells}>
        {cell(o("fps"), r.fps === null ? none : String(r.fps))}
        {cell(o("frameTime"), r.frameMs ?? none)}
        {cell(o("inFlight"), r.inFlight === null ? none : String(r.inFlight))}
        {cell(
          o("meter"),
          t((d) => d.plugins.vis.readout[METER_KEY[r.meter]]),
        )}
      </div>
      {feed.phase === "recording" ? (
        <span className={styles.count}>{t((d) => d.plugins.vis.readout.recording, { s: feed.secs })}</span>
      ) : null}
      <button type="button" className={styles.button} disabled={feed.phase === "saving"} onClick={press}>
        {t((d) =>
          feed.phase === "saving"
            ? d.plugins.vis.readout.saving
            : feed.phase === "recording"
              ? d.plugins.vis.readout.stop
              : d.plugins.vis.readout.record,
        )}
      </button>
      {line ? (
        <p className={styles.line} role="status">
          {line}
        </p>
      ) : null}
    </div>
  );
}

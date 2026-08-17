// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { Segment } from "../common/SegmentedControl";

// -- Style Imports --
import styles from "./ExportSections.module.css";

/** The shape each included playlist takes: a flat mimic album, or a portable .m3u8 playlist file. */
export type PlaylistShape = "mimic" | "file";

/** Which top-level section a toggle drives. */
type Section = "albums" | "singles" | "playlists";

/**
 * The include control: three switches for the top-level sections, and - only when Playlists is on - a
 * segmented Mimic/Mirror shape choice. Each switch fills cyan when on, the one chromatic affordance
 * here; the shape control stays accent-free, so the Export CTA keeps the sole solid accent. Gating the
 * "at least one on" rule lives in the caller, which disables the CTA when every section is off.
 */
export function ExportSections({
  albums,
  singles,
  playlists,
  shape,
  onToggle,
  onShape,
}: {
  albums: boolean;
  singles: boolean;
  playlists: boolean;
  shape: PlaylistShape;
  onToggle: (section: Section, value: boolean) => void;
  onShape: (shape: PlaylistShape) => void;
}) {
  const t = useT();

  const shapeSegments: Segment<PlaylistShape>[] = [
    { value: "mimic", label: t((d) => d.export.shape.mimic) },
    { value: "file", label: t((d) => d.export.shape.file) },
  ];

  return (
    <div className={styles.sections}>
      <SectionSwitch
        label={t((d) => d.export.sections.albums)}
        checked={albums}
        onChange={(v) => onToggle("albums", v)}
      />
      <SectionSwitch
        label={t((d) => d.export.sections.singles)}
        checked={singles}
        onChange={(v) => onToggle("singles", v)}
      />
      <SectionSwitch
        label={t((d) => d.export.sections.playlists)}
        checked={playlists}
        onChange={(v) => onToggle("playlists", v)}
      />
      {playlists ? (
        <div className={styles.shape}>
          <SegmentedControl
            segments={shapeSegments}
            value={shape}
            onChange={onShape}
            label={t((d) => d.export.shape.label)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** One labelled switch row: the section name beside a pill that fills cyan when on. */
function SectionSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.name}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={styles.switch}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} aria-hidden="true" />
      </button>
    </div>
  );
}

// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- Type Imports --
import type { Zoom } from "./WaveformLane";

// -- i18n Imports --
import { useT } from "../../i18n";

/** The stepped waveform zoom: fit the whole file, or widen it for closer placement. No slider. */
export function ZoomControl({ zoom, onZoom }: { zoom: Zoom; onZoom: (zoom: Zoom) => void }) {
  const t = useT();
  return (
    <SegmentedControl<Zoom>
      segments={[
        { value: "fit", label: t((d) => d.splice.zoomFit) },
        { value: "medium", label: t((d) => d.splice.zoomMedium) },
        { value: "fine", label: t((d) => d.splice.zoomFine) },
      ]}
      value={zoom}
      onChange={onZoom}
      label={t((d) => d.splice.zoomLabel)}
    />
  );
}

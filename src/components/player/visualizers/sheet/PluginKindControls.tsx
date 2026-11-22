// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Component Imports --
import { SegmentedControl } from "../../../common/SegmentedControl";
import { Select } from "../../../common/Select/Select";
import { Switch } from "../../../common/Switch/Switch";

// -- State Imports --
import { createDebouncedWrite, type DebouncedWrite } from "../../../../state/player/pluginVis/debouncedWrite";
import { useKindSettings } from "../../../../state/player/pluginVis/useKindSettings";

// -- Type Imports --
import type { Segment } from "../../../common/SegmentedControl";
import type { PluginVisualizerSetting } from "../../../../state/plugins/visualizerDecl";
import type { PluginVisualizerDescriptor } from "../../../../state/player/pluginVisualizers";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
// The rows wear the EQ preset row's compact stretch.
import rowStyles from "../../../sound/PresetRow.module.css";
import footer from "./SheetFooter.module.css";
import styles from "./PluginKindControls.module.css";

// A choice with more options than this is a select rather than a segmented control.
const SEGMENT_MAX = 4;
// The value of the preset row's "Custom" entry, which no preset can have.
const CUSTOM = "";
// A color input's value while the setting is on the cover palette.
const COVER_SWATCH = "#808080";

/**
 * A fast input's value: held locally while it is dragged and written once it pauses, on blur and on
 * unmount, so a drag does not write the preference on every input event.
 */
function useDraft<T>(value: T, commit: (value: T) => void) {
  const [draft, setDraft] = useState<{ value: T } | null>(null);
  const latest = useRef(commit);
  latest.current = commit;
  const write = useRef<DebouncedWrite<T> | null>(null);
  if (!write.current) write.current = createDebouncedWrite((v) => latest.current(v));
  // The stored value took over: the draft has been written.
  useEffect(() => setDraft(null), [value]);
  useEffect(() => () => write.current?.flush(), []);
  return {
    shown: draft ? draft.value : value,
    change: (next: T) => {
      setDraft({ value: next });
      write.current?.push(next);
    },
    flush: () => write.current?.flush(),
    now: (next: T) => {
      write.current?.cancel();
      setDraft(null);
      latest.current(next);
    },
  };
}

/** One row of options as a segmented control, or a select past `SEGMENT_MAX`. */
function Choice({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  if (options.length > SEGMENT_MAX) {
    return (
      <Select
        value={value}
        options={options.map((o) => ({ value: o.id, label: o.label }))}
        onChange={onChange}
        ariaLabel={label}
      />
    );
  }
  const segments: Segment<string>[] = options.map((o) => ({ value: o.id, label: o.label }));
  return (
    <div className={rowStyles.compact}>
      <SegmentedControl segments={segments} value={value} onChange={onChange} label={label} />
    </div>
  );
}

function Range({
  setting,
  value,
  onChange,
}: {
  setting: Extract<PluginVisualizerSetting, { type: "range" }>;
  value: number;
  onChange: (value: number) => void;
}) {
  const draft = useDraft(value, onChange);
  return (
    <div className={styles.range}>
      <input
        type="range"
        className={styles.slider}
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={draft.shown}
        aria-label={setting.label}
        onChange={(e) => draft.change(Number(e.target.value))}
        onBlur={draft.flush}
      />
      <span className={styles.value}>{draft.shown}</span>
    </div>
  );
}

function Color({
  setting,
  value,
  onChange,
}: {
  setting: Extract<PluginVisualizerSetting, { type: "color" }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const draft = useDraft(value, onChange);
  const shown = draft.shown;
  const onCover = shown === "cover";
  return (
    <div className={styles.color}>
      <input
        type="color"
        className={onCover ? `${styles.swatch} ${styles.dim}` : styles.swatch}
        value={onCover ? COVER_SWATCH : shown}
        aria-label={setting.label}
        onChange={(e) => draft.change(e.target.value)}
        onBlur={draft.flush}
      />
      <button
        type="button"
        className={styles.cover}
        aria-pressed={onCover}
        onClick={() => draft.now("cover")}
      >
        {t((d) => d.player.visualizerColorCover)}
      </button>
    </div>
  );
}

/**
 * The picked plugin kind's own controls, drawn as the layout row is: one labelled group per setting, in
 * the manifest's order and wording, and a preset row first when it declares presets. Values live in the
 * one settings preference, so a change reaches the shown frame and the next mount alike.
 */
export function PluginKindControls({ descriptor }: { descriptor: PluginVisualizerDescriptor }) {
  const t = useT();
  const { values, preset, set, choosePreset } = useKindSettings(descriptor);
  const presetLabel = t((d) => d.player.visualizerPreset);
  const presets = descriptor.presets.map((p) => ({ id: p.id, label: p.label }));
  if (preset === null) presets.push({ id: CUSTOM, label: t((d) => d.player.visualizerPresetCustom) });

  const control = (setting: PluginVisualizerSetting) => {
    const value = values[setting.id];
    switch (setting.type) {
      case "choice":
        return (
          <Choice
            options={setting.options}
            value={String(value)}
            onChange={(v) => set(setting.id, v)}
            label={setting.label}
          />
        );
      case "toggle":
        return (
          <div className={styles.toggle}>
            <Switch checked={value === true} onChange={(on) => set(setting.id, on)} label={setting.label} />
          </div>
        );
      case "range":
        return <Range setting={setting} value={Number(value)} onChange={(v) => set(setting.id, v)} />;
      case "color":
        return <Color setting={setting} value={String(value)} onChange={(v) => set(setting.id, v)} />;
    }
  };

  return (
    <>
      {descriptor.presets.length > 0 ? (
        <div className={footer.group}>
          <span className={footer.label}>{presetLabel}</span>
          <Choice
            options={presets}
            value={preset ?? CUSTOM}
            onChange={(id) => id !== CUSTOM && choosePreset(id)}
            label={presetLabel}
          />
        </div>
      ) : null}
      {descriptor.settings.map((setting) => (
        <div key={setting.id} className={footer.group}>
          <span className={footer.label}>{setting.label}</span>
          {control(setting)}
        </div>
      ))}
    </>
  );
}

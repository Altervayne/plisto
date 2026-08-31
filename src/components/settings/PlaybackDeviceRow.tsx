// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Component Imports --
import { Select } from "../common/Select/Select";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";
import { useCurrentOutputDevice } from "../../state/player/store";

// -- IPC Imports --
import { listOutputDevices, playerSetOutputDevice } from "../../lib/ipc";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { OutputDeviceInfo } from "../../types";
import type { SelectOption } from "../common/Select/Select";

// -- Style Imports --
import styles from "./PlaybackDeviceRow.module.css";

/**
 * The output-device picker: a Select over "System default" plus every device, marking the OS default.
 * An empty pref means System default, so the engine follows the OS; a name pins one device and the
 * engine switches live. The device list refreshes on mount and each time the menu opens, so hardware
 * plugged in while Settings sits open shows up. When following the default, a quiet line names the
 * device actually playing.
 */
export function PlaybackDeviceRow() {
  const value = usePreference(PREF_KEYS.outputDevice) ?? "";
  const setPreference = useSetPreference();
  const liveDevice = useCurrentOutputDevice();
  const t = useT();

  const [devices, setDevices] = useState<OutputDeviceInfo[]>([]);
  const alive = useRef(true);

  // Best-effort: a rejected list leaves it empty, so System default stays selectable regardless. The
  // alive ref drops a late resolve after unmount, since the menu can be reopened right before it.
  const refresh = () => {
    void listOutputDevices()
      .then((list) => {
        if (alive.current) setDevices(list);
      })
      .catch(() => {});
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
    };
  }, []);

  const options: SelectOption[] = [
    { value: "", label: t((d) => d.settings.systemDefault) },
    ...devices.map((device) => ({
      value: device.name,
      label: device.name,
      hint: device.is_default ? t((d) => d.settings.deviceDefaultHint) : undefined,
    })),
  ];

  const onChange = (next: string) => {
    setPreference(PREF_KEYS.outputDevice, next);
    // Empty string persists System default; the engine reads null to follow the OS default.
    void playerSetOutputDevice(next === "" ? null : next).catch(() => {});
  };

  return (
    <div className={styles.control}>
      <Select
        value={value}
        options={options}
        onChange={onChange}
        onOpen={refresh}
        ariaLabel={t((d) => d.settings.outputDevice)}
      />
      {value === "" && liveDevice ? (
        <p className={styles.readout}>{t((d) => d.settings.playingOn, { device: liveDevice })}</p>
      ) : null}
    </div>
  );
}

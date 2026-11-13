// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Component Imports --
import { Toast } from "../common/Toast/Toast";
import { QuietButton } from "../common/QuietButton";
import { PluginIcon } from "./PluginIcon";
import { PluginTag } from "./PluginTag";

// -- State Imports --
import { usePlugins } from "../../state/plugins/store";
import { answerPluginToast, usePluginToast } from "../../state/plugins/pluginToast";

// -- Utils Imports --
import { toastLine } from "./toastLine";

// -- Type Imports --
import type { ToastLine } from "./toastLine";

// -- Style Imports --
import styles from "./PluginToast.module.css";

/**
 * The pill for the plugin toast at the head of the queue: the plugin's icon, manifest name and tag, then
 * its text and an optional action. The text is drawn as a text node only. A toast whose plugin is no
 * longer listed is answered dismissed and never drawn. The last drawn line is kept through the fade-out.
 */
export function PluginToast() {
  const { toast, visible } = usePluginToast();
  const rows = usePlugins();
  const row = toast ? rows.find((r) => r.id === toast.id) : undefined;
  const line = toast ? toastLine(row, toast) : null;

  useEffect(() => {
    if (visible && toast && !line) answerPluginToast(toast.request_id, false);
  }, [visible, toast, line]);

  const lastLine = useRef<ToastLine | null>(null);
  if (line) lastLine.current = line;
  const shown = line ?? lastLine.current;
  if (!toast || !shown) return null;

  return (
    <Toast visible={visible && line != null} plugin className={styles.pill}>
      <span className={styles.icon}>
        <PluginIcon
          source={row?.manifest ? { kind: "installed", id: row.id, hash: row.manifest_hash } : null}
          size={16}
        />
      </span>
      <span className={styles.name}>{shown.name}</span>
      {shown.tag ? <PluginTag kind={shown.tag} /> : null}
      <span className={styles.text}>{shown.text}</span>
      {shown.action ? (
        <QuietButton onClick={() => answerPluginToast(toast.request_id, true)}>{shown.action}</QuietButton>
      ) : null}
    </Toast>
  );
}

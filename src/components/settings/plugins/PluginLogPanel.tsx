// -- Framework Imports --
import { useLayoutEffect, useMemo, useRef } from "react";

// -- Component Imports --
import { SegmentedControl } from "../../common/SegmentedControl";

// -- Hook Imports --
import { useLogTail } from "./useLogTail";

// -- Utils Imports --
import { parseLogLine } from "../../../state/plugins/logLines";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginRow } from "../../../types";
import type { LogTailView } from "./useLogTail";

// -- Style Imports --
import styles from "./PluginLogPanel.module.css";

// Within this many pixels of the end, a new line keeps the view pinned to the end.
const PIN_SLACK = 24;

/** The lines of one log, parsed and kept scrolled to the newest unless the reader moved up. */
function LogLines({ lines }: { lines: string[] }) {
  const parsed = useMemo(() => lines.map(parseLogLine), [lines]);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [parsed]);

  return (
    <div
      ref={box}
      className={styles.lines}
      role="log"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
      }}
    >
      {parsed.map((line, i) => (
        <div key={i} className={`${styles.line} ${line.warn ? styles.warn : ""}`}>
          {line.time ? (
            <>
              <span className={styles.time}>{line.time}</span>
              <span>{line.level}</span>
              <span className={styles.text}>{line.text}</span>
            </>
          ) : (
            <span className={`${styles.text} ${styles.whole}`}>{line.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The panel for one read of the selected plugin's log. */
export function LogPanelView({
  rows,
  activeId,
  onSelect,
  nested = false,
  view: { tail, failed },
}: {
  rows: PluginRow[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Opened in its own plugin's family: a label in place of the tabs, one step deeper than its surface. */
  nested?: boolean;
  view: LogTailView;
}) {
  const t = useT();
  const segments = rows.map((row) => ({ value: row.id, label: row.manifest?.name ?? row.id }));

  return (
    <div className={nested ? `${styles.panel} ${styles.nested}` : styles.panel}>
      {nested ? (
        <span className={styles.sub}>{t((d) => d.plugins.devMode.logLabel)}</span>
      ) : (
        <SegmentedControl
          segments={segments}
          value={activeId}
          onChange={onSelect}
          label={t((d) => d.plugins.devMode.logLabel)}
        />
      )}
      {failed ? <p className={styles.note}>{t((d) => d.plugins.devMode.logFailed)}</p> : null}
      {tail === null && !failed ? <p className={styles.note}>{t((d) => d.plugins.devMode.logLoading)}</p> : null}
      {tail !== null && tail.plugin.length === 0 ? (
        <p className={styles.note}>{t((d) => d.plugins.devMode.logEmpty)}</p>
      ) : null}
      {tail !== null && tail.plugin.length > 0 ? <LogLines lines={tail.plugin} /> : null}
      {tail?.stderr ? (
        <>
          <span className={styles.sub}>{t((d) => d.plugins.devMode.logStderr)}</span>
          {tail.stderr.length > 0 ? (
            <LogLines lines={tail.stderr} />
          ) : (
            <p className={styles.note}>{t((d) => d.plugins.devMode.logEmpty)}</p>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * The developer-mode log: a tab per installed plugin over the end of its `plugin.log`, and for a native
 * plugin the end of its `stderr.log` below it. Only the selected plugin's log is read.
 */
export function PluginLogPanel(props: Omit<Parameters<typeof LogPanelView>[0], "view">) {
  return <LogPanelView {...props} view={useLogTail(props.activeId)} />;
}

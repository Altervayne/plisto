// -- Framework Imports --
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { DuplicateCopy } from "./DuplicateCopy";

// -- State Imports --
import { useMergeDuplicates } from "../../state/organize/store";
import { useLoadDismissals } from "../../state/duplicates/store";

// -- IPC Imports --
import { dismissDuplicates } from "../../lib/ipc";

// -- Utils Imports --
import { differingFields } from "./copyFacts";
import { refusalText } from "./refusalText";

// -- Type Imports --
import type { CopyFacts } from "./copyFacts";
import type { DuplicateGroup } from "../../state/duplicates/findDuplicates";
import type { MergeReceipt } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./DuplicateSetCard.module.css";

/**
 * One set of possible duplicates: the shared title and artist with Not duplicates, then the copies side
 * by side. Keep this one merges the others into that copy; a refusal shows inline and changes nothing.
 */
export function DuplicateSetCard({
  group,
  copies,
  onMerged,
}: {
  group: DuplicateGroup;
  copies: CopyFacts[];
  onMerged: (receipt: MergeReceipt, filename: string) => void;
}) {
  const t = useT();
  const merge = useMergeDuplicates();
  const loadDismissals = useLoadDismissals();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const differing = useMemo(() => differingFields(copies), [copies]);

  const keep = async (keeper: CopyFacts) => {
    setBusy(true);
    setError(null);
    try {
      const others = group.trackIds.filter((id) => id !== keeper.id);
      onMerged(await merge(keeper.id, others), keeper.filename);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const notDuplicates = async () => {
    setBusy(true);
    setError(null);
    try {
      await dismissDuplicates(group.trackIds);
      await loadDismissals();
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-label={`${group.title} - ${group.artist}`}>
      <div className={styles.head}>
        <div className={styles.names}>
          <span className={styles.title}>{group.title}</span>
          <span className={styles.artist}>{group.artist}</span>
        </div>
        <QuietButton onClick={() => void notDuplicates()} disabled={busy}>
          {t((d) => d.duplicates.notDuplicates)}
        </QuietButton>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div
        className={styles.copies}
        style={{ "--copy-cols": Math.min(copies.length, 3) } as CSSProperties}
      >
        {copies.map((copy) => (
          <DuplicateCopy
            key={copy.id}
            copy={copy}
            differing={differing}
            busy={busy}
            onKeep={() => void keep(copy)}
          />
        ))}
      </div>
    </section>
  );
}

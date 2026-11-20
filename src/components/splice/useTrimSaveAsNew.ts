// -- Framework Imports --
import { useCallback, useState } from "react";

// -- Hook Imports --
import { useSpliceDestination } from "./useSpliceDestination";

// -- State Imports --
import { useAddRootPath } from "../../state/store";

// -- IPC Imports --
import { createSpliceChannel, spliceRun } from "../../lib/ipc";

// -- Utils Imports --
import { sourceStem } from "../../lib/crop";

// -- Type Imports --
import type { CollisionPolicy, SpliceJob, SpliceProgress, SpliceReport } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

/** Which screen the new-file save shows: the trim surface, the live run, or the done report. */
export type NewFilePhase = "editing" | "running" | "done";

/** Where the add-to-library action sits: unstarted, indexing, or done. */
export type AddState = "idle" | "adding" | "added";

/**
 * The trim's save as a new file: the destination and collision config, the run, and its report. The cut
 * is one segment that keeps the source name and its tags verbatim; the source is only read. `onStart`
 * fires as a run begins, so the body can clear its unsaved-edit flag.
 */
export function useTrimSaveAsNew({
  path,
  range,
  canTrim,
  onStart,
}: {
  path: string;
  range: { in: number; out: number };
  canTrim: boolean;
  onStart: () => void;
}) {
  const t = useT();

  const [phase, setPhase] = useState<NewFilePhase>("editing");
  const [collision, setCollision] = useState<CollisionPolicy>("rename");
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SpliceProgress | null>(null);
  const [report, setReport] = useState<SpliceReport | null>(null);
  const [addState, setAddState] = useState<AddState>("idle");

  const { destination, check, checking, pick } = useSpliceDestination();
  const addRootPath = useAddRootPath();

  const onPickDestination = () => {
    setConfirmingRun(false);
    setRunError(null);
    void pick();
  };

  const runTrim = useCallback(async () => {
    if (!destination || !canTrim) return;
    setConfirmingRun(false);
    setRunError(null);
    setProgress(null);
    setReport(null);
    setAddState("idle");
    onStart();
    setPhase("running");

    const channel = createSpliceChannel((tick) => {
      setProgress((prev) => {
        const completed =
          prev && prev.phase === tick.phase ? Math.max(prev.completed, tick.completed) : tick.completed;
        return { ...tick, completed };
      });
    });

    // One segment, no tags of its own: the naming pattern is the source stem (no tokens), so the trimmed
    // file keeps the source's own name. The cropper keeps the source tag verbatim - same track, every
    // field and the cover carried across.
    const job: SpliceJob = {
      source_path: path,
      segments: [{ start_frame: range.in, end_frame: range.out, title: null, artist: null, track_no: null }],
      destination,
      naming_pattern: sourceStem(path),
      collision,
      keep_source_tags: true,
    };

    try {
      setReport(await spliceRun(job, channel));
      setPhase("done");
    } catch {
      // The source is read-only, so a failed run leaves it untouched; drop back with the reason.
      setRunError(t((d) => d.splice.trimFailed));
      setPhase("editing");
    }
  }, [destination, canTrim, path, range.in, range.out, collision, onStart, t]);

  const onRun = useCallback(() => {
    if (check?.non_empty) setConfirmingRun(true);
    else void runTrim();
  }, [check, runTrim]);

  const onAddToLibrary = useCallback(() => {
    if (!destination) return;
    setAddState("adding");
    void addRootPath(destination)
      .then((ok) => setAddState(ok ? "added" : "idle"))
      .catch(() => setAddState("idle"));
  }, [destination, addRootPath]);

  const onTrimAgain = useCallback(() => {
    setReport(null);
    setProgress(null);
    setRunError(null);
    setConfirmingRun(false);
    setAddState("idle");
    setPhase("editing");
  }, []);

  return {
    phase,
    destination,
    check,
    checking,
    collision,
    setCollision,
    confirmingRun,
    setConfirmingRun,
    runError,
    progress,
    report,
    addState,
    onPickDestination,
    onRun,
    runTrim,
    onAddToLibrary,
    onTrimAgain,
  };
}

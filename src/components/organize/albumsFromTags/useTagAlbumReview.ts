// -- Framework Imports --
import { useCallback, useMemo, useState } from "react";

// -- State Imports --
import { useAppStore } from "../../../state/store";
import {
  useCreateAlbumsFromTags,
  useLoadOrganization,
  useOrganizeStore,
} from "../../../state/organize/store";
import { descendantTracks, isLibraryScope } from "../../../state/files/folderTree";
import { groupByAlbumTags } from "../../../state/organize/groupByAlbumTags";
import {
  buildPlans,
  checkFirst,
  defaultChecked,
  defaultChoice,
  needsLook,
  planCounts,
} from "../../../state/organize/tagAlbumReview";

// -- IPC Imports --
import { isStaleProposal } from "../../../lib/ipc";

// -- Type Imports --
import type { TagAlbumReceipt } from "../../../types";
import type { TagAlbumPreview, TagAlbumProposal } from "../../../state/organize/groupByAlbumTags";
import type { TargetChoice } from "../../../state/organize/tagAlbumReview";

/** Which proposals the list shows: all of them, or only the ones worth a look. */
export type ReviewFilter = "all" | "look";

/** Why the review shows an inline line above its list: the preview was rebuilt, or the write failed. */
export type ReviewNotice = "stale" | "error";

/**
 * The proposals for the loose tracks under a scope, read from the live stores at call time. The review
 * takes one snapshot on open and another only after a stale write, so nothing shifts while it is read.
 */
function readPreview(scopeId: string): TagAlbumPreview {
  const { tracks } = useAppStore.getState();
  const { org } = useOrganizeStore.getState();
  const filed = new Set(org.membership.map((r) => r.track_id));
  const loose = tracks.filter((t) => !filed.has(t.id));
  const scoped = isLibraryScope(scopeId) ? loose : descendantTracks(loose, scopeId);
  return groupByAlbumTags(scoped, org.albums, org.membership);
}

function initialChecked(proposals: TagAlbumProposal[]): Set<string> {
  return new Set(proposals.filter(defaultChecked).map((p) => p.key));
}

/**
 * The albums-from-tags review over one scope: the proposal snapshot, the user's checks and targets, the
 * list filter, and the write. A stale write reloads the organization and rebuilds the snapshot in place,
 * raising a notice; the receipt of a landed write switches the sheet to its result.
 */
export function useTagAlbumReview(scopeId: string) {
  const createAlbumsFromTags = useCreateAlbumsFromTags();
  const loadOrganization = useLoadOrganization();

  const [preview, setPreview] = useState(() => readPreview(scopeId));
  const [checked, setChecked] = useState(() => initialChecked(preview.proposals));
  const [choices, setChoices] = useState<Map<string, TargetChoice>>(() => new Map());
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<TagAlbumReceipt | null>(null);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);

  const proposals = preview.proposals;
  const lookCount = useMemo(() => proposals.filter(needsLook).length, [proposals]);
  const visible = useMemo(
    () => (filter === "look" ? proposals.filter(needsLook) : proposals),
    [filter, proposals],
  );
  const plans = useMemo(() => buildPlans(proposals, checked, choices), [proposals, checked, choices]);
  const counts = useMemo(() => planCounts(plans), [plans]);

  const choiceOf = useCallback(
    (p: TagAlbumProposal): TargetChoice => choices.get(p.key) ?? defaultChoice(p),
    [choices],
  );

  // Only rows with a resolved target can be checked; an unpicked multi-match waits for its pick.
  const selectable = useMemo(
    () => visible.filter((p) => choiceOf(p).kind !== "unset"),
    [visible, choiceOf],
  );
  const allChecked = selectable.length > 0 && selectable.every((p) => checked.has(p.key));

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of selectable) {
        if (allChecked) next.delete(p.key);
        else next.add(p.key);
      }
      return next;
    });
  };

  // Picking a target for a row that had none checks it, unless the pick itself needs a look.
  const choose = (p: TagAlbumProposal, choice: TargetChoice) => {
    const wasUnset = choiceOf(p).kind === "unset";
    setChoices((prev) => new Map(prev).set(p.key, choice));
    if (choice.kind === "unset") {
      setChecked((prev) => {
        const next = new Set(prev);
        next.delete(p.key);
        return next;
      });
    } else if (wasUnset && checkFirst(p, choice).length === 0) {
      setChecked((prev) => new Set(prev).add(p.key));
    }
  };

  const rebuild = () => {
    const next = readPreview(scopeId);
    setPreview(next);
    setChecked(initialChecked(next.proposals));
    setChoices(new Map());
    setFilter("all");
  };

  // Background sync deltas wait out the write, so no row shifts between the plans and their receipt.
  const commit = async () => {
    if (plans.length === 0 || pending) return;
    setNotice(null);
    setPending(true);
    useAppStore.getState().holdSync("tagAlbums");
    try {
      setReceipt(await createAlbumsFromTags(plans));
    } catch (e) {
      if (isStaleProposal(e)) {
        await loadOrganization();
        rebuild();
        setNotice("stale");
      } else {
        setNotice("error");
      }
    } finally {
      setPending(false);
      useAppStore.getState().releaseSync("tagAlbums");
    }
  };

  return {
    preview,
    visible,
    lookCount,
    filter,
    setFilter,
    checked,
    allChecked,
    canSelectAll: selectable.length > 0,
    toggle,
    toggleAll,
    choiceOf,
    choose,
    counts,
    canCommit: plans.length > 0 && !pending,
    commit,
    pending,
    receipt,
    notice,
  };
}

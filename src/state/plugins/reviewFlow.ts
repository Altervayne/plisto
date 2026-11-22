/*
 * The review flow behind the hub's one sheet, free of React: an inspected file or an installed plugin
 * becomes a review sheet, and its confirm runs the right commands - install then approve (the plugin
 * lands ready and off), update (then a review of changed permissions when the update asks for more),
 * or enable with consent. Every command runs under the operation lock. An enable or approve that finds
 * the plugin changed under the sheet reloads the list and reopens the review on the fresh manifest,
 * never on old data. No path leaves a busy sheet without an exit: whatever cannot be reviewed ends in a
 * closable notice. A staged copy is discarded when its sheet is cancelled, when the flow goes away, and
 * when an inspection arrives after it went.
 */

// -- State Imports --
import { usePluginsStore } from "./store";
import { reloadPlugins } from "./usePluginsSync";
import { dropInstalledIcons, dropStagedIcon } from "./iconCache";
import {
  afterUpdate,
  consentCommand,
  enableArgs,
  previousFromRow,
  reopensReview,
  subjectFromInspection,
  subjectFromRow,
} from "./review";
import { fileNameOf, reviewState } from "./sheet";
import { logInstallError } from "./errors";
import { notifyBuildReplaced } from "./buildReplaced";
import { clearFamilyFlag } from "./familyFlag";
import { listingChange, reviewLanding } from "./pluginFamily";
import { showPluginNotice } from "./pluginNotice";

// -- IPC Imports --
import {
  pluginApprove,
  pluginDiscard,
  pluginEnable,
  pluginInspect,
  pluginInstall,
  pluginUpdate,
} from "../../lib/ipc";

// -- Type Imports --
import type { PluginErrorKey } from "./errors";
import type { OperationLock } from "./operationLock";
import type { ReviewLead, ReviewPrevious, ReviewSubject } from "./review";
import type { NoticeKind, ReviewState, SheetPhase, SheetState } from "./sheet";
import type { PluginListing, PluginRow } from "../../types";

export interface ReviewFlow {
  getSheet: () => SheetState | null;
  subscribe: (listener: () => void) => () => void;
  /** Inspects a plugin file or folder and opens its review. */
  inspect: (path: string) => Promise<void>;
  /** Opens the review of an installed plugin. False when its manifest cannot be read, so none opened. */
  openReview: (row: PluginRow, previous?: ReviewPrevious | null, lead?: ReviewLead) => boolean;
  /** Runs the open review's confirm. `ticked` is the "I understand" box, `clearData` the delete-saved-data box. */
  confirm: (ticked: boolean, clearData?: boolean) => Promise<void>;
  /** Closes the sheet. Held while a command is running. */
  close: () => void;
  /** Marks the flow as owned again (a remount); `dispose` undoes it. */
  activate: () => void;
  /** Gives up the flow: discards a staged copy still waiting on its sheet. */
  dispose: () => void;
}

const rowOf = (id: string): PluginRow | undefined =>
  usePluginsStore.getState().rows.find((r) => r.id === id);

const discardQuietly = (token: string) =>
  void pluginDiscard(token).catch((e: unknown) => logInstallError("discard", e));

/**
 * `origin` is the Settings section the flow runs in. A plugin installed or moved into the other listing
 * says where it went, since the section the user is looking at does not show it.
 */
export function createReviewFlow(lock: Pick<OperationLock, "run">, origin?: PluginListing): ReviewFlow {
  let sheet: SheetState | null = null;
  let alive = true;
  const listeners = new Set<() => void>();

  /** Replaces the sheet; a staged icon is forgotten once its sheet is gone. */
  const show = (next: SheetState | null) => {
    const prev = sheet;
    sheet = next;
    if (prev?.kind === "review" && prev.token && !(next?.kind === "review" && next.token === prev.token)) {
      dropStagedIcon(prev.token);
    }
    listeners.forEach((l) => l());
  };

  const showNotice = (notice: NoticeKind, name: string, error: PluginErrorKey | null = null) =>
    show({ kind: "notice", notice, name, error });

  const setPhase = (phase: SheetPhase) => {
    if (sheet?.kind === "review") show({ ...sheet, phase });
  };

  const openReview = (row: PluginRow, previous: ReviewPrevious | null = null, lead: ReviewLead = "adopted") => {
    const subject = subjectFromRow(row, previous);
    if (!subject) return false;
    show(reviewState("consent", subject, null, row.manifest_hash, lead));
    return true;
  };

  const inspect = async (path: string) => {
    await lock.run(async () => {
      let inspection;
      try {
        inspection = await pluginInspect(path);
      } catch (e) {
        const key = logInstallError("inspect", e);
        if (alive) showNotice("install", fileNameOf(path), key);
        return;
      }
      if (!alive) {
        discardQuietly(inspection.token);
        return;
      }
      // A folder that exists but is not registered cannot be updated or installed over.
      if (inspection.installed === "") {
        discardQuietly(inspection.token);
        showNotice("unregistered", inspection.name);
        return;
      }
      const subject = subjectFromInspection(inspection, rowOf(inspection.id));
      const mode = inspection.installed === null ? "install" : "update";
      show(reviewState(mode, subject, inspection.token, null));
    });
  };

  /** A review that cannot be redone on fresh data: say so, closably. */
  const reviewUnavailable = async (subject: ReviewSubject) => {
    const loaded = await reloadPlugins();
    if (!loaded) {
      showNotice("stale", subject.name);
      return;
    }
    const fresh = rowOf(subject.id);
    if (!fresh || fresh.state !== "needs_consent") show(null);
    else if (!openReview(fresh, subject.previous, "changed")) showNotice("unreadable", subject.name);
  };

  /**
   * Records consent for what the sheet showed: an install only approves (the plugin stays off), a
   * review of an installed plugin also turns it on.
   */
  const consentReviewed = async (
    kind: "approve" | "enable",
    subject: ReviewSubject,
    hash: string,
    ticked: boolean,
  ): Promise<boolean> => {
    setPhase(kind === "approve" ? "approving" : "enabling");
    try {
      const args = enableArgs(subject, hash, ticked);
      const commit = kind === "approve" ? pluginApprove : pluginEnable;
      usePluginsStore.getState().upsertRow(await commit(args.id, args.grants, args.nativeAck, args.manifestHash));
      show(null);
      return true;
    } catch (e) {
      const key = logInstallError(kind, e);
      if (reopensReview(key)) await reviewUnavailable(subject);
      else showNotice(kind, subject.name, key);
      return false;
    }
  };

  const install = async (s: ReviewState, ticked: boolean, clearData: boolean) => {
    setPhase("installing");
    let row: PluginRow;
    try {
      row = await pluginInstall(s.token!, s.subject.leftoverData && clearData);
    } catch (e) {
      const key = logInstallError("install", e);
      if (key === "already_installed") {
        // Installed since the inspection: the same staged files are an update after all.
        const previous = previousFromRow(rowOf(s.subject.id));
        show({ ...s, mode: "update", phase: "idle", subject: { ...s.subject, previous } });
        return;
      }
      discardQuietly(s.token!);
      showNotice("install", s.subject.name, key);
      return;
    }
    usePluginsStore.getState().upsertRow(row);
    // The staged copy is consumed: nothing may discard it from here on.
    if (sheet?.kind === "review") show({ ...sheet, token: null, hash: row.manifest_hash });
    // A plugin that only adds visualizers lands turned on; every other one stays off.
    const landing = reviewLanding(row);
    const lands = landing?.enablePlugin === true;
    const done = await consentReviewed(lands ? "enable" : "approve", s.subject, row.manifest_hash, ticked);
    if (done && lands && landing) clearFamilyFlag(landing.clearFlag);
    const listing = row.manifest?.listing;
    if (done && origin && listing && listing !== origin) {
      const change = listing === "catalog" ? "added" : "addedToPlugins";
      showPluginNotice({ id: row.id, kind: "listing", change });
    }
  };

  const update = async (s: ReviewState) => {
    setPhase("updating");
    try {
      const done = await pluginUpdate(s.token!);
      dropInstalledIcons(s.subject.id);
      notifyBuildReplaced(s.subject.id);
      const before = rowOf(s.subject.id);
      usePluginsStore.getState().upsertRow(done.row);
      const moved = before ? listingChange(before, done.row) : null;
      if (moved?.clearFlag) clearFamilyFlag(moved.clearFlag);
      if (moved && origin && moved.to !== origin) {
        const change = moved.notice === "ownPage" ? "ownPage" : "managed";
        showPluginNotice({ id: done.row.id, kind: "listing", change });
      }
      if (afterUpdate(done) !== "consent") {
        show(null);
        return;
      }
      const previous = {
        ...(s.subject.previous ?? previousFromRow(undefined)),
        version: done.previous_version,
        author: done.previous_author,
      };
      if (!openReview(done.row, previous, "updated")) showNotice("updatedUnreadable", s.subject.name);
    } catch (e) {
      discardQuietly(s.token!);
      showNotice("update", s.subject.name, logInstallError("update", e));
    }
  };

  const confirm = async (ticked: boolean, clearData = false) => {
    if (!sheet || sheet.kind !== "review" || sheet.phase !== "idle") return;
    const s = sheet;
    await lock.run(async () => {
      if (s.mode === "update") await update(s);
      else if (consentCommand(s.mode) === "enable") await consentReviewed("enable", s.subject, s.hash!, ticked);
      else await install(s, ticked, clearData);
    });
  };

  const close = () => {
    if (!sheet) return;
    if (sheet.kind === "review") {
      if (sheet.phase !== "idle") return;
      if (sheet.token) discardQuietly(sheet.token);
    }
    show(null);
  };

  return {
    getSheet: () => sheet,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    inspect,
    openReview,
    confirm,
    close,
    activate: () => {
      alive = true;
    },
    dispose: () => {
      alive = false;
      if (sheet?.kind === "review" && sheet.token && sheet.phase === "idle") {
        discardQuietly(sheet.token);
        dropStagedIcon(sheet.token);
        sheet = { ...sheet, token: null };
      }
    },
  };
}

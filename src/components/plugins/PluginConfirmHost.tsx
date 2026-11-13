// -- Framework Imports --
import { useCallback, useEffect, useRef } from "react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";
import { PluginIcon } from "./PluginIcon";
import { PluginTag } from "./PluginTag";

// -- State Imports --
import { usePlugins } from "../../state/plugins/store";
import { useCurrentPrompt, usePluginPromptStore } from "../../state/plugins/pluginPrompt";

// -- Utils Imports --
import { tagKind } from "../../state/plugins/trust";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginConfirmHost.module.css";

/**
 * Shows the plugin prompt at the head of the queue as a plugin-variant ConfirmDialog. Cancel, Escape and
 * the backdrop answer false and the confirm answers true. ConfirmDialog calls `onConfirm` and then
 * `onClose` for one press, so each request id is answered once and later calls for it are ignored. A
 * prompt whose plugin is no longer listed is answered false and never drawn.
 */
export function PluginConfirmHost() {
  const t = useT();
  const prompt = useCurrentPrompt();
  const rows = usePlugins();
  const answered = useRef<string | null>(null);

  const requestId = prompt?.request_id ?? null;
  const row = prompt ? rows.find((r) => r.id === prompt.id) : undefined;
  const manifest = row?.manifest ?? null;

  const answer = useCallback(
    (value: boolean) => {
      if (requestId == null || answered.current === requestId) return;
      answered.current = requestId;
      usePluginPromptStore.getState().answer(requestId, value);
    },
    [requestId],
  );

  // Stable, since ConfirmDialog refocuses Cancel whenever its close callback changes.
  const decline = useCallback(() => answer(false), [answer]);

  const orphaned = prompt != null && manifest == null;
  useEffect(() => {
    if (orphaned) decline();
  }, [orphaned, decline]);

  if (!prompt || !row || !manifest) return null;

  const tag = tagKind(row.tier);
  const { title, body, confirm_label, cancel_label } = prompt.payload;
  return (
    <ConfirmDialog
      open
      variant="plugin"
      title={title}
      prompt={body}
      confirmLabel={confirm_label}
      cancelLabel={cancel_label ?? t((d) => d.plugins.ui.promptCancel)}
      onConfirm={() => answer(true)}
      onClose={decline}
      identity={{
        icon: <PluginIcon source={{ kind: "installed", id: row.id, hash: row.manifest_hash }} size={20} />,
        name: manifest.name,
        tag: tag ? <PluginTag kind={tag} /> : undefined,
        line: t((d) => d.plugins.ui.promptFrom),
      }}
    >
      <p className={styles.note}>{t((d) => d.plugins.ui.promptNote, { name: manifest.name })}</p>
    </ConfirmDialog>
  );
}

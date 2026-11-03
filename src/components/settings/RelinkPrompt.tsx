// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- State Imports --
import { useRelinkOffer, useResolveRelink } from "../../state/store";
import type { RelinkChoice } from "../../state/store";

// -- Local Imports --
import { folderName, refusalLine } from "./locateCopy";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./RelinkPrompt.module.css";

/** How long the refusal note holds before it clears itself. */
const NOTICE_MS = 8000;

/**
 * The relink prompt: when a folder just picked for Add looks like an offline root that moved, asks
 * whether to relink that root to it, add it as a new folder, or do neither. Mounted once beside the shell,
 * since Add can start from any screen. Escape or the backdrop cancels. A relink the backend refuses
 * changes nothing, so its reason shows as a note at the foot of the window once the dialog is gone.
 */
export function RelinkPrompt() {
  const offer = useRelinkOffer();
  const resolve = useResolveRelink();
  const t = useT();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (notice == null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const choose = async (choice: RelinkChoice) => {
    if (!offer) return;
    const name = folderName(offer.candidate.path);
    const folder = offer.path;
    const result = await resolve(choice);
    if (result?.kind === "refused") setNotice(refusalLine(t, result.reason, name, folder));
    else if (result?.kind === "busy") setNotice(refusalLine(t, { code: "busy" }, name, folder));
  };

  return (
    <>
      {offer ? (
        <ConfirmDialog
          open
          title={t((d) => d.relink.title, { name: folderName(offer.candidate.path) })}
          prompt={t((d) => d.relink.body, {
            name: folderName(offer.candidate.path),
            folder: offer.path,
            n: offer.candidate.matched,
            total: offer.candidate.sampled,
          })}
          confirmLabel={t((d) => d.relink.action)}
          cancelLabel={t((d) => d.common.cancel)}
          secondary={{ label: t((d) => d.relink.asNew), onClick: () => void choose("asNew") }}
          onConfirm={() => void choose("relink")}
          onClose={() => void choose("cancel")}
          accent
        />
      ) : null}
      {notice ? (
        <button type="button" className={styles.notice} onClick={() => setNotice(null)}>
          {notice}
        </button>
      ) : null}
    </>
  );
}

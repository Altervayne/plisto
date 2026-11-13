// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { Dict } from "../../../../i18n/en";
import type { NoticeState } from "../../../../state/plugins/sheet";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/**
 * A one-button notice that an operation did not go through or could not be reviewed: what happened, the
 * reason in Plisto's words, and what state the plugin is left in. The backend's detail line is never
 * shown here.
 */
export function NoticeView({
  state,
  titleId,
  onClose,
}: {
  state: NoticeState;
  titleId: string;
  onClose: () => void;
}) {
  const t = useT();
  const { name, error } = state;
  const sheet = (pick: (d: Dict) => string) => t(pick, { name });

  let title: string;
  let prompt: string | null = error ? t((d) => d.plugins.errors[error]) : null;
  let after: string;
  switch (state.notice) {
    case "install":
      title = t((d) => d.plugins.sheet.noticeInstallTitle);
      after = t((d) => d.plugins.sheet.noticeInstallNote);
      break;
    case "unregistered":
      title = t((d) => d.plugins.sheet.noticeInstallTitle);
      prompt = t((d) => d.plugins.sheet.noticeUnregisteredPrompt);
      after = t((d) => d.plugins.sheet.noticeInstallNote);
      break;
    case "update":
      title = sheet((d) => d.plugins.sheet.noticeUpdateTitle);
      after = t((d) => d.plugins.sheet.noticeUpdateNote);
      break;
    case "approve":
      title = sheet((d) => d.plugins.sheet.noticeApproveTitle);
      after = t((d) => d.plugins.sheet.noticeApproveNote);
      break;
    case "unreadable":
      title = sheet((d) => d.plugins.sheet.noticeUnreadableTitle);
      prompt = t((d) => d.plugins.sheet.noticeUnreadablePrompt);
      after = t((d) => d.plugins.sheet.noticeUnreadableNote);
      break;
    case "updatedUnreadable":
      title = sheet((d) => d.plugins.sheet.noticeUpdatedUnreadableTitle);
      prompt = t((d) => d.plugins.sheet.noticeUpdatedUnreadablePrompt);
      after = t((d) => d.plugins.sheet.noticeUnreadableNote);
      break;
    case "stale":
      title = sheet((d) => d.plugins.sheet.noticeStaleTitle);
      prompt = t((d) => d.plugins.sheet.noticeStalePrompt);
      after = t((d) => d.plugins.sheet.noticeStaleNote);
      break;
    default:
      title = sheet((d) => d.plugins.sheet.noticeEnableTitle);
      after = t((d) => d.plugins.sheet.noticeEnableNote);
  }

  return (
    <>
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {prompt ? <p className={styles.prompt}>{prompt}</p> : null}
        <p className={styles.note}>{after}</p>
      </div>
      <div className={styles.footer}>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} data-autofocus onClick={onClose}>
            {t((d) => d.plugins.sheet.close)}
          </button>
        </div>
      </div>
    </>
  );
}

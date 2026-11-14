/*
 * Turns the status model's kinds into words in the active language. Plugin-reported text passes through
 * as the plain string it is.
 */

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { CrashDetail, HubLine, StatusText } from "../../state/plugins/statusModel";

/** The words beside a dot or in a page header. */
export function statusLabel(text: StatusText, t: Translate): string {
  switch (text.kind) {
    case "reported":
      return text.text;
    case "starting":
      return t((d) => d.plugins.frame.statusStarting);
    case "notResponding":
      return t((d) => d.plugins.frame.statusNotResponding);
    case "stopped":
      return t((d) => d.plugins.frame.statusStopped);
    case "failed":
      return t((d) => d.plugins.status.statusFailed);
  }
}

/** The status line of a hub row. */
export function hubLabel(line: HubLine, t: Translate): string {
  switch (line.kind) {
    case "reported":
      return line.text;
    case "starting":
      return t((d) => d.plugins.status.hubStarting);
    case "notResponding":
      return t((d) => d.plugins.status.hubNotResponding);
    case "restarting":
      return t((d) => d.plugins.status.hubRestarting);
    case "stopped":
      return t((d) => d.plugins.status.hubStopped);
    case "crashLoop":
      return t((d) => d.plugins.status.hubCrashLoop);
    case "failed": {
      const reason = t((d) => d.plugins.status.failReason[line.reason]);
      return t((d) => d.plugins.status.hubFailed, { reason });
    }
  }
}

/** The one line Show details prints for a crash. */
export function crashLine(detail: CrashDetail, name: string, t: Translate): string {
  const { reason, code, time } = detail;
  if (reason === "silent") return t((d) => d.plugins.frame.reasonSilent);
  if (reason === "navigated") return t((d) => d.plugins.frame.reasonNavigated);
  if (reason === "init") return t((d) => d.plugins.frame.reasonInit);
  const at = time ?? "";
  if (reason === "exited" && code) return t((d) => d.plugins.status.detailExited, { name, code, time: at });
  if (reason === "exited") return t((d) => d.plugins.status.detailExitedNoCode, { name, time: at });
  if (reason === "protocol") return t((d) => d.plugins.status.detailProtocol, { name, time: at });
  if (reason === "handshake") return t((d) => d.plugins.status.detailHandshake, { name, time: at });
  if (reason === "launch") return t((d) => d.plugins.status.detailLaunch, { name, time: at });
  return t((d) => d.plugins.status.detailUnknown, { name, time: at });
}

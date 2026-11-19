/*
 * The shell's mount-time reads: the saved session, then the organize, playlist and preference
 * projections. Standalone owns its own library boot, so its projection reads wait for it.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- State Imports --
import { useBoot } from "../../state/store";
import { useLoadOrganization } from "../../state/organize/store";
import { useLoadPlaylists } from "../../state/playlists/store";
import { useLoadPreferences } from "../../state/preferences/store";
import { restoreResume } from "../../state/player/restoreResume";
import { settleWarningKind } from "../../state/player/visualizerWarning";

export function useShellBoot(standalone: boolean): void {
  const boot = useBoot();
  const loadOrganization = useLoadOrganization();
  const loadPlaylists = useLoadPlaylists();
  const loadPreferences = useLoadPreferences();

  // Seat the saved session paused. Only a launch with no file to open reaches the non-standalone shell,
  // so an open-with launch never restores and leaves the blob intact.
  useEffect(() => {
    if (!standalone) void restoreResume();
  }, [standalone]);

  // The organize and playlist projections hydrate once the library is up. On the normal path the gate has
  // booted before this shell mounts, so they load on bare mount. Standalone owns its own boot here, so
  // those two reads wait for it - a bare-mount read would hit an empty DB and leave Albums and Playlists
  // blank. Preferences carry theme and locale, so they load at once on both paths. Right after the load
  // the visualizer notice settles its wording, before the Player can write a key that would change it;
  // only the shell does this (the tray and the widget never show the notice), and it is idempotent.
  useEffect(() => {
    if (!standalone) {
      void loadOrganization();
      void loadPlaylists();
      void loadPreferences().then(settleWarningKind);
      return;
    }
    let alive = true;
    void loadPreferences().then(settleWarningKind);
    void boot().then(() => {
      if (!alive) return;
      void loadOrganization();
      void loadPlaylists();
    });
    return () => {
      alive = false;
    };
  }, [standalone, boot, loadOrganization, loadPlaylists, loadPreferences]);
}

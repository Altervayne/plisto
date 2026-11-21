// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import { useAppStore } from "../../state/store";
import { useProbe } from "../../state/plugins/sandboxStore";
import { usePlugins } from "../../state/plugins/store";
import { tagKind } from "../../state/plugins/trust";
import { useOrgReady, useOrganizeStore } from "../../state/organize/store";
import { usePlaylistsStore } from "../../state/playlists/store";
import { useAppMode } from "../../state/player/store";

// -- Utils Imports --
import {
  buildFinderIndex,
  destinationEntries,
  finderDestinations,
  pluginEntries,
} from "./finderIndex";
import { DESTINATION_LABEL } from "./finderDestinations";
import { settingEntries } from "./finderSettingsEntries";
import { listingOf } from "../shell/navVisibility";
import { settingsContext } from "../settings/settingsRegistry";

// -- Hook Imports --
import { usePluginZone } from "../plugins/sidebar/usePluginZone";

// -- Type Imports --
import type {
  DestinationEntry,
  FinderIndex,
  FinderSource,
  PluginEntry,
  SettingFinderEntry,
} from "./finderIndex";

// -- i18n Imports --
import { createT, useLocale } from "../../i18n";
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

// The last build and the rows it came from. The finder mounts on each open, so a component memo would
// rebuild every time; this survives the unmount and rebuilds only when a source row list changes.
let cached: { source: FinderSource; index: FinderIndex } | null = null;

function sameSource(a: FinderSource, b: FinderSource): boolean {
  return (Object.keys(a) as (keyof FinderSource)[]).every((key) => a[key] === b[key]);
}

function indexFor(source: FinderSource): FinderIndex {
  if (cached == null || !sameSource(cached.source, source)) {
    cached = { source, index: buildFinderIndex(source) };
  }
  return cached.index;
}

/**
 * The library index over the live store rows, plus the destinations the current mode can reach and the
 * plugin rows for the plugins the rail draws, and the Settings rows the registry says exist.
 */
export function useFinderIndex(): {
  index: FinderIndex;
  destinations: DestinationEntry[];
  plugins: PluginEntry[];
  settings: SettingFinderEntry[];
} {
  const tracks = useAppStore((s) => s.tracks);
  const albums = useOrganizeStore((s) => s.org.albums);
  const membership = useOrganizeStore((s) => s.org.membership);
  const genres = useOrganizeStore((s) => s.genres);
  const playlists = usePlaylistsStore((s) => s.playlists);
  const slots = usePlaylistsStore((s) => s.tracks);
  const albumEntries = usePlaylistsStore((s) => s.albumEntries);
  const orgReady = useOrgReady();
  const appMode = useAppMode();
  const locale = useLocale();
  const t = useMemo(() => createT(locale), [locale]);
  const untitledAlbum = t((d) => d.albums.untitled);
  const untitledPlaylist = t((d) => d.playlists.untitled);

  const index = useMemo(
    () =>
      indexFor({
        tracks,
        albums,
        membership,
        playlists,
        slots,
        albumEntries,
        orgReady,
        genres,
        untitledAlbum,
        untitledPlaylist,
      }),
    [
      tracks,
      albums,
      membership,
      playlists,
      slots,
      albumEntries,
      orgReady,
      genres,
      untitledAlbum,
      untitledPlaylist,
    ],
  );

  const destinations = useMemo(
    () =>
      destinationEntries(
        finderDestinations(appMode).map((mode) => ({ mode, label: t(DESTINATION_LABEL[mode]) })),
      ),
    [appMode, t],
  );

  const zone = usePluginZone();
  const probe = useProbe();
  const plugins = useMemo(
    () =>
      pluginEntries(
        zone,
        {
          sublabel: t((d) => d.plugins.finderSublabel),
          item: (plugin, item) => t((d) => d.plugins.finderItem, { plugin, item }),
        },
        probe,
      ),
    [zone, t, probe],
  );

  const installed = usePlugins();
  const settings = useMemo(
    () =>
      settingEntries(
        locale === "fr" ? fr : en,
        settingsContext(),
        installed.map((row) => ({
          id: row.id,
          name: row.manifest?.name ?? row.id,
          listing: listingOf(row),
          tag: tagKind(row.tier, probe),
        })),
        {
          group: t((d) => d.settings.nav),
          path: (section) => t((d) => d.finder.settingsPath, { section }),
        },
      ),
    [locale, t, installed, probe],
  );

  return { index, destinations, plugins, settings };
}

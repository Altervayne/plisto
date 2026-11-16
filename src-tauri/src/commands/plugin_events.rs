/*
 * The frontend's report of a library change, which the plugin event hub delivers as
 * `library_changed`. Every user edit and sync delta lands in a frontend store, so the stores report
 * here; Rust still gates, paces and delivers. Only the main window may report.
 */

// -- Library Imports --
use tauri::{State, Webview};

// -- Local Imports --
use crate::plugins::api::events::compose::{LibraryChange, MAX_CHANGED_IDS};
use crate::plugins::api::events::Input;
use crate::plugins::api::state::ApiState;
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

/// The change a report describes: more than `MAX_CHANGED_IDS` ids read as unknown, and ids that are
/// not library ids are dropped.
fn library_change(track_ids: Option<Vec<i64>>, albums: bool, playlists: bool) -> LibraryChange {
    let track_ids = track_ids
        .filter(|ids| ids.len() <= MAX_CHANGED_IDS)
        .map(|ids| ids.into_iter().filter(|&id| id > 0).collect());
    LibraryChange {
        track_ids,
        albums,
        playlists,
    }
    .normalized()
}

/// Hands a report from `label` to the hub. Any other label has no effect.
fn library_changed_from(label: &str, api: &ApiState, change: LibraryChange) {
    if label == MAIN_LABEL {
        api.events().feed(Input::Library(change));
    }
}

/// Reports changed or removed track ids (None for many or unknown) and whether albums or playlists
/// changed.
#[tauri::command]
pub fn plugin_library_changed(
    track_ids: Option<Vec<i64>>,
    albums: bool,
    playlists: bool,
    webview: Webview,
    state: State<'_, AppState>,
) {
    let change = library_change(track_ids, albums, playlists);
    library_changed_from(webview.label(), state.plugins.api(), change);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::events::{Side, Topic};
    use std::collections::BTreeSet;

    const ID: &str = "com.example.demo";

    fn change() -> LibraryChange {
        LibraryChange {
            track_ids: Some(vec![1]),
            albums: false,
            playlists: false,
        }
    }

    #[test]
    fn only_the_main_window_reports_and_only_to_a_listener() {
        let api = ApiState::default();
        let (tx, rx) = crossbeam_channel::unbounded();
        api.events().attach(tx);
        // Nobody listens: nothing reaches the hub.
        library_changed_from(MAIN_LABEL, &api, change());
        assert!(rx.try_recv().is_err());

        let topics: BTreeSet<Topic> = [Topic::LibraryChanged].into();
        api.events().replace(ID, Side::Frame, &topics, &[]);
        for label in ["tray", "nowplaying", ""] {
            library_changed_from(label, &api, change());
        }
        assert!(rx.try_recv().is_err());
        library_changed_from(MAIN_LABEL, &api, change());
        match rx.try_recv() {
            Ok(Input::Library(got)) => assert_eq!(got, change()),
            other => panic!("expected a library change, got {other:?}"),
        }
    }

    #[test]
    fn a_report_is_capped_and_keeps_library_ids_only() {
        let ids = |change: LibraryChange| change.track_ids;
        assert_eq!(
            ids(library_change(Some(vec![3, -2, 0, 1, 3]), false, false)),
            Some(vec![1, 3])
        );
        assert_eq!(
            ids(library_change(Some((1..=500).collect()), false, false)).map(|v| v.len()),
            Some(500)
        );
        // Past the cap the ids are unknown, even when most would be dropped.
        let over: Vec<i64> = (-300..=201).collect();
        assert_eq!(ids(library_change(Some(over), false, false)), None);
        assert_eq!(ids(library_change(None, true, false)), None);
        let change = library_change(Some(vec![-1]), true, true);
        assert_eq!(
            (change.track_ids, change.albums, change.playlists),
            (Some(vec![]), true, true)
        );
    }
}

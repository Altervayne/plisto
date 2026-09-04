/*
 * The Windows System Media Transport Controls bridge (Windows only) - 2.1.0. It ties the resident
 * player to the OS now-playing surface both ways: the hardware media keys and the volume-flyout
 * transport route Play/Pause/Next/Prev/Stop back into the engine, and every real playback transition
 * pushes the current title, artist and cover art out to the lock-screen and flyout card.
 *
 * The controls bind to the main window's HWND, obtained the same way tray::round_corners gets it. The
 * main window only ever hides, never closes, so that HWND and its message loop live for the process
 * and the binding holds while audio plays behind the tray. Button events arrive on that message loop;
 * their handler does only a non-blocking send on the single player Sender, borrowed through managed
 * state and never cloned. Pushing state out runs on a dedicated `plisto-smtc` thread that owns the
 * WinRT handles: a `player:status` listener forwards the (track id, playing) pair to it, and the
 * thread diffs against the last seen pair so the ~5x-a-second position ticks never touch the OS - only
 * a real transition does. The cover decode for a track with embedded/adjacent art runs on that thread,
 * never the player thread and never rodio. Everything is best-effort: a failed WinRT call logs through
 * `player:error` and the app plays on without the OS card. Non-Windows gets no-op stubs so the setup
 * hook stays uniform.
 */

/// Initializes the OS media controls and starts the coordinator. Called at the tail of setup, once
/// managed state and the main window exist. Best-effort: any failure leaves the app running without
/// the now-playing card. A no-op off Windows.
#[cfg(windows)]
pub fn init(app: &tauri::AppHandle) {
    win::init(app);
}

#[cfg(not(windows))]
pub fn init(_app: &tauri::AppHandle) {}

/// Tears the OS media controls down at app exit: disables them and empties the card, so the overlay
/// does not ghost after the process ends. Hooked into the RunEvent::Exit arm. A no-op off Windows.
#[cfg(windows)]
pub fn teardown(app: &tauri::AppHandle) {
    win::teardown(app);
}

#[cfg(not(windows))]
pub fn teardown(_app: &tauri::AppHandle) {}

#[cfg(windows)]
mod win {
    use std::sync::mpsc::{self, Receiver, Sender};

    use tauri::{AppHandle, Listener, Manager};
    use windows::core::{Result, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsDisplayUpdater,
    };
    use windows::Storage::Streams::RandomAccessStreamReference;
    use windows::Storage::StorageFile;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

    use crate::audio::PlayerCmd;
    use crate::state::AppState;

    /// Kept in managed state so the exit teardown can reach the controls from the main thread. The
    /// WinRT handle is agile, so this clone and the coordinator's own clone name one OS object.
    struct SmtcState {
        controls: SystemMediaTransportControls,
    }

    /// One playback transition forwarded from the status listener to the coordinator. Carries only
    /// what the card needs to diff and refresh; the coordinator resolves the title, artist and cover
    /// from the track id itself.
    struct Transition {
        track_id: Option<i64>,
        playing: bool,
    }

    /// The fields of `player:status` the card reads. serde ignores the rest of the snapshot.
    #[derive(serde::Deserialize)]
    struct StatusPayload {
        track_id: Option<i64>,
        playing: bool,
    }

    /// Binds the controls to the main window, wires the media keys back into the engine, and starts
    /// the coordinator that pushes state out. Every step is fallible and swallowed: a first failure
    /// returns early and the app runs without the OS card.
    pub fn init(app: &AppHandle) {
        if let Err(e) = try_init(app) {
            let _ = tauri::Emitter::emit(app, "player:error", &format!("media controls unavailable: {e}"));
        }
    }

    /// The fallible body of init, so a `?` short-circuits the whole wiring on the first WinRT error.
    fn try_init(app: &AppHandle) -> Result<()> {
        let controls = controls_for_main_window(app)?;

        // Advertise the transport the card offers and enable it. The buttons enabled here are the
        // ones the ButtonPressed handler maps; the rest stay dark.
        controls.SetIsEnabled(true)?;
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;
        controls.SetIsNextEnabled(true)?;
        controls.SetIsPreviousEnabled(true)?;
        controls.SetIsStopEnabled(true)?;

        register_buttons(app, &controls)?;

        // The coordinator owns its own clone of the controls and the display updater; the exit
        // teardown reaches the controls through managed state.
        let updater = controls.DisplayUpdater()?;
        let (tx, rx) = mpsc::channel::<Transition>();
        spawn_coordinator(app.clone(), controls.clone(), updater, rx);
        register_status_listener(app, tx);

        app.manage(SmtcState { controls });
        Ok(())
    }

    /// Obtains the OS media controls bound to the main window's HWND, the same handle tray rounding
    /// uses. Tauri hands back a windows-0.61 HWND while this binding is windows-0.58, so the raw
    /// pointer is rewrapped, exactly as round_corners does.
    fn controls_for_main_window(app: &AppHandle) -> Result<SystemMediaTransportControls> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(windows::core::Error::from_win32)?;
        let handle = window
            .hwnd()
            .map_err(|_| windows::core::Error::from_win32())?;
        let hwnd = HWND(handle.0);
        let interop: ISystemMediaTransportControlsInterop =
            windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
        unsafe { interop.GetForWindow(hwnd) }
    }

    /// Registers the ButtonPressed handler once. It runs on the owning window's message loop, so it
    /// only maps the button to a transport command and hands it to the engine over the single player
    /// Sender, borrowed through managed state and never cloned or stored. The registration token is
    /// dropped: the handler stays live until the controls are disabled at exit.
    fn register_buttons(app: &AppHandle, controls: &SystemMediaTransportControls) -> Result<()> {
        let app = app.clone();
        let handler = TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_sender, args| {
            if let Some(args) = args.as_ref() {
                if let Some(cmd) = args.Button().ok().and_then(button_command) {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.player.send(cmd);
                    }
                }
            }
            Ok(())
        });
        controls.ButtonPressed(&handler)?;
        Ok(())
    }

    /// Maps an OS transport button to a player command. Play and Pause both toggle - the engine holds
    /// the real play/pause state - while Next, Previous and Stop map straight across. Any other button
    /// (fast-forward, channel up, ...) is left unhandled.
    fn button_command(button: SystemMediaTransportControlsButton) -> Option<PlayerCmd> {
        match button {
            SystemMediaTransportControlsButton::Play
            | SystemMediaTransportControlsButton::Pause => Some(PlayerCmd::TogglePlay),
            SystemMediaTransportControlsButton::Next => Some(PlayerCmd::Next),
            SystemMediaTransportControlsButton::Previous => Some(PlayerCmd::Prev),
            SystemMediaTransportControlsButton::Stop => Some(PlayerCmd::Stop),
            _ => None,
        }
    }

    /// Listens for `player:status` and forwards the transition to the coordinator. Kept trivial: it
    /// parses the two fields the card needs and sends them on every tick, leaving the diff to the
    /// coordinator so a torn or stale channel never blocks Tauri's event delivery.
    fn register_status_listener(app: &AppHandle, tx: Sender<Transition>) {
        app.listen("player:status", move |event| {
            if let Ok(status) = serde_json::from_str::<StatusPayload>(event.payload()) {
                let _ = tx.send(Transition {
                    track_id: status.track_id,
                    playing: status.playing,
                });
            }
        });
    }

    /// Starts the `plisto-smtc` coordinator thread. It owns the WinRT handles and services transitions
    /// off the channel, so the WinRT and cover-decode work never rides the player thread or the Tauri
    /// event loop. A daemon like the player thread: it ends when every Sender drops at exit.
    fn spawn_coordinator(
        app: AppHandle,
        controls: SystemMediaTransportControls,
        updater: SystemMediaTransportControlsDisplayUpdater,
        rx: Receiver<Transition>,
    ) {
        let _ = std::thread::Builder::new()
            .name("plisto-smtc".to_string())
            .spawn(move || coordinator(app, controls, updater, rx));
    }

    /// The coordinator body. Initializes an MTA so the thumbnail's async file open blocks cleanly
    /// without a message pump, then diffs each transition against the last seen pair: a change in
    /// `(track_id, playing)` sets the playback status, and a change in the track id alone refreshes
    /// the title, artist and cover (or empties the card on stop). Nothing else touches the OS.
    fn coordinator(
        app: AppHandle,
        controls: SystemMediaTransportControls,
        updater: SystemMediaTransportControlsDisplayUpdater,
        rx: Receiver<Transition>,
    ) {
        // COINIT_MULTITHREADED, not the STA the shell picker uses: on an MTA thread the thumbnail's
        // IAsyncOperation::get blocks until the file opens instead of deadlocking for want of a pump.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let mut last: Option<(Option<i64>, bool)> = None;
        while let Ok(t) = rx.recv() {
            let cur = (t.track_id, t.playing);
            if last == Some(cur) {
                continue;
            }
            let track_changed = last.map(|(id, _)| id) != Some(cur.0);
            let _ = controls.SetPlaybackStatus(playback_status(cur.0, cur.1));
            if track_changed {
                match cur.0 {
                    Some(id) => {
                        let _ = push_metadata(&app, &updater, id);
                    }
                    None => {
                        let _ = clear_card(&updater);
                    }
                }
            }
            last = Some(cur);
        }
    }

    /// The OS playback status for a snapshot: Stopped with no track, else Playing or Paused. `playing`
    /// already folds in the pause state the engine reports.
    fn playback_status(track_id: Option<i64>, playing: bool) -> MediaPlaybackStatus {
        match track_id {
            None => MediaPlaybackStatus::Stopped,
            Some(_) => {
                if playing {
                    MediaPlaybackStatus::Playing
                } else {
                    MediaPlaybackStatus::Paused
                }
            }
        }
    }

    /// Pushes the card's metadata for `track_id`: its title, artist and cover art. Reads the display
    /// fields and resolves the cover to an on-disk file under the DB lock, then writes them to the
    /// updater. A track with no art clears the thumbnail via the reset, so a previous cover never
    /// lingers. This is the single point a track id turns into what the OS shows - a later ad-hoc /
    /// sentinel source resolves its own title/artist/cover here without touching the coordinator.
    fn push_metadata(
        app: &AppHandle,
        updater: &SystemMediaTransportControlsDisplayUpdater,
        track_id: i64,
    ) -> Result<()> {
        let (title, artist, cover) = resolve_display(app, track_id);

        // ClearAll resets every field, including the last track's thumbnail, so the branches below
        // only set what this track has.
        updater.ClearAll()?;
        updater.SetType(MediaPlaybackType::Music)?;
        let music = updater.MusicProperties()?;
        music.SetTitle(&HSTRING::from(title))?;
        music.SetArtist(&HSTRING::from(artist))?;
        if let Some(path) = cover {
            if let Ok(reference) = thumbnail_reference(&path) {
                updater.SetThumbnail(&reference)?;
            }
        }
        updater.Update()
    }

    /// Empties the card: ClearAll drops the title, artist and thumbnail, and Update pushes the empty
    /// state so the OS overlay shows nothing rather than the last track's art. Paired with a Stopped
    /// playback status on the stop / no-track transition.
    fn clear_card(updater: &SystemMediaTransportControlsDisplayUpdater) -> Result<()> {
        updater.ClearAll()?;
        updater.Update()
    }

    /// Resolves the card's title, artist and cover file for a library track. The title/artist read
    /// takes a short lock; the cover resolve locks and unlocks on its own, dropping the index lock
    /// before any embedded/adjacent decode, so the decode never holds it. The decode runs here on
    /// the coordinator thread, never the player thread. A missing display row or absent index leaves
    /// empty strings and no cover.
    fn resolve_display(app: &AppHandle, track_id: i64) -> (String, String, Option<String>) {
        let Some(state) = app.try_state::<AppState>() else {
            return (String::new(), String::new(), None);
        };
        let display = state
            .db
            .lock()
            .ok()
            .and_then(|conn| crate::db::get_track_display(&conn, track_id).ok());
        let cover = crate::commands::covers::resolve_cover_file(state.inner(), track_id);
        let (title, artist) = match display {
            Some(d) => (d.title.unwrap_or_default(), d.artist.unwrap_or_default()),
            None => (String::new(), String::new()),
        };
        (title, artist, cover)
    }

    /// Builds a thumbnail stream reference from an on-disk image path. The async file open blocks on
    /// the MTA coordinator thread. Errors (a since-deleted cache file, an unreadable path) bubble up
    /// so the caller leaves the thumbnail unset rather than failing the whole metadata push.
    fn thumbnail_reference(path: &str) -> Result<RandomAccessStreamReference> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;
        RandomAccessStreamReference::CreateFromFile(&file)
    }

    /// Disables the controls and empties the card at exit, so the OS overlay does not linger after the
    /// process ends. Best-effort and reachable only while the controls are still managed.
    pub fn teardown(app: &AppHandle) {
        if let Some(state) = app.try_state::<SmtcState>() {
            let _ = state.controls.SetPlaybackStatus(MediaPlaybackStatus::Closed);
            if let Ok(updater) = state.controls.DisplayUpdater() {
                let _ = clear_card(&updater);
            }
            let _ = state.controls.SetIsEnabled(false);
        }
    }
}

/*
 * The system tray: a menu (Show Plisto, Quit) on right-click, and a small status popup toggled by
 * left-click. The popup is the "tray" window declared in tauri.conf.json - seated near the tray and
 * hidden when it loses focus, so it behaves like a native popover. A short guard on the last hide
 * keeps a left-click that just dismissed the popup from immediately reopening it, since the click
 * itself steals focus from the popup and hides it first.
 */

// -- Library Imports --
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

use crate::db;
use crate::state::AppState;

/// The edge margin and the assumed taskbar band, in logical pixels, used to seat the popup above
/// the tray. The taskbar height is not exposed to the app, so the reserve is a close-enough band.
const POPUP_MARGIN: f64 = 12.0;
const TASKBAR_RESERVE: f64 = 48.0;

/// The popup's logical width, and its two heights: the base status card, and the taller card that
/// fits the now-playing block above the status. The block adds the cover row and the transport.
const POPUP_WIDTH: f64 = 300.0;
const POPUP_HEIGHT_BASE: f64 = 188.0;
const POPUP_HEIGHT_NOW_PLAYING: f64 = 278.0;

/// How long after the popup hides a tray left-click still counts as the dismissing click, so it
/// does not reopen what it just closed.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

/// When the popup last hid, so the toggle tells a dismissing click from an opening one. Held in
/// managed state and shared by the tray click handler and the focus-loss window handler.
#[derive(Default)]
pub struct TrayState {
    pub hidden_at: Mutex<Option<Instant>>,
}

/// Builds the tray icon with its menu and click routing: right-click opens the menu, left-click
/// toggles the popup. Runs once at setup.
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Plisto", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => crate::commands::window::guarded_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popup(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Brings the main window back from the tray: shows, unminimizes and focuses it. Shared by the tray
/// menu, the popup button command and any close-to-tray reversal.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Stamps the moment the popup hid, so a tray click that caused the focus loss does not reopen it.
/// The focus-loss window handler and the toggle's hide branch both call this after hiding.
pub fn stamp_hidden(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut hidden_at) = state.hidden_at.lock() {
            *hidden_at = Some(Instant::now());
        }
    }
}

/// Toggles the popup on a tray left-click: hides it when visible or just dismissed, else seats it
/// near the tray and shows it focused.
fn toggle_popup(app: &AppHandle) {
    let Some(window) = app.get_webview_window("tray") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let just_dismissed = app
        .try_state::<TrayState>()
        .and_then(|s| s.hidden_at.lock().ok().and_then(|g| *g))
        .map(|t| t.elapsed() < REOPEN_GUARD)
        .unwrap_or(false);

    if visible || just_dismissed {
        let _ = window.hide();
        stamp_hidden(app);
        return;
    }

    // Grow the popup to fit the now-playing block when a track is loaded, else sit at the base
    // status height. Best-effort: a failed read or resize just leaves the last size. `set_size`
    // works despite `resizable: false`, and `position_popup` reads `outer_size()` after, so the
    // seat stays correct for whichever height took.
    let playing_track = app
        .try_state::<AppState>()
        .and_then(|s| s.player_status.lock().ok().map(|p| p.track_id.is_some()))
        .unwrap_or(false);
    let height = if playing_track {
        POPUP_HEIGHT_NOW_PLAYING
    } else {
        POPUP_HEIGHT_BASE
    };
    let _ = window.set_size(LogicalSize::new(POPUP_WIDTH, height));

    position_popup(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Seats the popup at the bottom-right of the primary monitor, above the taskbar, clamped on-screen.
fn position_popup(app: &AppHandle, window: &WebviewWindow) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let scale = monitor.scale_factor();
    let margin = (POPUP_MARGIN * scale) as i32;
    let reserve = (TASKBAR_RESERVE * scale) as i32;
    let origin = monitor.position();
    let extent = monitor.size();

    let x = (origin.x + extent.width as i32 - size.width as i32 - margin).max(origin.x + margin);
    let y = (origin.y + extent.height as i32 - size.height as i32 - margin - reserve)
        .max(origin.y + margin);

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// The pop-out now-playing widget's edge margin, in logical pixels, matching the popup's.
const WIDGET_MARGIN: f64 = 12.0;

/// Seats the pop-out now-playing widget before it shows: the remembered position when it still
/// lands on a connected monitor, else the top-right of the primary monitor - a distinct corner from
/// the tray popup's bottom-right. Physical pixels throughout, to match what the webview's move
/// listener persists. Best-effort: a failed read or place just leaves the last seat.
pub fn seat_now_playing(app: &AppHandle, window: &WebviewWindow) {
    if let Some(pos) = remembered_widget_pos(app) {
        if point_on_some_monitor(app, pos) {
            let _ = window.set_position(pos);
            return;
        }
    }
    seat_widget_top_right(app, window);
}

/// Reads the persisted widget top-left, parsed from the "x,y" physical-pixel pair the webview writes.
/// None when unset, unreadable or malformed. The connection is taken best-effort and dropped at once.
fn remembered_widget_pos(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let state = app.try_state::<AppState>()?;
    let conn = state.db.lock().ok()?;
    let raw = db::get_setting(&conn, "nowplaying_pos").ok().flatten()?;
    let (x, y) = raw.split_once(',')?;
    Some(PhysicalPosition::new(
        x.trim().parse().ok()?,
        y.trim().parse().ok()?,
    ))
}

/// Whether a point falls inside any connected monitor, so a remembered seat on a since-unplugged
/// display is dropped for the default corner rather than placing the widget off-screen.
fn point_on_some_monitor(app: &AppHandle, pos: PhysicalPosition<i32>) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let o = m.position();
        let s = m.size();
        pos.x >= o.x
            && pos.y >= o.y
            && pos.x < o.x + s.width as i32
            && pos.y < o.y + s.height as i32
    })
}

/// Seats the widget at the top-right of the primary monitor, clamped on-screen.
fn seat_widget_top_right(app: &AppHandle, window: &WebviewWindow) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let scale = monitor.scale_factor();
    let margin = (WIDGET_MARGIN * scale) as i32;
    let origin = monitor.position();
    let extent = monitor.size();

    let x = (origin.x + extent.width as i32 - size.width as i32 - margin).max(origin.x + margin);
    let y = origin.y + margin;

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Asks DWM to round the widget's corners, so the opaque frameless window reads as a rounded card
/// like the rest of the chrome. Tauri hands back a windows-0.61 HWND while the DWM binding here is
/// windows-0.58 - the same raw handle, distinct crate-version types, so the pointer is rewrapped for
/// the call. Best-effort: a failed set just leaves square corners.
#[cfg(windows)]
pub fn round_corners(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    if let Ok(handle) = window.hwnd() {
        let hwnd = HWND(handle.0);
        let pref = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const _,
                std::mem::size_of_val(&pref) as u32,
            );
        }
    }
}

/// Off Windows there is no DWM corner attribute, so rounding is left to the platform's own chrome.
#[cfg(not(windows))]
pub fn round_corners(_window: &WebviewWindow) {}

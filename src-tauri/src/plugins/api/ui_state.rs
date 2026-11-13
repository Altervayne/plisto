/*
 * The open toasts and prompts of every plugin, in arrival order, and the gesture tokens that let a
 * plugin whose page is hidden raise a prompt right after a click on its own controls. One lock covers
 * both, held for map work only: every channel send happens after it is released, and a waiting call
 * never holds it. The app-wide caps bound the threads parked on open requests.
 *
 * A gesture token is a keyed hash of a process-wide counter under a key made once per process. It is
 * bound to the plugin it was minted for, used once and short-lived. It is never printed, so `UiState`
 * does not implement `Debug`.
 */

// -- Library Imports --
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::BuildHasher;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{bounded, Sender};
use serde::Deserialize;
use serde_json::{json, Value};

// -- Local Imports --
use super::error::ApiError;
use super::host_event::UiEvent;
use super::pending::{Expiry, Pending, Resolution};
use super::state::lock;

/// One shown plus three waiting.
pub const MAX_OPEN_TOASTS: usize = 4;
/// One shown plus three waiting.
pub const MAX_OPEN_PROMPTS: usize = 4;
pub const TOAST_DEADLINE_MS: u64 = 60_000;
pub const CONFIRM_DEADLINE_MS: u64 = 300_000;
pub const GESTURE_MS: u64 = 5_000;
pub const MAX_GESTURES_PER_PLUGIN: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenKind {
    /// `action`: the toast offers a button.
    Toast {
        action: bool,
    },
    Confirm,
}

/// The main window's answer to an open request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiAnswer {
    Toast { action: bool },
    Confirm { value: bool },
}

struct OpenRequest {
    request_id: String,
    plugin: String,
    kind: OpenKind,
    event: UiEvent,
    tx: Sender<Resolution>,
}

struct Gesture {
    plugin: String,
    minted: Instant,
    // Mint order, so the oldest is known even when two share an instant.
    seq: u64,
}

#[derive(Default)]
struct Inner {
    open: Vec<OpenRequest>,
    // Keyed by token.
    gestures: HashMap<String, Gesture>,
}

#[derive(Default)]
pub struct UiState {
    inner: Mutex<Inner>,
    next_request: AtomicU64,
}

static GESTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn gesture_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let pid = std::process::id();
        let mut seed = Vec::with_capacity(36);
        seed.extend_from_slice(&RandomState::new().hash_one((nanos, pid, 0u8)).to_le_bytes());
        seed.extend_from_slice(&RandomState::new().hash_one((nanos, pid, 1u8)).to_le_bytes());
        seed.extend_from_slice(&nanos.to_le_bytes());
        seed.extend_from_slice(&pid.to_le_bytes());
        *blake3::hash(&seed).as_bytes()
    })
}

/// A fresh token and its mint order.
fn new_token() -> (String, u64) {
    let seq = GESTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let hash = blake3::keyed_hash(gesture_key(), &seq.to_le_bytes());
    (format!("g1.{}", &hash.to_hex()[..32]), seq)
}

fn dismissed() -> Value {
    json!({ "result": "dismissed" })
}

fn gesture_life() -> Duration {
    Duration::from_millis(GESTURE_MS)
}

impl Inner {
    fn prune(&mut self, now: Instant) {
        self.gestures
            .retain(|_, g| now.saturating_duration_since(g.minted) < gesture_life());
    }

    fn mint(&mut self, id: &str, now: Instant) -> String {
        self.prune(now);
        let mut own: Vec<(u64, &String)> = self
            .gestures
            .iter()
            .filter(|(_, g)| g.plugin == id)
            .map(|(token, g)| (g.seq, token))
            .collect();
        if own.len() >= MAX_GESTURES_PER_PLUGIN {
            own.sort_unstable();
            let oldest = own[0].1.clone();
            self.gestures.remove(&oldest);
        }
        let (token, seq) = new_token();
        self.gestures.insert(
            token.clone(),
            Gesture {
                plugin: id.to_string(),
                minted: now,
                seq,
            },
        );
        token
    }

    fn count(&self, f: impl Fn(&OpenRequest) -> bool) -> usize {
        self.open.iter().filter(|r| f(r)).count()
    }

    fn confirm_busy(&self, id: &str) -> Result<(), ApiError> {
        let is_prompt = |r: &OpenRequest| r.kind == OpenKind::Confirm;
        if self.count(|r| is_prompt(r) && r.plugin == id) > 0
            || self.count(is_prompt) >= MAX_OPEN_PROMPTS
        {
            return Err(ApiError::busy());
        }
        Ok(())
    }
}

impl UiState {
    /// `"r"` plus a counter from 1.
    pub fn next_request_id(&self) -> String {
        format!("r{}", self.next_request.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn open(
        &self,
        id: &str,
        event: UiEvent,
        kind: OpenKind,
        now: Instant,
    ) -> Result<Pending, ApiError> {
        let (tx, rx) = bounded(1);
        let request_id = event.request_id.clone();
        {
            let mut inner = lock(&self.inner);
            inner.prune(now);
            match kind {
                OpenKind::Toast { .. } => {
                    let toasts = inner.count(|r| matches!(r.kind, OpenKind::Toast { .. }));
                    if toasts >= MAX_OPEN_TOASTS {
                        return Err(ApiError::busy());
                    }
                }
                OpenKind::Confirm => inner.confirm_busy(id)?,
            }
            inner.open.push(OpenRequest {
                request_id: request_id.clone(),
                plugin: id.to_string(),
                kind,
                event,
                tx,
            });
        }
        let (deadline, expiry) = match kind {
            OpenKind::Toast { .. } => (TOAST_DEADLINE_MS, Expiry::Dismissed),
            OpenKind::Confirm => (CONFIRM_DEADLINE_MS, Expiry::TimedOut),
        };
        Ok(Pending::new(
            request_id,
            id.to_string(),
            rx,
            Duration::from_millis(deadline),
            expiry,
        ))
    }

    /// Registers a toast of plugin `id`; `busy` when `MAX_OPEN_TOASTS` are already open.
    pub fn open_toast(
        &self,
        id: &str,
        event: UiEvent,
        action: bool,
        now: Instant,
    ) -> Result<Pending, ApiError> {
        self.open(id, event, OpenKind::Toast { action }, now)
    }

    /// Registers a prompt of plugin `id`; `busy` when it already has one or `MAX_OPEN_PROMPTS` are
    /// open.
    pub fn open_confirm(
        &self,
        id: &str,
        event: UiEvent,
        now: Instant,
    ) -> Result<Pending, ApiError> {
        self.open(id, event, OpenKind::Confirm, now)
    }

    /// The prompt caps alone, for a caller that must refuse `busy` before spending a gesture.
    pub fn confirm_busy(&self, id: &str) -> Result<(), ApiError> {
        lock(&self.inner).confirm_busy(id)
    }

    /// Resolves the open request `request_id` with the main window's answer. `false` when it is not
    /// open or the answer is of the other kind. A toast's action mints a gesture only while its plugin
    /// is `serving`; otherwise it reads as dismissed.
    pub fn answer(&self, request_id: &str, answer: UiAnswer, serving: bool, now: Instant) -> bool {
        let (tx, result) = {
            let mut inner = lock(&self.inner);
            let Some(index) = inner.open.iter().position(|r| r.request_id == request_id) else {
                return false;
            };
            let (kind, plugin) = (inner.open[index].kind, inner.open[index].plugin.clone());
            let result = match (kind, answer) {
                (OpenKind::Confirm, UiAnswer::Confirm { value }) => json!({ "answer": value }),
                (OpenKind::Toast { action: true }, UiAnswer::Toast { action: true }) if serving => {
                    json!({ "result": "action", "gesture": inner.mint(&plugin, now) })
                }
                (OpenKind::Toast { .. }, UiAnswer::Toast { .. }) => dismissed(),
                _ => return false,
            };
            (inner.open.remove(index).tx, result)
        };
        let _ = tx.send(Resolution {
            result: Ok(result),
            close: false,
        });
        true
    }

    /// Removes the open request `request_id` for a waiter whose deadline passed. `false` when another
    /// path removed it first; its resolution is then on the way.
    pub fn expire(&self, request_id: &str) -> bool {
        let mut inner = lock(&self.inner);
        let Some(index) = inner.open.iter().position(|r| r.request_id == request_id) else {
            return false;
        };
        inner.open.remove(index);
        true
    }

    /// Ends every open request of plugin `id`: toasts as dismissed, prompts as a "no".
    pub fn release(&self, id: &str) {
        let released: Vec<OpenRequest> = {
            let mut inner = lock(&self.inner);
            let (released, kept) = std::mem::take(&mut inner.open)
                .into_iter()
                .partition(|r| r.plugin == id);
            inner.open = kept;
            released
        };
        for request in released {
            let result = match request.kind {
                OpenKind::Toast { .. } => dismissed(),
                OpenKind::Confirm => json!({ "answer": false }),
            };
            let _ = request.tx.send(Resolution {
                result: Ok(result),
                close: true,
            });
        }
    }

    /// The open requests' original events, in arrival order.
    pub fn pending_events(&self) -> Vec<UiEvent> {
        lock(&self.inner)
            .open
            .iter()
            .map(|r| r.event.clone())
            .collect()
    }

    /// A new gesture token for plugin `id`, valid for `GESTURE_MS`. The plugin's oldest goes when it
    /// already holds `MAX_GESTURES_PER_PLUGIN`.
    pub fn mint(&self, id: &str, now: Instant) -> String {
        lock(&self.inner).mint(id, now)
    }

    /// Spends `token` for plugin `id`. Another plugin's token is refused and left for its owner.
    pub fn consume(&self, id: &str, token: &str, now: Instant) -> bool {
        let mut inner = lock(&self.inner);
        inner.prune(now);
        match inner.gestures.get(token) {
            Some(gesture) if gesture.plugin == id => {
                inner.gestures.remove(token);
                true
            }
            _ => false,
        }
    }

    pub fn drop_gestures(&self, id: &str) {
        lock(&self.inner).gestures.retain(|_, g| g.plugin != id);
    }

    #[cfg(test)]
    pub(super) fn gesture_count(&self, id: &str) -> usize {
        lock(&self.inner)
            .gestures
            .values()
            .filter(|g| g.plugin == id)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::host_event::{HostEvent, UiKind};
    use crate::plugins::api::FakeHost;
    use std::collections::HashSet;

    const A: &str = "com.example.a";
    const B: &str = "com.example.b";

    fn toast(ui: &UiState, id: &str) -> UiEvent {
        UiEvent {
            request_id: ui.next_request_id(),
            id: id.to_string(),
            kind: UiKind::Toast {
                text: "Saved".into(),
                action: Some("Undo".into()),
            },
        }
    }

    fn prompt(ui: &UiState, id: &str) -> UiEvent {
        UiEvent {
            request_id: ui.next_request_id(),
            id: id.to_string(),
            kind: UiKind::Confirm {
                title: "Delete".into(),
                body: "Sure?".into(),
                confirm_label: "Delete".into(),
                cancel_label: None,
            },
        }
    }

    fn open_toast(ui: &UiState, id: &str, now: Instant) -> Result<Pending, ApiError> {
        ui.open_toast(id, toast(ui, id), true, now)
    }

    fn open_confirm(ui: &UiState, id: &str, now: Instant) -> Result<Pending, ApiError> {
        ui.open_confirm(id, prompt(ui, id), now)
    }

    fn closes(host: &FakeHost) -> Vec<String> {
        host.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                HostEvent::Ui(ui) if ui.kind == (UiKind::Close {}) => Some(ui.request_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn request_ids_count_from_one() {
        let ui = UiState::default();
        assert_eq!(ui.next_request_id(), "r1");
        assert_eq!(ui.next_request_id(), "r2");
    }

    #[test]
    fn the_fifth_open_toast_is_busy() {
        let ui = UiState::default();
        let now = Instant::now();
        let held: Vec<Pending> = (0..4)
            .map(|i| open_toast(&ui, if i % 2 == 0 { A } else { B }, now).unwrap())
            .collect();
        assert_eq!(open_toast(&ui, A, now).unwrap_err().code, ApiCode::Busy);
        // A refused toast is not registered.
        assert_eq!(ui.pending_events().len(), 4);
        // Toasts do not count against prompts.
        assert!(open_confirm(&ui, A, now).is_ok());
        drop(held);
    }

    #[test]
    fn prompts_are_one_per_plugin_and_four_app_wide() {
        let ui = UiState::default();
        let now = Instant::now();
        let _a = open_confirm(&ui, A, now).unwrap();
        assert_eq!(ui.confirm_busy(A).unwrap_err().code, ApiCode::Busy);
        assert_eq!(open_confirm(&ui, A, now).unwrap_err().code, ApiCode::Busy);
        let _others: Vec<Pending> = ["com.example.b", "com.example.c", "com.example.d"]
            .iter()
            .map(|id| open_confirm(&ui, id, now).unwrap())
            .collect();
        assert_eq!(
            ui.confirm_busy("com.example.e").unwrap_err().code,
            ApiCode::Busy
        );
        assert_eq!(
            open_confirm(&ui, "com.example.e", now).unwrap_err().code,
            ApiCode::Busy
        );
    }

    #[test]
    fn pending_events_keep_arrival_order() {
        let ui = UiState::default();
        let now = Instant::now();
        let _a = open_toast(&ui, A, now).unwrap();
        let _b = open_confirm(&ui, B, now).unwrap();
        let _c = open_toast(&ui, B, now).unwrap();
        let ids: Vec<String> = ui
            .pending_events()
            .into_iter()
            .map(|e| e.request_id)
            .collect();
        assert_eq!(ids, ["r1", "r2", "r3"]);
        assert!(ui.expire("r2"));
        let ids: Vec<String> = ui
            .pending_events()
            .into_iter()
            .map(|e| e.request_id)
            .collect();
        assert_eq!(ids, ["r1", "r3"]);
    }

    #[test]
    fn an_answer_resolves_once_and_only_its_own_kind() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let pending = open_confirm(&ui, A, now).unwrap();
        assert!(!ui.answer("r1", UiAnswer::Toast { action: true }, true, now));
        assert!(!ui.answer("r9", UiAnswer::Confirm { value: true }, true, now));
        assert!(ui.answer("r1", UiAnswer::Confirm { value: true }, true, now));
        assert!(!ui.answer("r1", UiAnswer::Confirm { value: false }, true, now));
        assert_eq!(pending.wait(&host, &ui), Ok(json!({ "answer": true })));
        // An answer is not a withdrawal.
        assert!(closes(&host).is_empty());
    }

    #[test]
    fn a_toast_action_mints_a_gesture_only_while_serving() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let pending = open_toast(&ui, A, now).unwrap();
        assert!(ui.answer("r1", UiAnswer::Toast { action: true }, true, now));
        let result = pending.wait(&host, &ui).unwrap();
        assert_eq!(result["result"], "action");
        let token = result["gesture"].as_str().unwrap();
        assert!(ui.consume(A, token, now));

        let pending = open_toast(&ui, A, now).unwrap();
        assert!(ui.answer("r2", UiAnswer::Toast { action: true }, false, now));
        assert_eq!(pending.wait(&host, &ui), Ok(dismissed()));
        assert_eq!(ui.gesture_count(A), 0);

        // A toast without a button reads an action as dismissed.
        let pending = ui.open_toast(A, toast(&ui, A), false, now).unwrap();
        assert!(ui.answer("r3", UiAnswer::Toast { action: true }, true, now));
        assert_eq!(pending.wait(&host, &ui), Ok(dismissed()));
        assert_eq!(ui.gesture_count(A), 0);
    }

    #[test]
    fn the_deadline_dismisses_a_toast_and_times_out_a_prompt_with_a_close() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let pending = open_toast(&ui, A, now).unwrap().with_deadline(ms(1));
        assert_eq!(pending.wait(&host, &ui), Ok(dismissed()));
        let pending = open_confirm(&ui, A, now).unwrap().with_deadline(ms(1));
        assert_eq!(pending.wait(&host, &ui).unwrap_err().code, ApiCode::Timeout);
        assert_eq!(closes(&host), ["r1", "r2"]);
        assert!(ui.pending_events().is_empty());
        // A late answer finds nothing.
        assert!(!ui.answer("r2", UiAnswer::Confirm { value: true }, true, now));
    }

    #[test]
    fn an_answer_just_before_the_expiry_wins() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let pending = open_confirm(&ui, A, now)
            .unwrap()
            .with_deadline(Duration::ZERO);
        // The deadline has passed, but the answer removes the request before the waiter can.
        let result = pending.wait_with(&host, &ui, || {
            assert!(ui.answer("r1", UiAnswer::Confirm { value: true }, true, now));
        });
        assert_eq!(result, Ok(json!({ "answer": true })));
        assert!(closes(&host).is_empty());
    }

    #[test]
    fn an_expiry_just_before_the_answer_wins() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let pending = open_confirm(&ui, A, now)
            .unwrap()
            .with_deadline(Duration::ZERO);
        let result = pending.wait(&host, &ui);
        assert_eq!(result.unwrap_err().code, ApiCode::Timeout);
        assert!(!ui.answer("r1", UiAnswer::Confirm { value: true }, true, now));
        assert_eq!(closes(&host), ["r1"]);
    }

    #[test]
    fn a_release_just_before_the_expiry_wins() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let pending = open_confirm(&ui, A, now)
            .unwrap()
            .with_deadline(Duration::ZERO);
        let result = pending.wait_with(&host, &ui, || ui.release(A));
        assert_eq!(result, Ok(json!({ "answer": false })));
        assert_eq!(closes(&host), ["r1"]);
    }

    #[test]
    fn release_ends_only_that_plugins_requests_with_a_close() {
        let ui = UiState::default();
        let host = FakeHost::default();
        let now = Instant::now();
        let toast_a = open_toast(&ui, A, now).unwrap();
        let prompt_a = open_confirm(&ui, A, now).unwrap();
        let _toast_b = open_toast(&ui, B, now).unwrap();
        ui.release(A);
        assert_eq!(toast_a.wait(&host, &ui), Ok(dismissed()));
        assert_eq!(prompt_a.wait(&host, &ui), Ok(json!({ "answer": false })));
        assert_eq!(closes(&host), ["r1", "r2"]);
        let left: Vec<String> = ui.pending_events().into_iter().map(|e| e.id).collect();
        assert_eq!(left, [B]);
    }

    #[test]
    fn an_answer_from_another_thread_wakes_the_waiter() {
        let ui = std::sync::Arc::new(UiState::default());
        let now = Instant::now();
        let pending = open_confirm(&ui, A, now).unwrap();
        let answerer = {
            let ui = ui.clone();
            std::thread::spawn(move || {
                ui.answer("r1", UiAnswer::Confirm { value: false }, true, now)
            })
        };
        let host = FakeHost::default();
        assert_eq!(pending.wait(&host, &ui), Ok(json!({ "answer": false })));
        assert!(answerer.join().unwrap());
    }

    #[test]
    fn a_gesture_has_its_shape_and_is_unique() {
        let ui = UiState::default();
        let now = Instant::now();
        let mut seen = HashSet::new();
        for _ in 0..10_000 {
            let token = ui.mint(A, now);
            assert_eq!(token.len(), 35);
            assert!(token.starts_with("g1."));
            assert!(token[3..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert!(seen.insert(token));
        }
    }

    #[test]
    fn a_gesture_lives_five_seconds_and_is_used_once() {
        let ui = UiState::default();
        let t0 = Instant::now();
        let token = ui.mint(A, t0);
        assert!(ui.consume(A, &token, t0 + ms(4_999)));
        assert!(!ui.consume(A, &token, t0 + ms(4_999)));

        let token = ui.mint(A, t0);
        assert!(!ui.consume(A, &token, t0 + ms(5_000)));
        // Expired tokens are pruned.
        assert_eq!(ui.gesture_count(A), 0);
    }

    #[test]
    fn a_gesture_is_bound_to_its_plugin() {
        let ui = UiState::default();
        let now = Instant::now();
        let token = ui.mint(A, now);
        assert!(!ui.consume(B, &token, now));
        assert!(ui.consume(A, &token, now));
        assert!(!ui.consume(A, "g1.00000000000000000000000000000000", now));
    }

    #[test]
    fn the_ninth_gesture_drops_the_plugins_oldest() {
        let ui = UiState::default();
        let now = Instant::now();
        let tokens: Vec<String> = (0..9).map(|_| ui.mint(A, now)).collect();
        let other = ui.mint(B, now);
        assert_eq!(ui.gesture_count(A), MAX_GESTURES_PER_PLUGIN);
        assert!(!ui.consume(A, &tokens[0], now));
        for token in &tokens[1..] {
            assert!(ui.consume(A, token, now));
        }
        assert!(ui.consume(B, &other, now));
    }

    #[test]
    fn drop_gestures_leaves_other_plugins() {
        let ui = UiState::default();
        let now = Instant::now();
        let a = ui.mint(A, now);
        let b = ui.mint(B, now);
        ui.drop_gestures(A);
        assert!(!ui.consume(A, &a, now));
        assert!(ui.consume(B, &b, now));
    }
}

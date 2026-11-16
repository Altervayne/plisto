/*
 * Everything tap-meter says back to Plisto beyond pings and levels: the answer to its page's calls, its
 * sidebar items, its API calls, the feed and app event logs and the output takeover. Each message in gives the frames
 * to send out, and nothing here blocks: an API call goes out as `host_call` and its answer comes back
 * later as `host_result`, matched by seq. So the thread that reads standard input can run it and still
 * answer every ping at once.
 */

// -- Library Imports --
use std::collections::HashMap;

use serde_json::{json, Value};

// -- Local Imports --
use crate::feed::{feed_lines, FeedEvent};
use crate::protocol::{
    ChildMessage, Gesture, HostMessage, LogLevel, ReportedState, PROTOCOL_VERSION,
};
use crate::status::Line;
use crate::takeover::Takeover;

/// The sidebar items declared in `plugin.json`.
pub const ITEM_STATUS: &str = "state";
pub const ITEM_MIRROR: &str = "mirror";
pub const ITEM_PROMPT: &str = "prompt";
// The longest text a sidebar status item takes.
const SIDEBAR_STATUS_MAX_CHARS: usize = 40;
// Feed lines per run; a seek-heavy session stops logging them after this many.
const FEED_LOG_LINES: u32 = 200;
// App event lines per run, for the same reason.
const EVENT_LOG_LINES: u32 = 200;
/// The app event topics this plugin follows. `playback_state` needs `playback.read`; `locale` needs nothing.
const TOPICS: [&str; 2] = ["playback_state", "locale"];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    /// Ask to hold Plisto's output after `ready`.
    pub takeover: bool,
    /// Ask for a prompt with no gesture while the page is closed, to show the refusal.
    pub prompt_unprompted: bool,
}

/// What an open `host_call` was for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    Sidebar,
    Chips,
    Toast,
    Prompt,
    UnpromptedPrompt,
    Subscribe,
}

impl Pending {
    fn name(self) -> &'static str {
        match self {
            Pending::Subscribe => "event subscription",
            Pending::Sidebar => "sidebar update",
            Pending::Chips => "chips",
            Pending::Toast => "toast",
            Pending::Prompt => "prompt",
            Pending::UnpromptedPrompt => "prompt without a gesture",
        }
    }
}

pub fn log(level: LogLevel, text: impl Into<String>) -> ChildMessage {
    ChildMessage::Log {
        level,
        text: text.into(),
    }
}

/// The log line for a stream event: its kind, with the state, or the reason and detail of an end.
fn stream_line(event: &Value) -> ChildMessage {
    let word = |name| event.get(name).and_then(Value::as_str);
    let text = match word("kind") {
        Some("ended") => format!(
            "stream ended: {} ({})",
            word("reason").unwrap_or("no reason"),
            word("detail").unwrap_or("no detail")
        ),
        Some("state") => format!("stream {}", word("state").unwrap_or("in an unknown state")),
        Some(kind) => format!("stream {kind}"),
        None => "stream event with no kind".into(),
    };
    log(LogLevel::Info, text)
}

/// What an app event topic's payload says, in a few words.
fn topic_line(topic: &str, data: &Value) -> String {
    let word = |name| data.get(name).and_then(Value::as_str);
    let number = |name| data.get(name).and_then(Value::as_u64);
    match topic {
        "playback_state" => format!(
            "playback_state: {}, start {}, seek {}",
            word("transport").unwrap_or("unknown"),
            number("start_seq").map_or("?".into(), |n| n.to_string()),
            number("seek_seq").map_or("?".into(), |n| n.to_string()),
        ),
        "locale" => format!("locale: {}", word("locale").unwrap_or("unknown")),
        other => other.to_string(),
    }
}

/// `code (reason)` of a `host_result` error, or `code` alone.
fn refusal(error: Option<&Value>) -> String {
    let field = |name| error.and_then(|e| e.get(name)).and_then(Value::as_str);
    match (field("code"), field("reason")) {
        (Some(code), Some(reason)) => format!("{code} ({reason})"),
        (Some(code), None) => code.to_string(),
        _ => "an error with no code".into(),
    }
}

pub struct Session {
    options: Options,
    page_open: bool,
    transport: Option<String>,
    mirroring: bool,
    last_seq: u64,
    pending: HashMap<u64, Pending>,
    takeover: Takeover,
    unprompted_due: bool,
    feed_lines_left: u32,
    event_lines_left: u32,
}

impl Session {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            page_open: false,
            transport: None,
            mirroring: false,
            last_seq: 0,
            pending: HashMap::new(),
            takeover: Takeover::default(),
            unprompted_due: options.prompt_unprompted,
            feed_lines_left: FEED_LOG_LINES,
            event_lines_left: EVENT_LOG_LINES,
        }
    }

    pub fn page_open(&self) -> bool {
        self.page_open
    }

    /// The last playback state the feed reported, if any.
    pub fn transport(&self) -> Option<&str> {
        self.transport.as_deref()
    }

    pub fn holds_output(&self) -> bool {
        self.takeover.held()
    }

    /// The release to send on a clean exit, when the output is still held.
    pub fn release_on_exit(&mut self) -> Option<ChildMessage> {
        self.takeover.release()
    }

    /// The frames to send for one message from Plisto. `ping` and `shutdown` are the caller's.
    pub fn handle(&mut self, message: HostMessage) -> Vec<ChildMessage> {
        let mut out = Vec::new();
        match message {
            HostMessage::Hello {
                plisto_version,
                id,
                granted,
                ..
            } => self.hello(&mut out, &plisto_version, &id, &granted),
            HostMessage::Call { seq, method, .. } => out.push(answer(seq, &method)),
            HostMessage::Feed { event, lost } => self.feed(&mut out, event, lost),
            HostMessage::HostResult {
                seq,
                ok,
                result,
                error,
            } => self.host_result(&mut out, seq, ok, result.as_ref(), error.as_ref()),
            HostMessage::SidebarInput {
                item_id,
                value,
                gesture,
            } => self.sidebar_input(&mut out, &item_id, value, &gesture),
            HostMessage::TakeoverState { held, reason } => {
                let (level, line) = self.takeover.update(held, reason);
                out.push(log(level, line));
            }
            HostMessage::Page { open } => self.page(&mut out, open),
            HostMessage::Stream { event } => out.push(stream_line(&event)),
            HostMessage::Event { topic, data } => {
                self.event_line(&mut out, format!("event {}", topic_line(&topic, &data)));
            }
            HostMessage::Ping { .. } | HostMessage::Shutdown => {}
        }
        out
    }

    /// Mirrors a status line that went out into the sidebar's status item.
    pub fn status_sent(&mut self, line: &Line) -> Vec<ChildMessage> {
        let text: String = line
            .text
            .as_deref()
            .unwrap_or("-")
            .chars()
            .take(SIDEBAR_STATUS_MAX_CHARS)
            .collect();
        let tone = match line.state {
            ReportedState::On => "accent",
            ReportedState::Idle => "neutral",
            ReportedState::Warn => "warn",
        };
        let state = json!({ "text": text.trim_end(), "tone": tone });
        vec![self.sidebar_update(ITEM_STATUS, state)]
    }

    fn host_call(&mut self, purpose: Pending, method: &str, args: Value) -> ChildMessage {
        self.last_seq += 1;
        self.pending.insert(self.last_seq, purpose);
        ChildMessage::HostCall {
            seq: self.last_seq,
            method: method.into(),
            args,
        }
    }

    fn sidebar_update(&mut self, item_id: &str, state: Value) -> ChildMessage {
        let args = json!({ "item_id": item_id, "state": state });
        self.host_call(Pending::Sidebar, "ui.sidebar.update", args)
    }

    fn hello(&mut self, out: &mut Vec<ChildMessage>, version: &str, id: &str, granted: &[String]) {
        out.push(ChildMessage::Ready {
            protocol: PROTOCOL_VERSION,
        });
        out.push(log(
            LogLevel::Info,
            format!("{id} on Plisto {version}, granted {}", granted.join(", ")),
        ));
        // Sidebar state does not survive a restart, so every run sends its own.
        out.push(self.sidebar_update(ITEM_MIRROR, json!({ "on": self.mirroring })));
        // So does an event subscription: a run starts with none.
        out.push(self.host_call(
            Pending::Subscribe,
            "events.subscribe",
            json!({ "topics": TOPICS }),
        ));
        if self.options.takeover {
            if let Some(request) = self.takeover.request() {
                out.push(request);
                out.push(log(LogLevel::Info, "takeover: asking for Plisto's output"));
            }
        }
    }

    fn feed(&mut self, out: &mut Vec<ChildMessage>, event: Value, lost: u64) {
        let Ok(event) = serde_json::from_value::<FeedEvent>(event) else {
            return;
        };
        if !event.transport.is_empty() {
            self.transport = Some(event.transport.clone());
        }
        for (level, text) in feed_lines(&event, lost) {
            match self.feed_lines_left {
                0 => {}
                1 => out.push(log(LogLevel::Info, "further feed events are not logged")),
                _ => out.push(log(level, text)),
            }
            self.feed_lines_left = self.feed_lines_left.saturating_sub(1);
        }
    }

    /// Logs one app event line, within the run's budget.
    fn event_line(&mut self, out: &mut Vec<ChildMessage>, text: String) {
        match self.event_lines_left {
            0 => {}
            1 => out.push(log(LogLevel::Info, "further app events are not logged")),
            _ => out.push(log(LogLevel::Info, text)),
        }
        self.event_lines_left = self.event_lines_left.saturating_sub(1);
    }

    /// Logs the accepted topics of a subscribe answer and the value each carries now.
    fn subscribed(&mut self, out: &mut Vec<ChildMessage>, result: Option<&Value>) {
        let accepted = result
            .and_then(|r| r.get("topics"))
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        out.push(log(
            LogLevel::Info,
            format!("subscribed to {}", accepted.join(", ")),
        ));
        let current = result
            .and_then(|r| r.get("current"))
            .and_then(Value::as_object);
        for (topic, data) in current.into_iter().flatten() {
            self.event_line(out, format!("current {}", topic_line(topic, data)));
        }
    }

    fn host_result(
        &mut self,
        out: &mut Vec<ChildMessage>,
        seq: u64,
        ok: bool,
        result: Option<&Value>,
        error: Option<&Value>,
    ) {
        let Some(purpose) = self.pending.remove(&seq) else {
            out.push(log(
                LogLevel::Warn,
                format!("host_result for seq {seq}, which is not open"),
            ));
            return;
        };
        if !ok {
            let line = format!("{} refused: {}", purpose.name(), refusal(error));
            out.push(log(LogLevel::Warn, line));
            return;
        }
        if purpose == Pending::Subscribe {
            self.subscribed(out, result);
            return;
        }
        let answer = result
            .and_then(|r| r.get("answer"))
            .and_then(Value::as_bool);
        match (purpose, answer) {
            (Pending::Prompt, Some(yes)) => {
                let word = if yes { "confirmed" } else { "cancelled" };
                out.push(log(LogLevel::Info, format!("prompt {word}")));
                let text = format!("Tap meter: the prompt was {word}.");
                out.push(self.host_call(Pending::Toast, "ui.toast", json!({ "text": text })));
            }
            (Pending::UnpromptedPrompt, _) => out.push(log(
                LogLevel::Info,
                "prompt without a gesture was shown: the page was open",
            )),
            _ => {}
        }
    }

    fn sidebar_input(
        &mut self,
        out: &mut Vec<ChildMessage>,
        item_id: &str,
        value: Option<bool>,
        gesture: &Gesture,
    ) {
        match (item_id, value) {
            (ITEM_MIRROR, Some(on)) => {
                self.mirroring = on;
                let word = if on { "on" } else { "off" };
                out.push(log(
                    LogLevel::Info,
                    format!("mirroring turned {word}; confirming"),
                ));
                out.push(self.sidebar_update(ITEM_MIRROR, json!({ "on": on })));
                let chips = if on {
                    json!([{ "text": "Mirroring", "tone": "accent" }])
                } else {
                    json!([])
                };
                out.push(self.host_call(Pending::Chips, "ui.chips", json!({ "chips": chips })));
            }
            (ITEM_PROMPT, None) => {
                out.push(log(LogLevel::Info, "prompt asked with the click's gesture"));
                let args = prompt_args(Some(gesture));
                out.push(self.host_call(Pending::Prompt, "ui.confirm", args));
            }
            _ => out.push(log(
                LogLevel::Warn,
                format!("sidebar input for an unexpected item '{item_id}'"),
            )),
        }
    }

    fn page(&mut self, out: &mut Vec<ChildMessage>, open: bool) {
        let closed = self.page_open && !open;
        self.page_open = open;
        // Only a real close: with the page open Plisto would let the prompt through, and the closed
        // state Plisto reports right after `ready` would spend the confirm budget at every start.
        if closed && self.unprompted_due {
            self.unprompted_due = false;
            out.push(log(
                LogLevel::Info,
                "asking for a prompt with no gesture and no open page",
            ));
            let args = prompt_args(None);
            out.push(self.host_call(Pending::UnpromptedPrompt, "ui.confirm", args));
        }
    }
}

fn prompt_args(gesture: Option<&Gesture>) -> Value {
    let mut args = json!({
        "title": "Tap meter",
        "body": "This prompt comes from the tap-meter example. Nothing changes whatever you answer.",
        "confirm_label": "Yes",
        "cancel_label": "No",
    });
    if let Some(gesture) = gesture {
        args["gesture"] = json!(gesture.as_str());
    }
    args
}

/// The answer to a call from the page: `ping` answers, any other method is an error the page sees as
/// `plugin_error`.
fn answer(seq: u64, method: &str) -> ChildMessage {
    match method {
        "ping" => ChildMessage::Result {
            seq,
            ok: true,
            result: Some(json!({ "pong": true, "seq": seq })),
            error: None,
        },
        _ => ChildMessage::Result {
            seq,
            ok: false,
            result: None,
            error: Some(json!({ "message": format!("tap-meter has no method '{method}'") })),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::TakeoverReason;

    fn hello() -> HostMessage {
        HostMessage::Hello {
            protocol: 1,
            api_version: 1,
            plisto_version: "2.7.0".into(),
            id: "dev.plisto.tapmeter".into(),
            granted: vec!["audio.tap".into(), "ui.sidebar".into()],
        }
    }

    fn calls(out: &[ChildMessage]) -> Vec<(u64, &str, &Value)> {
        out.iter()
            .filter_map(|m| match m {
                ChildMessage::HostCall { seq, method, args } => Some((*seq, method.as_str(), args)),
                _ => None,
            })
            .collect()
    }

    fn logs(out: &[ChildMessage]) -> Vec<(LogLevel, &str)> {
        out.iter()
            .filter_map(|m| match m {
                ChildMessage::Log { level, text } => Some((*level, text.as_str())),
                _ => None,
            })
            .collect()
    }

    fn input(item_id: &str, value: Option<bool>) -> HostMessage {
        HostMessage::SidebarInput {
            item_id: item_id.into(),
            value,
            gesture: Gesture::new("g-7"),
        }
    }

    fn result(seq: u64, ok: bool, result: Option<Value>, error: Option<Value>) -> HostMessage {
        HostMessage::HostResult {
            seq,
            ok,
            result,
            error,
        }
    }

    #[test]
    fn hello_is_answered_ready_first_and_sets_the_toggle() {
        let mut s = Session::new(Options::default());
        let out = s.handle(hello());
        assert_eq!(out[0], ChildMessage::Ready { protocol: 1 });
        assert!(logs(&out)[0].1.contains("granted audio.tap, ui.sidebar"));
        let sent = calls(&out);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].1, "ui.sidebar.update");
        assert_eq!(
            *sent[0].2,
            json!({"item_id": "mirror", "state": {"on": false}})
        );
        assert_eq!(sent[1].1, "events.subscribe");
        assert_eq!(
            *sent[1].2,
            json!({"topics": ["playback_state", "locale"]})
        );
        assert!(!out
            .iter()
            .any(|m| matches!(m, ChildMessage::Takeover { .. })));
    }

    #[test]
    fn ping_is_answered_and_an_unknown_method_is_an_error() {
        let mut s = Session::new(Options::default());
        let out = s.handle(HostMessage::Call {
            seq: 4,
            method: "ping".into(),
            args: json!({}),
        });
        assert_eq!(
            out,
            [ChildMessage::Result {
                seq: 4,
                ok: true,
                result: Some(json!({"pong": true, "seq": 4})),
                error: None
            }]
        );
        let out = s.handle(HostMessage::Call {
            seq: 5,
            method: "nope".into(),
            args: Value::Null,
        });
        let ChildMessage::Result { seq, ok, error, .. } = &out[0] else {
            panic!("{out:?}");
        };
        assert_eq!((*seq, *ok), (5, false));
        assert_eq!(
            error.as_ref().unwrap()["message"],
            "tap-meter has no method 'nope'"
        );
    }

    #[test]
    fn a_toggle_click_is_confirmed_through_the_sidebar_and_the_chips() {
        let mut s = Session::new(Options::default());
        let out = s.handle(input("mirror", Some(true)));
        let sent = calls(&out);
        assert_eq!(sent[0].1, "ui.sidebar.update");
        assert_eq!(
            *sent[0].2,
            json!({"item_id": "mirror", "state": {"on": true}})
        );
        assert_eq!(sent[1].1, "ui.chips");
        assert_eq!(sent[1].2["chips"][0]["text"], "Mirroring");
        // Both answers close their calls quietly.
        for (seq, _, _) in &sent {
            assert!(s
                .handle(result(*seq, true, Some(json!({})), None))
                .is_empty());
        }
        let off = s.handle(input("mirror", Some(false)));
        let sent = calls(&off);
        assert_eq!(sent[0].2["state"], json!({"on": false}));
        assert_eq!(sent[1].2, &json!({"chips": []}));
    }

    #[test]
    fn the_action_asks_with_the_gesture_it_carries_and_toasts_the_answer() {
        let mut s = Session::new(Options::default());
        let out = s.handle(input("prompt", None));
        let sent = calls(&out);
        assert_eq!(sent[0].1, "ui.confirm");
        assert_eq!(sent[0].2["gesture"], "g-7");
        let seq = sent[0].0;
        let answered = s.handle(result(seq, true, Some(json!({"answer": true})), None));
        assert!(logs(&answered).contains(&(LogLevel::Info, "prompt confirmed")));
        let toast = calls(&answered);
        assert_eq!(toast[0].1, "ui.toast");
        assert_eq!(toast[0].2["text"], "Tap meter: the prompt was confirmed.");
    }

    #[test]
    fn a_prompt_with_no_gesture_waits_for_a_closed_page_and_logs_the_refusal() {
        let options = Options {
            prompt_unprompted: true,
            ..Options::default()
        };
        let mut s = Session::new(options);
        // The closed state reported right after `ready` is not a close.
        assert!(calls(&s.handle(HostMessage::Page { open: false })).is_empty());
        assert!(calls(&s.handle(HostMessage::Page { open: true })).is_empty());
        let out = s.handle(HostMessage::Page { open: false });
        let sent = calls(&out);
        assert_eq!(sent[0].1, "ui.confirm");
        assert!(sent[0].2.get("gesture").is_none());
        let refused = s.handle(result(
            sent[0].0,
            false,
            None,
            Some(json!({"code": "denied", "message": "No gesture.", "reason": "no_gesture"})),
        ));
        assert_eq!(
            logs(&refused),
            [(
                LogLevel::Warn,
                "prompt without a gesture refused: denied (no_gesture)"
            )]
        );
        // Asked once per run.
        s.handle(HostMessage::Page { open: true });
        assert!(calls(&s.handle(HostMessage::Page { open: false })).is_empty());
    }

    #[test]
    fn the_initial_closed_state_asks_no_prompt() {
        let mut s = Session::new(Options {
            prompt_unprompted: true,
            ..Options::default()
        });
        s.handle(hello());
        for _ in 0..3 {
            assert!(calls(&s.handle(HostMessage::Page { open: false })).is_empty());
        }
    }

    #[test]
    fn a_refused_host_call_is_logged_with_its_code() {
        let mut s = Session::new(Options::default());
        let seq = calls(&s.handle(input("mirror", Some(true))))[0].0;
        let out = s.handle(result(
            seq,
            false,
            None,
            Some(json!({"code": "rate_limited"})),
        ));
        assert_eq!(
            logs(&out),
            [(LogLevel::Warn, "sidebar update refused: rate_limited")]
        );
        let stray = s.handle(result(99, true, None, None));
        assert_eq!(logs(&stray)[0].0, LogLevel::Warn);
    }

    #[test]
    fn host_call_seqs_are_unique_while_open() {
        let mut s = Session::new(Options::default());
        let mut seqs: Vec<u64> = calls(&s.handle(hello())).iter().map(|c| c.0).collect();
        seqs.extend(
            calls(&s.handle(input("mirror", Some(true))))
                .iter()
                .map(|c| c.0),
        );
        seqs.extend(calls(&s.handle(input("prompt", None))).iter().map(|c| c.0));
        assert_eq!(seqs, [1, 2, 3, 4, 5]);
    }

    #[test]
    fn every_run_subscribes_again_and_logs_what_the_answer_carries() {
        let mut s = Session::new(Options::default());
        let first = calls(&s.handle(hello()))
            .iter()
            .find(|c| c.1 == "events.subscribe")
            .map(|c| c.0)
            .unwrap();
        let answer = json!({
            "topics": ["locale", "playback_state"],
            "current": {
                "locale": {"locale": "fr"},
                "playback_state": {"transport": "paused", "start_seq": 3, "seek_seq": 1},
            },
        });
        let out = s.handle(result(first, true, Some(answer), None));
        assert_eq!(
            logs(&out),
            [
                (LogLevel::Info, "subscribed to locale, playback_state"),
                (LogLevel::Info, "current locale: fr"),
                (
                    LogLevel::Info,
                    "current playback_state: paused, start 3, seek 1"
                ),
            ]
        );
        // A restarted run gets a new session and asks again.
        let mut again = Session::new(Options::default());
        assert!(calls(&again.handle(hello()))
            .iter()
            .any(|c| c.1 == "events.subscribe"));
    }

    #[test]
    fn a_refused_subscribe_is_logged_with_its_code() {
        let mut s = Session::new(Options::default());
        let seq = calls(&s.handle(hello()))[1].0;
        let out = s.handle(result(
            seq,
            false,
            None,
            Some(json!({"code": "denied", "message": "The 'playback_state' topic needs the playback.read permission."})),
        ));
        assert_eq!(
            logs(&out),
            [(LogLevel::Warn, "event subscription refused: denied")]
        );
    }

    #[test]
    fn an_event_is_logged_by_its_topic_within_a_budget() {
        let mut s = Session::new(Options::default());
        let event = |topic: &str, data: Value| HostMessage::Event {
            topic: topic.into(),
            data,
        };
        let out = s.handle(event("locale", json!({"locale": "en"})));
        assert_eq!(logs(&out), [(LogLevel::Info, "event locale: en")]);
        let out = s.handle(event(
            "playback_state",
            json!({"transport": "playing", "start_seq": 4, "seek_seq": 2, "position_secs": 9.5}),
        ));
        assert_eq!(
            logs(&out),
            [(LogLevel::Info, "event playback_state: playing, start 4, seek 2")]
        );
        assert_eq!(
            logs(&s.handle(event("queue", json!({}))))[0].1,
            "event queue"
        );
        for _ in 0..EVENT_LOG_LINES - 4 {
            s.handle(event("locale", json!({"locale": "en"})));
        }
        let last = s.handle(event("locale", json!({"locale": "en"})));
        assert_eq!(
            logs(&last),
            [(LogLevel::Info, "further app events are not logged")]
        );
        assert!(s.handle(event("locale", json!({"locale": "en"}))).is_empty());
    }

    #[test]
    fn takeover_is_asked_once_after_ready_and_released_only_while_held() {
        let mut s = Session::new(Options {
            takeover: true,
            ..Options::default()
        });
        let out = s.handle(hello());
        assert_eq!(out[0], ChildMessage::Ready { protocol: 1 });
        let asks = |out: &[ChildMessage]| {
            out.iter()
                .filter(|m| **m == ChildMessage::Takeover { hold: true })
                .count()
        };
        assert_eq!(asks(&out), 1);
        let granted = s.handle(HostMessage::TakeoverState {
            held: true,
            reason: TakeoverReason::Granted,
        });
        assert!(logs(&granted)[0].1.starts_with("takeover_state granted"));
        assert!(s.holds_output());
        s.handle(HostMessage::TakeoverState {
            held: false,
            reason: TakeoverReason::User,
        });
        assert!(!s.holds_output());
        assert_eq!(s.release_on_exit(), None);
    }

    #[test]
    fn the_feed_sets_the_transport_and_reports_loss_and_snapshot() {
        let mut s = Session::new(Options::default());
        let snapshot =
            json!({"seq": 30, "cause": "snapshot", "transport": "paused", "tap_epoch": 1});
        let out = s.handle(HostMessage::Feed {
            event: snapshot,
            lost: 0,
        });
        assert_eq!(s.transport(), Some("paused"));
        assert!(logs(&out)[0].1.starts_with("feed snapshot: paused"));
        let out = s.handle(HostMessage::Feed {
            event: json!({"seq": 33, "cause": "resume", "transport": "playing"}),
            lost: 2,
        });
        assert_eq!(
            logs(&out)[0],
            (LogLevel::Warn, "feed lost 2 event(s) before seq 33")
        );
        assert_eq!(s.transport(), Some("playing"));
    }

    #[test]
    fn a_stream_event_is_logged_by_its_kind() {
        let mut s = Session::new(Options::default());
        let cases = [
            (json!({"item": -4, "kind": "state", "state": "buffering"}), "stream buffering"),
            (json!({"item": -4, "kind": "skip", "direction": "next"}), "stream skip"),
            (
                json!({"item": -4, "kind": "ended", "reason": "network", "detail": "closed"}),
                "stream ended: network (closed)",
            ),
            (
                json!({"item": -4, "kind": "ended", "reason": "user", "detail": null}),
                "stream ended: user (no detail)",
            ),
            (json!({"item": -4}), "stream event with no kind"),
        ];
        for (event, line) in cases {
            let out = s.handle(HostMessage::Stream { event });
            assert_eq!(logs(&out), [(LogLevel::Info, line)]);
        }
    }

    #[test]
    fn the_status_item_follows_the_status_line_within_its_cap() {
        let mut s = Session::new(Options::default());
        let line = Line::new(ReportedState::Warn, &"x".repeat(60));
        let out = s.status_sent(&line);
        let sent = calls(&out);
        assert_eq!(sent[0].2["item_id"], "state");
        assert_eq!(sent[0].2["state"]["tone"], "warn");
        assert_eq!(sent[0].2["state"]["text"].as_str().unwrap().len(), 40);
    }
}

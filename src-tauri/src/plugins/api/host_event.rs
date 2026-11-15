/*
 * The events Rust sends the main window about plugin UI surfaces: `plugins:ui` for toasts, prompts,
 * their withdrawal and page requests, `plugins:sidebar` for chips and sidebar item state,
 * `plugins:page_event` for what a native plugin's child pushes to its page, `plugins:net` for stream
 * chunks and socket messages, and `plugins:stream` for what the owner of the seated playback stream
 * is told. They carry plugin text, data and ids only, never a gesture token.
 */

// -- Library Imports --
use serde::Serialize;
use serde_json::Value;

// -- Local Imports --
use super::net::sink::NetEvent;
use super::stream::StreamEvent;

pub const EVENT_UI: &str = "plugins:ui";
pub const EVENT_SIDEBAR: &str = "plugins:sidebar";
pub const EVENT_PAGE: &str = "plugins:page_event";
pub const EVENT_NET: &str = "plugins:net";
pub const EVENT_STREAM: &str = "plugins:stream";

/// One event for the main window.
#[derive(Clone, Debug, PartialEq)]
pub enum HostEvent {
    Ui(UiEvent),
    Sidebar(SidebarEvent),
    Page(PageEvent),
    Net(NetEvent),
    Stream(StreamHostEvent),
}

/// A playback-stream event for plugin `id`, which the window hands to that plugin's newest frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StreamHostEvent {
    pub id: String,
    pub event: StreamEvent,
}

/// A toast, a prompt, the withdrawal of either, or a page request from plugin `id`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UiEvent {
    pub request_id: String,
    pub id: String,
    #[serde(flatten)]
    pub kind: UiKind,
}

/// Serialized as `kind` with its fields under `payload`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum UiKind {
    Toast {
        text: String,
        action: Option<String>,
    },
    Confirm {
        title: String,
        body: String,
        confirm_label: String,
        cancel_label: Option<String>,
    },
    Close {},
    OpenPage {
        route: Option<String>,
    },
}

/// A change to plugin `id`'s chips or to one of its sidebar items.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SidebarEvent {
    pub id: String,
    #[serde(flatten)]
    pub kind: SidebarKind,
}

/// The stored chip list or item state, already in its wire shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidebarKind {
    Chips { chips: Vec<Value> },
    Item { item_id: String, state: Value },
}

/// An event a native plugin's child sent to its own page, which the window hands to that page's frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PageEvent {
    pub id: String,
    pub topic: String,
    pub data: Value,
}

impl UiEvent {
    /// Withdraws the toast or prompt `request_id` of plugin `id`.
    pub fn close(request_id: &str, id: &str) -> UiEvent {
        UiEvent {
            request_id: request_id.to_string(),
            id: id.to_string(),
            kind: UiKind::Close {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ui(kind: UiKind) -> Value {
        serde_json::to_value(UiEvent {
            request_id: "r1".into(),
            id: "com.example.demo".into(),
            kind,
        })
        .unwrap()
    }

    #[test]
    fn ui_events_have_their_wire_shape() {
        assert_eq!(
            ui(UiKind::Toast {
                text: "Saved".into(),
                action: None
            }),
            json!({ "request_id": "r1", "id": "com.example.demo", "kind": "toast",
                    "payload": { "text": "Saved", "action": null } })
        );
        assert_eq!(
            ui(UiKind::Confirm {
                title: "T".into(),
                body: "B".into(),
                confirm_label: "Go".into(),
                cancel_label: None
            }),
            json!({ "request_id": "r1", "id": "com.example.demo", "kind": "confirm",
                    "payload": { "title": "T", "body": "B", "confirm_label": "Go", "cancel_label": null } })
        );
        assert_eq!(
            serde_json::to_value(UiEvent::close("r1", "com.example.demo")).unwrap(),
            json!({ "request_id": "r1", "id": "com.example.demo", "kind": "close", "payload": {} })
        );
        assert_eq!(
            ui(UiKind::OpenPage { route: None }),
            json!({ "request_id": "r1", "id": "com.example.demo", "kind": "open_page",
                    "payload": { "route": null } })
        );
    }

    #[test]
    fn sidebar_events_have_their_wire_shape() {
        let chips = SidebarEvent {
            id: "com.example.demo".into(),
            kind: SidebarKind::Chips { chips: Vec::new() },
        };
        assert_eq!(
            serde_json::to_value(chips).unwrap(),
            json!({ "id": "com.example.demo", "kind": "chips", "chips": [] })
        );
        let item = SidebarEvent {
            id: "com.example.demo".into(),
            kind: SidebarKind::Item {
                item_id: "state".into(),
                state: json!({ "type": "status" }),
            },
        };
        assert_eq!(
            serde_json::to_value(item).unwrap(),
            json!({ "id": "com.example.demo", "kind": "item", "item_id": "state",
                    "state": { "type": "status" } })
        );
    }

    #[test]
    fn page_events_have_their_wire_shape() {
        let event = PageEvent {
            id: "com.example.demo".into(),
            topic: "levels".into(),
            data: json!([0.5, 0.25]),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "id": "com.example.demo", "topic": "levels", "data": [0.5, 0.25] })
        );
    }
}

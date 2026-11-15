/*
 * A stream whose plugin went away. A plugin that stops serving loses its item with `plugin_gone` and
 * the reason it stopped, which picks the player's toast. One that still serves keeps a fetched item
 * playing, since Plisto holds the connection, and loses a pushed item only when the producer that
 * pushed it, a frame or the native child, is the one that went.
 */

// -- Library Imports --
use std::time::Instant;

// -- Local Imports --
use super::hub::{StreamHub, Teller};
use crate::audio::StreamEndReason;
use crate::plugins::api::Caller;

/// Why a plugin stopped serving, as its stream's `plugin_gone` end reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gone {
    /// Disabled, uninstalled, turned off after crashes, or the app is leaving.
    Off,
    /// Updated with its consent kept.
    Update,
    /// It needs the user's approval again.
    Consent,
    /// Plugins are off for this session.
    SafeMode,
}

impl Gone {
    pub fn detail(self) -> Option<&'static str> {
        match self {
            Gone::Off => None,
            Gone::Update => Some("update"),
            Gone::Consent => Some("consent"),
            Gone::SafeMode => Some("safe_mode"),
        }
    }
}

/// Which of a plugin's producers went away while the plugin still serves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Producer {
    Any,
    Frame,
    Child,
}

impl From<Caller> for Producer {
    fn from(caller: Caller) -> Producer {
        match caller {
            Caller::Frame => Producer::Frame,
            Caller::Child => Producer::Child,
        }
    }
}

impl StreamHub {
    /// Plugin `id`'s calls, or the producer `left` of them, are forgotten. Reads the serving set
    /// under the session lock, as a play's acceptance does.
    pub fn forget(&self, id: &str, gone: Gone, left: Producer) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        let Some(item) = session.item.as_ref().filter(|item| item.plugin_id == id) else {
            return;
        };
        let item_id = item.id;
        let (reason, detail) = if !self.serves(id) {
            (StreamEndReason::PluginGone, gone.detail())
        } else if item.is_push() && (left == Producer::Any || left == item.producer) {
            (StreamEndReason::ProducerGone, None)
        } else {
            return;
        };
        let now = Instant::now();
        self.end_current(
            &mut session,
            &*link,
            item_id,
            reason,
            detail,
            Teller::Hub,
            now,
        );
    }

    /// Ends whatever plays as its plugin gone.
    pub fn end_all(&self, gone: Gone) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        if let Some(item) = session.item.take() {
            let (reason, now) = (StreamEndReason::PluginGone, Instant::now());
            self.end_item(
                &mut session,
                &*link,
                item,
                reason,
                gone.detail(),
                Teller::Hub,
                now,
            );
        }
    }

    /// Ends whatever plays and accepts nothing more: the app is leaving.
    pub fn close(&self) {
        self.lock().closed = true;
        self.end_all(Gone::Off);
    }

    /// Ends whatever plays and accepts nothing until `release`: an app update is installing. Set
    /// before the plugins stop, so no play gets in while they do.
    pub fn hold(&self) {
        self.lock().held = true;
        self.end_all(Gone::Update);
    }

    /// Accepts plays again after `hold`: the update did not install.
    pub fn release(&self) {
        self.lock().held = false;
    }
}

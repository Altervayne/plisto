/*
 * App event topics: what is playing, the transport, the queue, library changes and the theme, locale
 * and app mode, pushed to the plugins that subscribed. `events.subscribe` replaces the frame side of
 * the calling plugin and answers the current value of every state topic it accepts and could read.
 * Subscriptions keep a child side apart from the frame side, but a native child's subscribe is
 * refused: children have no event delivery.
 * Rust composes every value once (`compose`), the hub thread gates and paces it per plugin, side and
 * topic (`hub`, `coalesce`), and the grant is checked again before every delivery (`hub`).
 */

// -- Module Declarations --
mod coalesce;
pub(crate) mod compose;
pub(crate) mod hub;
mod subs;

// -- Library Imports --
use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

// -- Local Imports --
use self::compose::LibraryChange;
use self::hub::Env;
use super::error::ApiError;
use super::rate::RateClass;
use super::{CallCtx, Caller, MethodSpec, Need, Outcome};
use crate::plugins::manifest::Capability;

pub(crate) use self::hub::spawn;
pub(crate) use self::subs::{EventSubs, Side};

/// The most topic names one subscribe takes.
pub const MAX_TOPICS: usize = 16;
/// The owner-only stream topic, which never travels through `events.subscribe`.
const RESERVED: &str = "stream";

pub(super) const METHODS: &[MethodSpec] = &[MethodSpec {
    name: "events.subscribe",
    need: Need::Ambient,
    class: RateClass::Ambient,
    run: subscribe,
}];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Topic {
    NowPlaying,
    PlaybackState,
    Queue,
    LibraryChanged,
    Theme,
    Locale,
    AppMode,
}

impl Topic {
    pub const ALL: [Topic; 7] = [
        Topic::NowPlaying,
        Topic::PlaybackState,
        Topic::Queue,
        Topic::LibraryChanged,
        Topic::Theme,
        Topic::Locale,
        Topic::AppMode,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Topic::NowPlaying => "now_playing",
            Topic::PlaybackState => "playback_state",
            Topic::Queue => "queue",
            Topic::LibraryChanged => "library_changed",
            Topic::Theme => "theme",
            Topic::Locale => "locale",
            Topic::AppMode => "app_mode",
        }
    }

    pub fn from_name(name: &str) -> Option<Topic> {
        Topic::ALL.into_iter().find(|topic| topic.name() == name)
    }

    pub fn need(self) -> Need {
        match self {
            Topic::NowPlaying | Topic::PlaybackState | Topic::Queue => {
                Need::Cap(Capability::PlaybackRead)
            }
            Topic::LibraryChanged => Need::Cap(Capability::LibraryRead),
            Topic::Theme | Topic::Locale | Topic::AppMode => Need::Ambient,
        }
    }

    /// A state topic has a current value; an edge topic only reports changes.
    pub fn is_state(self) -> bool {
        self != Topic::LibraryChanged
    }

    pub fn bit(self) -> u8 {
        1 << self as u8
    }
}

/// This build's topic names, sorted.
pub fn topic_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Topic::ALL.iter().map(|t| t.name()).collect();
    names.sort_unstable();
    names
}

fn bits(topics: &[Topic]) -> u8 {
    topics.iter().fold(0, |mask, topic| mask | topic.bit())
}

/// What the hub is told. Each input reaches it only while a topic it can change has a listener.
#[derive(Debug)]
pub enum Input {
    /// `player:status`.
    Status,
    /// `player:queue`.
    Queue,
    /// `player:stream`.
    Stream,
    /// A theme, locale or app mode setting was written, or the OS theme changed.
    Ambient,
    /// The frontend saw the library change.
    Library(LibraryChange),
    /// A subscribe was answered: these topics are composed again, so a change during the answer
    /// still lands.
    Refresh(u8),
}

impl Input {
    pub fn bits(&self) -> u8 {
        match self {
            Input::Status => bits(&[Topic::NowPlaying, Topic::PlaybackState, Topic::Queue]),
            Input::Queue => Topic::Queue.bit(),
            Input::Stream => bits(&[Topic::NowPlaying, Topic::PlaybackState]),
            Input::Ambient => bits(&[Topic::Theme, Topic::Locale, Topic::AppMode]),
            // An edit can change the playing track's row.
            Input::Library(_) => bits(&[Topic::LibraryChanged, Topic::NowPlaying]),
            Input::Refresh(bits) => *bits,
        }
    }
}

/// How a native child takes a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildDelivery {
    Sent,
    /// Its outbox is full: the value is retried.
    Full,
    NotRunning,
}

/// The `topics` argument: 0 to 16 known names, duplicates ignored.
fn topics_arg(args: &Map<String, Value>) -> Result<BTreeSet<Topic>, ApiError> {
    let Some(Value::Array(names)) = args.get("topics") else {
        return Err(ApiError::invalid_args(
            "'topics' must be an array of topic names.",
        ));
    };
    if names.len() > MAX_TOPICS {
        return Err(ApiError::invalid_args("'topics' holds at most 16 names."));
    }
    names
        .iter()
        .map(|name| match name.as_str() {
            Some(RESERVED) => Err(ApiError::invalid_args(
                "The 'stream' topic is reserved and cannot be subscribed to.",
            )),
            Some(name) => {
                Topic::from_name(name).ok_or_else(|| ApiError::invalid_args("Unknown topic."))
            }
            None => Err(ApiError::invalid_args(
                "'topics' must be an array of topic names.",
            )),
        })
        .collect()
}

fn denied_for(topic: Topic) -> ApiError {
    let grant = match topic.need() {
        Need::Cap(cap) => cap.as_str(),
        Need::Ambient => "",
    };
    ApiError {
        message: format!("The '{}' topic needs the {grant} permission.", topic.name()),
        ..ApiError::denied()
    }
}

/// Whether the plugin still serves with the version and grants the call was admitted under.
fn serves_as_admitted(ctx: &CallCtx<'_>) -> bool {
    ctx.enabled
        .serving(ctx.id)
        .is_some_and(|now| now.version == ctx.serving.version && now.granted == ctx.serving.granted)
}

fn subscribe(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(run_subscribe(ctx, args))
}

fn run_subscribe(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    // A native child has no event delivery, so its subscribe is refused and sets nothing.
    if ctx.caller == Caller::Child {
        return Err(ApiError::unavailable());
    }
    let topics = topics_arg(args)?;
    for &topic in &topics {
        if let Need::Cap(cap) = topic.need() {
            if !ctx.serving.granted.contains(&cap) {
                return Err(denied_for(topic));
            }
        }
    }
    let state: Vec<Topic> = topics.iter().copied().filter(|t| t.is_state()).collect();
    let env = Env {
        api: ctx.api,
        enabled: ctx.enabled,
        host: ctx.host,
    };
    let current = hub::current(&env, ctx.id, &state, hub::unix_ms());
    let events = ctx.api.events();
    let side = Side::from(ctx.caller);
    events.replace(ctx.id, side, &topics, &current);
    // A plugin that stopped serving, or was updated or reinstalled, during the call keeps nothing
    // from it.
    if !serves_as_admitted(ctx) {
        events.drop_side(ctx.id, side);
        return Err(ApiError::unavailable());
    }
    events.feed(Input::Refresh(bits(&state)));
    let mut names: Vec<&str> = topics.iter().map(|t| t.name()).collect();
    names.sort_unstable();
    let current: Map<String, Value> = current
        .into_iter()
        .map(|(topic, value)| (topic.name().to_string(), value))
        .collect();
    Ok(json!({ "topics": names, "current": current }))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_edges;
#[cfg(test)]
mod tests_hub;

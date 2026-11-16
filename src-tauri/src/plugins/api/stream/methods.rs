/*
 * The `stream.*` methods. Every one needs `playback.stream`, and no caller needs its page open or a
 * gesture: the granted capability is the gate. A refusal arrives as a call error; anything after a
 * play is accepted arrives as an `ended` event. A fetched item counts as one of the plugin's
 * streams, so a plugin whose page already holds all of them is `busy`.
 */

// -- Library Imports --
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};

// -- Local Imports --
use super::args::{self, item, Source};
use super::feeder::Wire;
use super::hub::Owner;
use crate::plugins::api::error::ApiError;
use crate::plugins::api::net::methods::user_agent;
use crate::plugins::api::net::state::{MAX_STREAMS, MAX_STREAMS_PER_PLUGIN};
use crate::plugins::api::rate::RateClass;
use crate::plugins::api::{CallCtx, Handler, MethodSpec, Need, Outcome};
use crate::plugins::manifest::Capability;
use crate::plugins::paths::plugin_dir;
use crate::plugins::summary::read_manifest;

/// The most bytes one `stream.push` carries.
pub const PUSH_MAX_BYTES: usize = 65_536;

const fn method(name: &'static str, class: RateClass, run: Handler) -> MethodSpec {
    MethodSpec {
        name,
        need: Need::Cap(Capability::PlaybackStream),
        class,
        run,
    }
}

pub(crate) const METHODS: &[MethodSpec] = &[
    method("stream.play", RateClass::Stream, play),
    method("stream.update", RateClass::StreamMeta, update),
    method("stream.push", RateClass::StreamPush, push),
    method("stream.end", RateClass::StreamPush, end),
    method("stream.pause", RateClass::Stream, pause),
    method("stream.resume", RateClass::Stream, resume),
    method("stream.stop", RateClass::Stream, stop),
    method("stream.state", RateClass::PlaybackRead, state),
];

fn done(result: Result<(), ApiError>) -> Outcome {
    Outcome::Done(result.map(|()| json!({})))
}

/// The name the plugin rail shows: the installed manifest's, or the id when it cannot be read.
fn plugin_name(ctx: &CallCtx<'_>) -> String {
    read_manifest(&plugin_dir(ctx.app_data, ctx.id))
        .map(|manifest| manifest.name)
        .unwrap_or_else(|| ctx.id.to_string())
}

fn play(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    let hub = ctx.api.streams();
    let result = args::play(ctx, args).and_then(|play| {
        // The seated item's own connection is not counted: this play replaces it, and its slot is
        // free once it ends.
        if matches!(play.source, Source::Pull(_)) {
            let (mine, all) = ctx.api.net().page_streams(ctx.id);
            if mine >= MAX_STREAMS_PER_PLUGIN || all >= MAX_STREAMS {
                return Err(ApiError::busy());
            }
        }
        let accepting = hub.begin(ctx.id);
        let wire = ctx.host.net().map(|engine| {
            Arc::new(Wire {
                clients: engine.clients(),
                net: ctx.api.net().clone(),
                user_agent: user_agent(ctx.id, &ctx.serving.version),
            })
        });
        let owner = Owner {
            id: ctx.id.to_string(),
            name: plugin_name(ctx),
            producer: ctx.caller.into(),
            wire,
        };
        hub.accept(owner, play, &accepting, ctx.enabled, hub.clock().now())
    });
    Outcome::Done(result.map(|item| json!({ "item": item, "state": "connecting" })))
}

fn update(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    done(apply_update(ctx, args))
}

fn apply_update(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<(), ApiError> {
    let hub = ctx.api.streams();
    let item = item(args)?;
    let live = hub.is_live(ctx.id, item)?;
    let update = args::update(ctx, args, live)?;
    hub.update(ctx.id, item, update)
}

fn push(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    let result = push_bytes(ctx, args);
    Outcome::Done(
        result.map(|(buffered_ms, room)| json!({ "buffered_ms": buffered_ms, "room": room })),
    )
}

fn push_bytes(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<(u64, usize), ApiError> {
    let item = item(args)?;
    let data = args
        .get("data_b64")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_args("'data_b64' must be a string."))?;
    // Base64 of the cap is at most 4/3 of it: anything longer cannot fit.
    if data.len() > PUSH_MAX_BYTES / 3 * 4 + 4 {
        return Err(ApiError::too_large("A push carries at most 65536 bytes."));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| ApiError::invalid_args("'data_b64' is not valid base64."))?;
    match bytes.len() {
        0 => Err(ApiError::invalid_args("A push carries at least 1 byte.")),
        n if n > PUSH_MAX_BYTES => Err(ApiError::too_large("A push carries at most 65536 bytes.")),
        _ => ctx.api.streams().push(ctx.id, item, &bytes),
    }
}

fn end(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    done(item(args).and_then(|item| ctx.api.streams().end_push(ctx.id, item)))
}

fn pause(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    done(item(args).and_then(|item| ctx.api.streams().pause(ctx.id, item, true)))
}

fn resume(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    done(item(args).and_then(|item| ctx.api.streams().pause(ctx.id, item, false)))
}

fn stop(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    done(item(args).and_then(|item| ctx.api.streams().stop(ctx.id, item)))
}

fn state(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    let hub = ctx.api.streams();
    Outcome::Done(Ok(hub.state(ctx.id, hub.clock().now())))
}

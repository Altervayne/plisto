/*
 * The arguments of `stream.play` and `stream.update`, checked in a fixed order: shape and
 * sizes first, then the `network` grant a URL needs, then its origin. Nothing here touches the hub,
 * so a call refused here changes nothing.
 */

// -- Library Imports --
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{Map, Value};

// -- Local Imports --
use super::meta::{optional, required, Meta};
use super::Skip;
use crate::audio::stream::{PushFormat, PCM_MAX_CHANNELS, PCM_RATES};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::net::methods::headers;
use crate::plugins::api::net::policy::{check_headers, check_url, Consent, Transport};
use crate::plugins::api::CallCtx;
use crate::plugins::manifest::Capability;

/// The most artwork bytes `data_b64` may decode to.
pub const ART_MAX_BYTES: usize = 524_288;

const BAD_TITLE: &str = "'title' must be 1 to 200 characters of text.";
const BAD_ARTIST: &str = "'artist' must be at most 200 characters of text.";
const BAD_ALBUM: &str = "'album' must be at most 200 characters of text.";
const BAD_NOW: &str = "'now' must be at most 200 characters of text.";
const NOW_NOT_LIVE: &str = "'now' is for a live item only.";

/// Where the bytes come from.
pub enum Source {
    /// Plisto fetches the URL.
    Pull(Pull),
    /// The plugin pushes bytes in `format`.
    Push(PushFormat),
}

/// A checked `stream.play`.
pub struct Play {
    pub source: Source,
    pub live: bool,
    pub meta: Meta,
    pub artwork: Option<Artwork>,
    pub skip: Skip,
}

/// What a pull item fetches. The headers are checked, with lowercase names.
pub struct Pull {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub icy: bool,
    /// The plugin's own `live`; None leaves it to the response head.
    pub live: Option<bool>,
}

/// Artwork to show: bytes to decode, or a URL to fetch first.
pub enum Artwork {
    Bytes(Vec<u8>),
    Url(String),
}

/// A field present with a non-null value.
fn given<'a>(args: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    args.get(name).filter(|v| !v.is_null())
}

fn text<'a>(value: &'a Value, refused: &'static str) -> Result<&'a str, ApiError> {
    value
        .as_str()
        .ok_or_else(|| ApiError::invalid_args(refused))
}

fn optional_text(
    args: &Map<String, Value>,
    name: &str,
    refused: &'static str,
) -> Result<Option<String>, ApiError> {
    match given(args, name) {
        None => Ok(None),
        Some(value) => optional(text(value, refused)?, refused),
    }
}

fn flag(
    args: &Map<String, Value>,
    name: &str,
    refused: &'static str,
) -> Result<Option<bool>, ApiError> {
    match given(args, name) {
        None => Ok(None),
        Some(Value::Bool(on)) => Ok(Some(*on)),
        Some(_) => Err(ApiError::invalid_args(refused)),
    }
}

/// `skip`: both flags default to false.
pub fn skip(value: &Value) -> Result<Skip, ApiError> {
    let refused = "'skip' must be an object of 'next' and 'prev' booleans.";
    let Value::Object(map) = value else {
        return Err(ApiError::invalid_args(refused));
    };
    Ok(Skip {
        next: flag(map, "next", refused)?.unwrap_or(false),
        prev: flag(map, "prev", refused)?.unwrap_or(false),
    })
}

/// Checks a URL the caller wants fetched: the `network` grant, then a consented origin.
fn check_fetch(ctx: &CallCtx<'_>, raw: &str) -> Result<(), ApiError> {
    if !ctx.serving.granted.contains(&Capability::Network) {
        return Err(ApiError::denied());
    }
    let consent = Consent {
        origins: &ctx.serving.origins,
        dev_mode: ctx.serving.dev_mode,
    };
    check_url(raw, Transport::Fetch, consent)
        .map(drop)
        .map_err(ApiError::from)
}

/// `artwork`, its shape and then a URL's grant and origin.
pub fn artwork(ctx: &CallCtx<'_>, value: &Value) -> Result<Artwork, ApiError> {
    let (artwork, url) = artwork_shape(value)?;
    if let Some(url) = url {
        check_fetch(ctx, url)?;
    }
    Ok(artwork)
}

/// `artwork`'s shape and size: `{ url }`, with the URL left to check, or `{ data_b64 }`.
fn artwork_shape(value: &Value) -> Result<(Artwork, Option<&str>), ApiError> {
    let refused = "'artwork' must hold exactly one of 'url' and 'data_b64'.";
    let Value::Object(map) = value else {
        return Err(ApiError::invalid_args(refused));
    };
    match (given(map, "url"), given(map, "data_b64")) {
        (Some(url), None) => {
            let url = text(url, refused)?;
            Ok((Artwork::Url(url.to_string()), Some(url)))
        }
        (None, Some(data)) => {
            let data = text(data, refused)?;
            // Base64 of the cap is at most 4/3 of it: anything longer cannot fit.
            if data.len() > ART_MAX_BYTES / 3 * 4 + 4 {
                return Err(ApiError::too_large("The artwork is over 524288 bytes."));
            }
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| ApiError::invalid_args("'data_b64' is not valid base64."))?;
            match bytes.len() {
                0 => Err(ApiError::invalid_args("The artwork is empty.")),
                n if n > ART_MAX_BYTES => {
                    Err(ApiError::too_large("The artwork is over 524288 bytes."))
                }
                _ => Ok((Artwork::Bytes(bytes), None)),
            }
        }
        _ => Err(ApiError::invalid_args(refused)),
    }
}

/// A push `format` with its PCM spec.
fn push_format(push: &Map<String, Value>) -> Result<PushFormat, ApiError> {
    let refused = "'format' must be mp3, aac_adts, ogg, flac or pcm_s16le.";
    let spec =
        "'rate' (8000 to 192000) and 'channels' (1 or 2) are for pcm_s16le, and required there.";
    let format = given(push, "format").and_then(Value::as_str);
    let rate = given(push, "rate");
    let channels = given(push, "channels");
    let plain = |format: PushFormat| match (rate, channels) {
        (None, None) => Ok(format),
        _ => Err(ApiError::invalid_args(spec)),
    };
    match format {
        Some("mp3") => plain(PushFormat::Mp3),
        Some("aac_adts") => plain(PushFormat::AacAdts),
        Some("ogg") => plain(PushFormat::Ogg),
        Some("flac") => plain(PushFormat::Flac),
        Some("pcm_s16le") => {
            let rate = rate
                .and_then(Value::as_u64)
                .and_then(|r| u32::try_from(r).ok())
                .filter(|r| PCM_RATES.contains(r));
            let channels = channels
                .and_then(Value::as_u64)
                .and_then(|c| u16::try_from(c).ok())
                .filter(|c| (1..=PCM_MAX_CHANNELS).contains(c));
            match (rate, channels) {
                (Some(rate), Some(channels)) => Ok(PushFormat::PcmS16le { rate, channels }),
                _ => Err(ApiError::invalid_args(spec)),
            }
        }
        _ => Err(ApiError::invalid_args(refused)),
    }
}

/// The source's shape, with a URL's headers; the URL is left to check.
fn source_shape(value: Option<&Value>) -> Result<(Source, Option<&str>), ApiError> {
    let refused = "'source' must hold exactly one of 'url' and 'push'.";
    let Some(Value::Object(map)) = value else {
        return Err(ApiError::invalid_args(refused));
    };
    match (given(map, "url"), given(map, "push")) {
        (Some(url), None) => {
            let url = text(url, refused)?;
            let headers = check_headers(&headers(map)?).map_err(ApiError::from)?;
            let icy = flag(map, "icy", "'icy' must be a boolean.")?.unwrap_or(false);
            let pull = Pull {
                url: url.to_string(),
                headers,
                icy,
                live: None,
            };
            Ok((Source::Pull(pull), Some(url)))
        }
        (None, Some(Value::Object(push))) => Ok((Source::Push(push_format(push)?), None)),
        _ => Err(ApiError::invalid_args(refused)),
    }
}

/// Checks a `stream.play`. A push item is live unless the plugin says it will end it.
pub fn play(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Play, ApiError> {
    let title = given(args, "title").ok_or_else(|| ApiError::invalid_args(BAD_TITLE))?;
    let title = required(text(title, BAD_TITLE)?, BAD_TITLE)?;
    let live = flag(args, "live", "'live' must be a boolean.")?;
    let meta = Meta {
        title,
        artist: optional_text(args, "artist", BAD_ARTIST)?,
        album: optional_text(args, "album", BAD_ALBUM)?,
        now: optional_text(args, "now", BAD_NOW)?,
    };
    let skip = given(args, "skip")
        .map(skip)
        .transpose()?
        .unwrap_or_default();
    let (mut source, source_url) = source_shape(args.get("source"))?;
    if let Source::Pull(pull) = &mut source {
        pull.live = live;
    }
    let (artwork, artwork_url) = match given(args, "artwork") {
        Some(value) => {
            let (artwork, url) = artwork_shape(value)?;
            (Some(artwork), url)
        }
        None => (None, None),
    };
    // A pull item is live unless the plugin says otherwise.
    let live = live.unwrap_or(true);
    if meta.now.is_some() && !live {
        return Err(ApiError::invalid_args(NOW_NOT_LIVE));
    }
    for url in [source_url, artwork_url].into_iter().flatten() {
        check_fetch(ctx, url)?;
    }
    Ok(Play {
        source,
        live,
        meta,
        artwork,
        skip,
    })
}

/// What a `stream.update` changes. Outer `None` leaves a field as it is, inner `None` clears it.
#[derive(Default)]
pub struct Update {
    pub title: Option<String>,
    pub artist: Option<Option<String>>,
    pub album: Option<Option<String>>,
    pub now: Option<Option<String>>,
    pub artwork: Option<Option<Artwork>>,
    pub skip: Option<Skip>,
}

/// A field that may be cleared with `null`: absent, cleared, or a value.
fn clearable(
    args: &Map<String, Value>,
    name: &str,
    refused: &'static str,
) -> Result<Option<Option<String>>, ApiError> {
    match args.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => optional(text(value, refused)?, refused).map(Some),
    }
}

/// Checks a `stream.update`: at least one field, and a title that is never cleared.
pub fn update(
    ctx: &CallCtx<'_>,
    args: &Map<String, Value>,
    live: bool,
) -> Result<Update, ApiError> {
    let title = match args.get("title") {
        None => None,
        Some(value) => Some(required(text(value, BAD_TITLE)?, BAD_TITLE)?),
    };
    let now = clearable(args, "now", BAD_NOW)?;
    if matches!(now, Some(Some(_))) && !live {
        return Err(ApiError::invalid_args(NOW_NOT_LIVE));
    }
    let update = Update {
        title,
        artist: clearable(args, "artist", BAD_ARTIST)?,
        album: clearable(args, "album", BAD_ALBUM)?,
        now,
        artwork: match args.get("artwork") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(value) => Some(Some(artwork(ctx, value)?)),
        },
        skip: match args.get("skip") {
            None => None,
            Some(Value::Null) => Some(Skip::default()),
            Some(value) => Some(skip(value)?),
        },
    };
    let empty = update.title.is_none()
        && update.artist.is_none()
        && update.album.is_none()
        && update.now.is_none()
        && update.artwork.is_none()
        && update.skip.is_none();
    if empty {
        return Err(ApiError::invalid_args(
            "Give at least one of 'title', 'artist', 'album', 'now', 'artwork' and 'skip'.",
        ));
    }
    Ok(update)
}

/// The caller's item number.
pub fn item(args: &Map<String, Value>) -> Result<i64, ApiError> {
    args.get("item")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::invalid_args("'item' must be an integer."))
}

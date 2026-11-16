/*
 * The pull feeder against the local test server: what each response does to the item, the reconnect
 * and resume rules on the hub's injected clock, and which end paths drop the connection.
 */

// -- Library Imports --
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

// -- Local Imports --
use super::art::ART_GAP;
use super::test_link::{pcm, Bench, A};
use super::{Gone, NowState, Producer};
use crate::audio::stream::{IDLE_MS, LIVE_PAUSE_HOLD_MS, NO_AUDIO_MS, RECONNECT_BACKOFF_MS};
use crate::audio::{PlayerCmd, StreamEndReason, StreamItem, StreamPhase, StreamSignal};
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::net::proxy::{Clock, TestClock};
use crate::plugins::api::net::state::LogKind;
use crate::plugins::api::net::test_server::{FILE_ETAG, FILE_LEN};
use crate::plugins::api::NetFixture;

/// How long a check waits for the feeder to act, and how long a test watches for nothing to happen.
pub(super) const SETTLE: Duration = Duration::from_millis(300);

pub(super) struct Pull {
    pub fx: NetFixture,
    pub bench: Bench,
    pub clock: Arc<TestClock>,
}

impl Pull {
    pub async fn new() -> Pull {
        let fx = NetFixture::new().await;
        Pull::at(fx, None)
    }

    /// A bench consenting to the fixture's origin, or to `origin`.
    pub fn at(fx: NetFixture, origin: Option<String>) -> Pull {
        let origin = origin.unwrap_or_else(|| fx.origin());
        let bench = Bench::pull(&origin, fx.engine());
        let clock = Arc::new(TestClock::new());
        bench.api().streams().set_clock(clock.clone());
        Pull { fx, bench, clock }
    }

    pub fn play(&self, url: &str, extra: Value) -> Result<(i64, StreamItem), ApiCode> {
        let mut args = json!({ "source": { "url": url }, "title": "Radio" });
        if let (Value::Object(args), Value::Object(extra)) = (&mut args, extra) {
            args.extend(extra);
        }
        let reply = self
            .bench
            .call(A, "stream.play", args)
            .map_err(|e| e.code)?;
        let item = reply["item"].as_i64().unwrap();
        let seat = self.bench.link.starts().pop().unwrap();
        Ok((item, seat))
    }

    pub fn ends(&self) -> Vec<(StreamEndReason, Option<&'static str>)> {
        let ends = self.bench.link.ends.lock().unwrap();
        ends.iter().map(|end| (end.reason, end.detail)).collect()
    }

    pub fn shown(&self) -> Option<NowState> {
        self.bench.api().streams().now().map(|now| now.state)
    }

    /// Takes the engine's signals and checks the limits at the hub clock's now.
    pub fn drain(&self) {
        self.bench.api().streams().drain(self.clock.now());
    }

    /// The facts the engine was sent, as live and seekable.
    pub fn facts(&self) -> Vec<(bool, bool)> {
        let sent = self.bench.link.sent.lock().unwrap();
        sent.iter()
            .filter_map(|cmd| match cmd {
                PlayerCmd::StreamFacts { live, seekable, .. } => Some((*live, *seekable)),
                _ => None,
            })
            .collect()
    }

    pub fn signal(&self, seat: &StreamItem, phase: StreamPhase) {
        seat.signals
            .send(StreamSignal::Phase(seat.id, phase))
            .unwrap();
        self.drain();
    }
}

/// Polls `check` for up to 10 s.
pub(super) async fn until(mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..500 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unlisted_origin_never_connects() {
    let p = Pull::new().await;
    let refused = p.play("https://other.example.com/radio", json!({})).err();
    assert_eq!(refused, Some(ApiCode::Denied));
    let art = json!({ "artwork": { "url": "https://other.example.com/a.png" } });
    assert_eq!(
        p.play(&p.fx.url("/radio"), art).err(),
        Some(ApiCode::Denied)
    );
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.fx.connections(), 0);
    assert!(p.bench.link.starts().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocked_address_ends_denied() {
    let fx = NetFixture::new().await;
    let host = "b.plisto-fixture.com";
    fx.answer(host, &[IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))]);
    let origin = format!("https://{host}:{}", fx.server().port);
    let p = Pull::at(fx, Some(origin.clone()));
    p.play(&format!("{origin}/radio"), json!({})).unwrap();
    let blocked = (StreamEndReason::Denied, Some("blocked_address"));
    assert!(until(|| p.ends() == [blocked]).await, "{:?}", p.ends());
    p.clock.advance(Duration::from_secs(60));
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.ends().len(), 1);
    assert_eq!(p.fx.connections(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_playlist_type_ends_unsupported_playlist() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/playlist"), json!({})).unwrap();
    let playlist = (StreamEndReason::Unsupported, Some("playlist"));
    assert!(until(|| p.ends() == [playlist]).await, "{:?}", p.ends());
    assert!(p.facts().is_empty(), "nothing decodes");
}

#[tokio::test(flavor = "multi_thread")]
async fn text_ends_unsupported_content_type() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/html"), json!({})).unwrap();
    let text = (StreamEndReason::Unsupported, Some("content_type"));
    assert!(until(|| p.ends() == [text]).await, "{:?}", p.ends());
}

#[tokio::test(flavor = "multi_thread")]
async fn icy_titles_update_now() {
    let p = Pull::new().await;
    p.play(
        &p.fx.url("/radio"),
        json!({ "source": { "url": p.fx.url("/radio"), "icy": true } }),
    )
    .unwrap();
    let titled = until(|| {
        let now = p.bench.api().streams().now().and_then(|now| now.now);
        now.is_some_and(|now| now.starts_with("Song "))
    })
    .await;
    assert!(titled);
    let head = &p.fx.server().heads()[0];
    assert_eq!(head.header("icy-metadata"), Some("1"));
    assert!(head.header("accept").unwrap().starts_with("audio/*"));
    assert_eq!(p.facts(), [(true, false)]);
    // Only audio reaches the decoder: the blocks are stripped.
    assert!(until(|| p.bench.link.media_read.load(Ordering::Acquire) > 0).await);
    let stash = p.bench.link.stash.lock().unwrap();
    assert!(stash.values().all(|t| t.title.starts_with("Song ")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_reconnects_with_backoff_then_ends_network() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/radio-drop?ms=150"), json!({})).unwrap();
    for (attempt, wait) in RECONNECT_BACKOFF_MS.iter().enumerate() {
        let reconnecting = until(|| {
            p.fx.connections() == attempt + 1 && p.shown() == Some(NowState::Reconnecting)
        })
        .await;
        assert!(reconnecting, "attempt {attempt}");
        // The backoff holds until the clock passes it.
        tokio::time::sleep(SETTLE).await;
        assert_eq!(p.fx.connections(), attempt + 1);
        p.clock.advance(Duration::from_millis(*wait));
    }
    let closed = (StreamEndReason::Network, Some("closed"));
    assert!(until(|| p.ends() == [closed]).await, "{:?}", p.ends());
    assert_eq!(p.fx.connections(), RECONNECT_BACKOFF_MS.len() + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn denied_is_never_retried() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/to/302/https://other.example.com/x"), json!({}))
        .unwrap();
    let denied = (StreamEndReason::Denied, Some("redirect_not_listed"));
    assert!(until(|| p.ends() == [denied]).await, "{:?}", p.ends());
    p.clock.advance(Duration::from_secs(60));
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.fx.connections(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_4xx_ends_with_status() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/status/404"), json!({})).unwrap();
    let status = (StreamEndReason::Network, Some("status"));
    assert!(until(|| p.ends() == [status]).await, "{:?}", p.ends());
    p.clock.advance(Duration::from_secs(60));
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.fx.connections(), 1);

    // A 5xx is retried.
    p.play(&p.fx.url("/status/503"), json!({})).unwrap();
    assert!(until(|| p.shown() == Some(NowState::Reconnecting)).await);
    p.clock
        .advance(Duration::from_millis(RECONNECT_BACKOFF_MS[0]));
    assert!(until(|| p.fx.connections() == 3).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn finite_resume_uses_range_and_if_range() {
    let p = Pull::new().await;
    let cut = 50_000;
    p.play(&p.fx.url(&format!("/file?drop={cut}")), json!({}))
        .unwrap();
    let read = || p.bench.link.media_read.load(Ordering::Acquire) as usize;
    assert!(until(|| read() == FILE_LEN).await, "read {}", read());
    assert_eq!(p.facts(), [(false, true)]);
    let heads = p.fx.server().heads();
    assert_eq!(heads.len(), 2);
    assert_eq!(heads[0].header("range"), None);
    assert_eq!(heads[1].header("range"), Some(&*format!("bytes={cut}-")));
    assert_eq!(heads[1].header("if-range"), Some(FILE_ETAG));
}

#[tokio::test(flavor = "multi_thread")]
async fn paused_live_closes_after_the_hold_and_reconnects_on_resume() {
    let p = Pull::new().await;
    let (_, seat) = p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| p.fx.server().streamed() > 0).await);
    p.signal(&seat, StreamPhase::Paused);
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.fx.server().cut_offs(), 0, "the hold keeps the connection");
    p.clock.advance(Duration::from_millis(LIVE_PAUSE_HOLD_MS));
    assert!(p.fx.server().saw_close(1).await);
    // A fresh epoch at once: the old decoding and ring end, and the engine gets an empty queue.
    let (pcm, control) = until_epoch(&p).await;
    assert!(seat.control.is_cancelled(), "the old epoch is ended");
    assert!(!control.is_cancelled());
    assert!(pcm.try_next().is_none(), "nothing from before the hold");
    let read_before = p.bench.link.media_read.load(Ordering::Acquire);
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.fx.connections(), 1, "no reconnect while paused");
    assert_eq!(p.shown(), Some(NowState::Paused));

    // Resumed, the engine waits for the new queue: reconnecting until it plays again.
    p.signal(&seat, StreamPhase::Buffering);
    assert_eq!(p.shown(), Some(NowState::Reconnecting));
    assert!(until(|| p.fx.connections() == 2).await);
    assert!(until(|| p.bench.link.media_decodes.load(Ordering::Acquire) == 2).await);
    assert!(until(|| p.bench.link.media_read.load(Ordering::Acquire) > read_before).await);
    assert_eq!(p.shown(), Some(NowState::Reconnecting));
    p.signal(&seat, StreamPhase::Playing);
    assert_eq!(p.shown(), Some(NowState::Playing));
    assert!(p.ends().is_empty());
}

/// Waits for the fresh-epoch command the hub sends the engine, and takes its queue and control.
pub(super) async fn until_epoch(
    p: &Pull,
) -> (
    crate::audio::stream::PcmReader,
    Arc<crate::audio::stream::StreamControl>,
) {
    let taken = || {
        let mut sent = p.bench.link.sent.lock().unwrap();
        let at = sent
            .iter()
            .position(|cmd| matches!(cmd, PlayerCmd::StreamEpoch { .. }))?;
        match sent.remove(at) {
            PlayerCmd::StreamEpoch { pcm, control, .. } => Some((pcm, control)),
            _ => None,
        }
    };
    for _ in 0..500 {
        if let Some(epoch) = taken() {
            return epoch;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no fresh epoch");
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_reconnects_live_and_ends_finite() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/silent"), json!({})).unwrap();
    assert!(until(|| p.facts().len() == 1).await);
    tokio::time::sleep(SETTLE).await;
    p.clock.advance(Duration::from_millis(IDLE_MS));
    assert!(until(|| p.shown() == Some(NowState::Reconnecting)).await);
    p.clock
        .advance(Duration::from_millis(RECONNECT_BACKOFF_MS[0]));
    assert!(until(|| p.fx.connections() == 2).await);
    assert!(p.ends().is_empty());

    p.play(&p.fx.url("/file?stall=1000"), json!({})).unwrap();
    assert!(until(|| p.facts().len() == 2).await);
    tokio::time::sleep(SETTLE).await;
    p.clock.advance(Duration::from_millis(IDLE_MS));
    let closed = (StreamEndReason::Network, Some("closed"));
    assert!(
        until(|| p.ends().last() == Some(&closed)).await,
        "{:?}",
        p.ends()
    );
    assert_eq!(p.fx.connections(), 3, "a finite item is not retried");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_audio_at_twenty_seconds() {
    // The 20 s run from the play's acceptance, on the hub's clock.
    let p = Pull::new().await;
    let accepted = p.clock.now();
    p.play(&p.fx.url("/silent"), json!({})).unwrap();
    assert!(until(|| p.facts().len() == 1).await);
    p.clock.advance(Duration::from_millis(NO_AUDIO_MS - 1));
    p.drain();
    assert!(p.ends().is_empty());
    assert_eq!(
        p.clock.now(),
        accepted + Duration::from_millis(NO_AUDIO_MS - 1)
    );
    p.clock.advance(Duration::from_millis(1));
    p.drain();
    assert_eq!(p.ends(), [(StreamEndReason::NoAudio, None)]);
    assert!(p.fx.server().saw_close(1).await, "the connection drops");
}

#[tokio::test(flavor = "multi_thread")]
async fn frame_events_do_not_end_a_playback_stream() {
    let p = Pull::new().await;
    let (item, _) = p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| p.fx.server().streamed() > 0).await);
    p.bench.api().net().frame_gone(A);
    p.bench
        .api()
        .streams()
        .forget(A, Gone::Off, Producer::Frame);
    let before = p.fx.server().streamed();
    tokio::time::sleep(SETTLE).await;
    assert!(p.fx.server().streamed() > before, "the body keeps coming");
    assert_eq!(p.fx.server().cut_offs(), 0);
    assert_eq!(p.bench.api().streams().now().unwrap().item, item);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disable_drops_the_connection_and_the_server_sees_close() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| p.fx.server().streamed() > 0).await);
    let withdrawn = p.bench.plugins.withdraw(A);
    p.bench.plugins.stop_because(A, Gone::Off);
    drop(withdrawn);
    assert_eq!(p.ends(), [(StreamEndReason::PluginGone, None)]);
    assert!(p.fx.server().saw_close(1).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_forget_keeps_the_connection() {
    let p = Pull::new().await;
    let (item, _) = p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| p.fx.server().streamed() > 0).await);
    p.bench.api().forget_run(A);
    p.bench.api().forget(A);
    let before = p.fx.server().streamed();
    tokio::time::sleep(SETTLE).await;
    assert!(p.fx.server().streamed() > before);
    assert_eq!(p.fx.server().cut_offs(), 0);
    assert_eq!(p.bench.api().streams().now().unwrap().item, item);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_log_writes_one_playback_entry_per_connection() {
    let p = Pull::new().await;
    let (item, _) = p.play(&p.fx.url("/radio-drop?ms=100"), json!({})).unwrap();
    assert!(until(|| p.shown() == Some(NowState::Reconnecting)).await);
    p.clock
        .advance(Duration::from_millis(RECONNECT_BACKOFF_MS[0]));
    assert!(until(|| p.fx.connections() == 2 && p.shown() != Some(NowState::Reconnecting)).await);
    p.bench
        .call(A, "stream.stop", json!({ "item": item }))
        .unwrap();
    let log = || p.bench.api().net().log(A);
    assert!(until(|| log().len() == 2).await, "{:?}", log());
    tokio::time::sleep(SETTLE).await;
    let log = log();
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|entry| entry.kind == LogKind::Playback));
    assert!(log.iter().all(|entry| entry.status == Some(200)));
    assert!(log[0].error.as_deref().unwrap().starts_with("network/"));
    // The stop cut the second body: that is no clean completion.
    assert_eq!(log[1].error.as_deref(), Some("aborted/stopped"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_during_the_connect_is_logged_and_ends_only_stopped() {
    let p = Pull::new().await;
    let (item, _) = p.play(&p.fx.url("/hang"), json!({})).unwrap();
    assert!(until(|| p.fx.connections() == 1).await);
    p.bench
        .call(A, "stream.stop", json!({ "item": item }))
        .unwrap();
    assert!(p.fx.server().saw_close(1).await);
    let log = || p.bench.api().net().log(A);
    assert!(until(|| log().len() == 1).await, "{:?}", log());
    assert_eq!(log()[0].error.as_deref(), Some("aborted/stopped"));
    assert_eq!(log()[0].status, None);
    assert_eq!(p.ends(), [(StreamEndReason::Stopped, None)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_head_is_not_logged_as_complete() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/playlist"), json!({})).unwrap();
    assert!(until(|| p.ends().len() == 1).await);
    p.play(&p.fx.url("/status/404"), json!({})).unwrap();
    assert!(until(|| p.ends().len() == 2).await);
    let log = || p.bench.api().net().log(A);
    assert!(until(|| log().len() == 2).await, "{:?}", log());
    let errors: Vec<_> = log().into_iter().map(|entry| entry.error).collect();
    assert_eq!(
        errors,
        [
            Some("aborted/stopped".into()),
            Some("network/status".into())
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn artwork_url_obeys_the_origin_list() {
    let p = Pull::new().await;
    let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": { "url": p.fx.url("/art.png") } });
    let item = p.bench.call(A, "stream.play", args).unwrap()["item"].clone();
    let hub = p.bench.api().streams();
    assert!(until(|| hub.now().is_some_and(|now| now.art_rev == 1)).await);

    // A hop off the list fetches nothing more and keeps the artwork shown.
    let away = p.fx.url("/to/302/https://other.example.com/a.png");
    let update = json!({ "item": item, "artwork": { "url": away } });
    p.bench.call(A, "stream.update", update).unwrap();
    p.clock.advance(ART_GAP + Duration::from_secs(1));
    p.drain();
    tokio::time::sleep(SETTLE * 2).await;
    assert_eq!(hub.now().unwrap().art_rev, 1);
    assert!(p
        .bench
        .link
        .stash
        .lock()
        .unwrap()
        .values()
        .all(|t| t.cover.is_some()));
    let heads = p.fx.server().heads();
    assert_eq!(heads.len(), 2);

    let unlisted = json!({ "item": item, "artwork": { "url": "https://other.example.com/a.png" } });
    let refused = p.bench.call(A, "stream.update", unlisted).unwrap_err();
    assert_eq!(refused.code, ApiCode::Denied);
}

/*
 * The playback feed: transport snapshots the engine sends to attached consumers, and the hub that owns
 * the engine's tap slot and the consumer list. Every snapshot takes a sequence number from one counter,
 * so a consumer that sees a gap knows it missed events. Each consumer has its own bounded channel and
 * the engine only ever `try_send`s, so a slow consumer loses events and never stalls playback. With no
 * consumer attached a call site costs one atomic load and builds nothing.
 *
 * The tap slot is active while at least one consumer reads the tap. Its region, a named mapping, is
 * created on the first such attach, on the attaching thread, and kept for the life of the process.
 */

// -- Library Imports --
use std::io;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use serde::Serialize;

// -- Local Imports --
use super::tap::TapSlot;
use super::tap_map::MappedRegion;

/// Events a consumer's channel holds before new ones are dropped.
pub const FEED_CAPACITY: usize = 64;
/// The output latency reported when the device period cannot be read.
pub const FALLBACK_LATENCY_MS: f64 = 10.0;

/// What moved the engine to send a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedCause {
    /// A track started cold: a play, a skip, a load or a restore. The tap opens a new epoch.
    Start,
    /// The next track took over gaplessly. The tap epoch carries on.
    Gapless,
    Pause,
    Resume,
    /// The play head moved. The tap opens a new epoch.
    Seek,
    Stop,
    Volume,
    /// The output device changed or was lost.
    Device,
    /// A consumer asked for the current state. Nothing changed and the tap epoch carries on.
    Snapshot,
    /// A stream is waiting for audio: seated and not started yet, or starved while playing.
    Buffering,
    /// A starved stream has enough audio again and plays on in the same epoch.
    Buffered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Playing,
    Paused,
    Stopped,
    /// A stream waits for audio. Nothing reaches the tap meanwhile.
    Buffering,
}

/// What is playing: a library or opened file, or a plugin stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedSource {
    Track,
    Stream,
}

/// The engine state a snapshot carries, read on the engine thread.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FeedState {
    pub transport: Transport,
    // The current source's native rate and channel count, 0 when stopped.
    pub sample_rate: u32,
    pub channels: u16,
    pub position_secs: f64,
    // The user's volume in 0..1. The tap is taken before it, so a consumer that mirrors the output
    // applies it itself.
    pub volume: f32,
    // The device the engine renders to, None when no device is open.
    pub device: Option<String>,
    // Its endpoint ID, the key a consumer matches devices on. None when it cannot be identified.
    pub device_id: Option<String>,
    // The device's default period in ms, the estimate of its output buffer.
    pub latency_ms: f64,
    pub source: FeedSource,
    // A stream with no end and no seek. False for a track.
    pub live: bool,
}

/// One snapshot as a consumer receives it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FeedEvent {
    // Starts at 1 and rises by one per snapshot across every consumer.
    pub seq: u64,
    pub cause: FeedCause,
    // The tap's latest epoch and its published write cursor when the snapshot was taken. What the
    // event changes reaches the ring at or after this cursor.
    pub tap_epoch: u32,
    pub tap_cursor: u64,
    #[serde(flatten)]
    pub state: FeedState,
}

/// One attached consumer's side of the feed. Detach it by `id` when done; a dropped receiver is
/// detached at the next snapshot.
pub struct FeedConsumer {
    pub id: u64,
    // The mapping name a reader opens, Some when the consumer reads the tap.
    pub tap_name: Option<String>,
    pub events: Receiver<FeedEvent>,
    // Snapshots lost because this consumer's channel was full.
    pub dropped: Arc<AtomicU64>,
}

struct Attached {
    id: u64,
    tx: Sender<FeedEvent>,
    tap: bool,
    dropped: Arc<AtomicU64>,
}

#[derive(Default)]
struct Consumers {
    list: Vec<Attached>,
    next_id: u64,
}

/// The engine's tap slot and its feed consumers. One per process; see `audio::feed_hub`.
pub struct FeedHub {
    slot: Arc<TapSlot>,
    // The consumer count, read before anything is built.
    attached: AtomicUsize,
    consumers: Mutex<Consumers>,
    // The mapping's name once created. Held while creating it; the engine never takes it.
    mapping: Mutex<Option<String>>,
    seq: AtomicU64,
    dropped: AtomicU64,
}

impl Default for FeedHub {
    fn default() -> Self {
        Self::new()
    }
}

impl FeedHub {
    /// A hub with an empty, inactive slot and no consumer.
    pub fn new() -> Self {
        Self {
            slot: Arc::new(TapSlot::empty()),
            attached: AtomicUsize::new(0),
            consumers: Mutex::new(Consumers::default()),
            mapping: Mutex::new(None),
            seq: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    pub(crate) fn slot(&self) -> &Arc<TapSlot> {
        &self.slot
    }

    /// Whether any consumer is attached. The engine checks this before building a snapshot.
    #[inline]
    pub fn wanted(&self) -> bool {
        self.attached.load(Ordering::Relaxed) > 0
    }

    /// Snapshots dropped on full channels, across every consumer.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Attaches a consumer. With `tap`, the tap mapping is created if it does not exist yet and the
    /// slot turns active; the playing source starts writing at its next packet, in a new epoch.
    pub fn attach(&self, tap: bool) -> io::Result<FeedConsumer> {
        let tap_name = if tap {
            Some(self.mapping_name()?)
        } else {
            None
        };
        let (tx, events) = bounded(FEED_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let mut c = self.lock();
        c.next_id += 1;
        let id = c.next_id;
        c.list.push(Attached {
            id,
            tx,
            tap,
            dropped: Arc::clone(&dropped),
        });
        self.sync(&c);
        Ok(FeedConsumer {
            id,
            tap_name,
            events,
            dropped,
        })
    }

    /// Detaches a consumer. When the last tap reader goes, the slot turns inactive and sources stop
    /// writing at their next packet; the mapping stays for the next attach.
    pub fn detach(&self, id: u64) {
        let mut c = self.lock();
        c.list.retain(|a| a.id != id);
        self.sync(&c);
    }

    /// Stamps a snapshot and offers it to every consumer without blocking. A full channel drops it
    /// and counts the drop; a disconnected one is detached.
    pub fn publish(&self, cause: FeedCause, state: FeedState) {
        let mut c = self.lock();
        if c.list.is_empty() {
            return;
        }
        let event = FeedEvent {
            seq: self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            cause,
            tap_epoch: self.slot.epoch(),
            tap_cursor: self.slot.write_cursor(),
            state,
        };
        let before = c.list.len();
        c.list.retain(|a| match a.tx.try_send(event.clone()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                a.dropped.fetch_add(1, Ordering::Relaxed);
                self.dropped.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Disconnected(_)) => false,
        });
        if c.list.len() != before {
            self.sync(&c);
        }
    }

    // The tap mapping's name, creating the mapping and installing it in the slot on first use.
    fn mapping_name(&self) -> io::Result<String> {
        let mut name = self.mapping.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(name) = name.as_ref() {
            return Ok(name.clone());
        }
        let region = MappedRegion::create()?;
        let created = region.name().to_owned();
        if self.slot.install(Box::new(region)).is_err() {
            return Err(io::Error::other("the tap slot already has a region"));
        }
        *name = Some(created.clone());
        Ok(created)
    }

    fn lock(&self) -> MutexGuard<'_, Consumers> {
        self.consumers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    // Brings the count and the slot's `active` in line with the list. Called under the list lock, so
    // concurrent attaches and detaches settle in order.
    fn sync(&self, c: &Consumers) {
        self.attached.store(c.list.len(), Ordering::Relaxed);
        self.slot.set_active(c.list.iter().any(|a| a.tap));
    }
}

/// The bound output device as a snapshot reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceReport {
    // The endpoint ID, None when the device cannot be identified.
    pub endpoint_id: Option<String>,
    // The device's default period in ms, FALLBACK_LATENCY_MS when it cannot be read.
    pub latency_ms: f64,
}

impl DeviceReport {
    fn unknown() -> Self {
        Self {
            endpoint_id: None,
            latency_ms: FALLBACK_LATENCY_MS,
        }
    }
}

/// Identifies the render endpoint named `name` and reads its default period. One active render
/// endpoint with that friendly name is the device. When several share it, the system default
/// among them is taken while the engine follows the default (`follows_default`), and otherwise the
/// device is reported unknown rather than guessed. Enumerates through COM, so it runs on the engine
/// thread, never on the audio callback.
pub fn device_report(name: Option<&str>, follows_default: bool) -> DeviceReport {
    name.and_then(|n| identify(n, follows_default))
        .map(|(id, period)| DeviceReport {
            endpoint_id: Some(id),
            latency_ms: period.unwrap_or(FALLBACK_LATENCY_MS),
        })
        .unwrap_or_else(DeviceReport::unknown)
}

// The endpoint ID and default period in ms of the device `device_report` describes.
#[cfg(windows)]
fn identify(name: &str, follows_default: bool) -> Option<(String, Option<f64>)> {
    use windows::core::{BSTR, GUID};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    // PKEY_Device_FriendlyName, the name cpal reports for a device.
    const FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };

    // SAFETY (both helpers): COM calls on a live device; the ID string is freed once after copying.
    unsafe fn friendly_name(device: &IMMDevice) -> windows::core::Result<String> {
        let value = device
            .OpenPropertyStore(STGM_READ)?
            .GetValue(&FRIENDLY_NAME)?;
        Ok(BSTR::try_from(&value)?.to_string())
    }
    unsafe fn endpoint_id(device: &IMMDevice) -> windows::core::Result<String> {
        let raw = device.GetId()?;
        let id = raw.to_string();
        CoTaskMemFree(Some(raw.0.cast_const().cast()));
        id.map_err(|_| windows::Win32::Foundation::E_FAIL.into())
    }

    // SAFETY: joins the apartment cpal uses for this thread; balanced below only when it succeeded.
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    // SAFETY: COM calls on interfaces this block owns; each result is checked.
    let found = unsafe {
        (|| -> windows::core::Result<Option<(String, Option<f64>)>> {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let endpoints = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            let mut named = Vec::new();
            for i in 0..endpoints.GetCount()? {
                let device = endpoints.Item(i)?;
                if friendly_name(&device).ok().as_deref() == Some(name) {
                    named.push(device);
                }
            }
            let device = if named.len() == 1 {
                named.pop()
            } else if follows_default && !named.is_empty() {
                let default = endpoint_id(&enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?)?;
                named
                    .into_iter()
                    .find(|d| endpoint_id(d).ok().as_deref() == Some(default.as_str()))
            } else {
                None
            };
            let Some(device) = device else {
                return Ok(None);
            };
            let id = endpoint_id(&device)?;
            let period = (|| -> windows::core::Result<i64> {
                let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
                let mut period = 0i64;
                client.GetDevicePeriod(Some(&mut period), None)?;
                Ok(period)
            })();
            // The period is in 100 ns units.
            let ms = period.ok().filter(|p| *p > 0).map(|p| p as f64 / 10_000.0);
            Ok(Some((id, ms)))
        })()
    };
    if init.is_ok() {
        // SAFETY: balances the successful CoInitializeEx above on the same thread.
        unsafe { CoUninitialize() };
    }
    found.ok().flatten()
}

#[cfg(not(windows))]
fn identify(_name: &str, _follows_default: bool) -> Option<(String, Option<f64>)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(transport: Transport) -> FeedState {
        FeedState {
            transport,
            sample_rate: 44_100,
            channels: 2,
            position_secs: 0.0,
            volume: 1.0,
            device: Some("Speakers".into()),
            device_id: Some("{0.0.0.00000000}.{speakers}".into()),
            latency_ms: FALLBACK_LATENCY_MS,
            source: FeedSource::Track,
            live: false,
        }
    }

    #[test]
    fn nothing_is_sent_with_no_consumer() {
        let hub = FeedHub::new();
        assert!(!hub.wanted());
        hub.publish(FeedCause::Start, state(Transport::Playing));
        let c = hub.attach(false).expect("attaches");
        assert!(hub.wanted());
        hub.publish(FeedCause::Pause, state(Transport::Paused));
        // The snapshot sent before the attach was never stamped.
        assert_eq!(c.events.try_recv().map(|e| e.seq), Ok(1));
        hub.detach(c.id);
        assert!(!hub.wanted());
    }

    #[test]
    fn a_full_channel_never_blocks_and_counts_drops() {
        let hub = FeedHub::new();
        let slow = hub.attach(false).expect("attaches");
        let fast = hub.attach(false).expect("attaches");
        let total = FEED_CAPACITY + 10;
        let mut fast_seen = Vec::new();
        for _ in 0..total {
            hub.publish(FeedCause::Volume, state(Transport::Playing));
            fast_seen.extend(fast.events.try_iter().map(|e| e.seq));
        }
        assert_eq!(slow.dropped.load(Ordering::Relaxed), 10);
        assert_eq!(fast.dropped.load(Ordering::Relaxed), 0);
        assert_eq!(hub.dropped(), 10);
        let slow_seen: Vec<u64> = slow.events.try_iter().map(|e| e.seq).collect();
        assert_eq!(slow_seen, (1..=FEED_CAPACITY as u64).collect::<Vec<_>>());
        assert_eq!(fast_seen, (1..=total as u64).collect::<Vec<_>>());
    }

    #[test]
    fn a_snapshot_with_no_consumer_sends_nothing() {
        let hub = FeedHub::new();
        hub.publish(FeedCause::Snapshot, state(Transport::Playing));
        let c = hub.attach(false).expect("attaches");
        hub.publish(FeedCause::Snapshot, state(Transport::Playing));
        let seqs: Vec<u64> = c.events.try_iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1]);
        hub.detach(c.id);
    }

    #[test]
    fn a_dropped_receiver_is_detached() {
        let hub = FeedHub::new();
        let c = hub.attach(false).expect("attaches");
        drop(c.events);
        hub.publish(FeedCause::Stop, state(Transport::Stopped));
        assert!(!hub.wanted());
    }

    #[test]
    fn sequence_numbers_rise_across_every_cause() {
        let hub = FeedHub::new();
        let c = hub.attach(false).expect("attaches");
        let causes = [
            FeedCause::Start,
            FeedCause::Pause,
            FeedCause::Resume,
            FeedCause::Seek,
            FeedCause::Volume,
            FeedCause::Gapless,
            FeedCause::Device,
            FeedCause::Snapshot,
            FeedCause::Stop,
        ];
        for cause in causes {
            hub.publish(cause, state(Transport::Playing));
        }
        let got: Vec<(u64, FeedCause)> = c.events.try_iter().map(|e| (e.seq, e.cause)).collect();
        let want: Vec<(u64, FeedCause)> = causes
            .iter()
            .enumerate()
            .map(|(i, c)| (i as u64 + 1, *c))
            .collect();
        assert_eq!(got, want);
    }

    #[test]
    fn an_unknown_device_is_reported_without_an_id() {
        assert_eq!(device_report(None, true), DeviceReport::unknown());
        assert_eq!(
            device_report(Some("no device has this name"), true),
            DeviceReport::unknown()
        );
        assert_eq!(DeviceReport::unknown().latency_ms, FALLBACK_LATENCY_MS);
    }

    #[test]
    fn the_default_device_is_identified_by_its_endpoint() {
        use rodio::cpal::traits::{DeviceTrait, HostTrait};
        // Machines without an output device have nothing to identify.
        let Some(name) = rodio::cpal::default_host()
            .default_output_device()
            .and_then(|d| d.name().ok())
        else {
            return;
        };
        let report = device_report(Some(&name), true);
        assert!(report.endpoint_id.is_some_and(|id| !id.is_empty()));
        assert!(report.latency_ms > 0.0);
    }

    #[test]
    fn a_snapshot_serializes_flat() {
        let event = FeedEvent {
            seq: 3,
            cause: FeedCause::Gapless,
            tap_epoch: 2,
            tap_cursor: 100,
            state: state(Transport::Playing),
        };
        let json = serde_json::to_value(&event).expect("serializes");
        assert_eq!(json["cause"], "gapless");
        assert_eq!(json["transport"], "playing");
        assert_eq!(json["tap_cursor"], 100);
        assert_eq!(json["latency_ms"], 10.0);
    }

    #[test]
    fn the_snapshot_cause_serializes_as_snapshot() {
        let json = serde_json::to_value(FeedCause::Snapshot).expect("serializes");
        assert_eq!(json, "snapshot");
    }

    #[test]
    fn a_stream_snapshot_serializes_its_source_live_and_buffering() {
        let event = FeedEvent {
            seq: 1,
            cause: FeedCause::Buffered,
            tap_epoch: 1,
            tap_cursor: 0,
            state: FeedState {
                transport: Transport::Buffering,
                source: FeedSource::Stream,
                live: true,
                ..state(Transport::Playing)
            },
        };
        let json = serde_json::to_value(&event).expect("serializes");
        assert_eq!(json["cause"], "buffered");
        assert_eq!(json["transport"], "buffering");
        assert_eq!(json["source"], "stream");
        assert_eq!(json["live"], true);
        assert_eq!(
            serde_json::to_value(FeedCause::Buffering).expect("serializes"),
            "buffering"
        );
    }
}

#[cfg(all(test, windows))]
mod tap_tests {
    use super::*;
    use crate::audio::source::tests::{bits, raw_samples, write_wav, TempDir};
    use crate::audio::tap::tests::{cursors, region, segment, segments, source, STEREO};

    fn state(
        transport: Transport,
        rate: u32,
        channels: u16,
        position_secs: f64,
        volume: f32,
    ) -> FeedState {
        FeedState {
            transport,
            sample_rate: rate,
            channels,
            position_secs,
            volume,
            device: Some("Speakers".into()),
            device_id: Some("{0.0.0.00000000}.{speakers}".into()),
            latency_ms: 10.0,
            source: FeedSource::Track,
            live: false,
        }
    }

    // The snapshot's cause, epoch and cursor.
    fn stamp(e: &FeedEvent) -> (FeedCause, u32, u64) {
        (e.cause, e.tap_epoch, e.tap_cursor)
    }

    #[test]
    fn attaching_mid_stream_starts_a_clean_epoch() {
        let dir = TempDir::new("feed_attach");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 20_000);
        let hub = FeedHub::new();
        let slot = Arc::clone(hub.slot());

        // A source plays with nothing attached: the slot has no region and nothing is written.
        let mut playing = source(&path, None, Some(slot.cold()));
        let before: Vec<f32> = playing.by_ref().take(5_000).collect();
        assert_eq!(before.len(), 5_000);
        assert!(slot.region().is_none());

        let reader = hub.attach(true).expect("attaches a tap reader");
        assert!(reader.tap_name.is_some());
        assert!(slot.is_active());
        let rest: Vec<f32> = playing.collect();
        let tap = crate::audio::tap::tests::tapped(&slot);
        // Writing begins at the first packet after the attach, on the source's own samples.
        assert!(!tap.is_empty());
        assert_eq!(bits(&tap), bits(&rest[rest.len() - tap.len()..]));
        let first = segments(&slot);
        assert_eq!(first, vec![segment(0, 1, STEREO)]);

        // Detach and attach again mid-stream: the writer resumes in a new epoch.
        hub.detach(reader.id);
        assert!(!slot.is_active());
        let mut again = source(&path, None, Some(slot.warm()));
        let _: Vec<f32> = again.by_ref().take(5_000).collect();
        let reader = hub.attach(true).expect("attaches again");
        let _: Vec<f32> = again.collect();
        let segs = segments(&slot);
        assert_eq!(segs.len(), 2);
        assert_ne!(segs[1].epoch, segs[0].epoch);
        assert_eq!(segs[1].start_cursor, tap.len() as u64);
        hub.detach(reader.id);
    }

    #[test]
    fn the_same_source_resumes_in_a_new_epoch_after_a_reattach() {
        let dir = TempDir::new("feed_reattach");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 40_000);
        let hub = FeedHub::new();
        let slot = Arc::clone(hub.slot());

        let reader = hub.attach(true).expect("attaches");
        let mut playing = source(&path, None, Some(slot.cold()));
        let _: Vec<f32> = playing.by_ref().take(10_000).collect();
        let before = slot.write_cursor();
        hub.detach(reader.id);
        // Detached, the source plays on and the ring stands still from its next packet.
        let _: Vec<f32> = playing.by_ref().take(20_000).collect();
        let stopped_at = slot.write_cursor();
        assert!(stopped_at >= before);
        let reader = hub.attach(true).expect("attaches again");
        let rest: Vec<f32> = playing.collect();
        let segs = segments(&slot);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].epoch, 1);
        assert_eq!(segs[1].epoch, 2);
        assert_eq!(segs[1].start_cursor, stopped_at);
        // The resumed run is the tail of what the source played after the re-attach.
        let mut resumed = vec![0.0; (slot.write_cursor() - stopped_at) as usize];
        let n = crate::audio::tap::TapReader::at(stopped_at, 0)
            .read(region(&slot), &mut resumed)
            .expect("keeps up");
        assert_eq!(n, resumed.len());
        assert_eq!(bits(&resumed), bits(&rest[rest.len() - n..]));
        hub.detach(reader.id);
    }

    #[test]
    fn detaching_the_last_reader_makes_the_slot_inactive() {
        let dir = TempDir::new("feed_detach");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 3_000);
        let hub = FeedHub::new();
        let slot = Arc::clone(hub.slot());

        let a = hub.attach(true).expect("attaches");
        let b = hub.attach(true).expect("attaches");
        let events_only = hub.attach(false).expect("attaches");
        assert_eq!(a.tap_name, b.tap_name);
        hub.detach(a.id);
        assert!(slot.is_active());
        hub.detach(b.id);
        assert!(!slot.is_active());
        assert!(hub.wanted());

        // The identity holds: the output is the file, and the ring is untouched.
        let out: Vec<f32> = source(&path, None, Some(slot.cold())).collect();
        assert_eq!(bits(&out), bits(&raw_samples(&path)));
        assert_eq!(cursors(&slot), (0, 0));
        assert!(region(&slot)
            .samples()
            .iter()
            .all(|s| s.load(Ordering::Relaxed) == 0));
        hub.detach(events_only.id);
    }

    #[test]
    fn a_snapshot_reports_the_current_state_and_opens_no_epoch() {
        let dir = TempDir::new("feed_snapshot");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 6_000);
        let hub = FeedHub::new();
        let slot = Arc::clone(hub.slot());
        let c = hub.attach(true).expect("attaches");

        let mut playing = source(&path, None, Some(slot.cold()));
        hub.publish(
            FeedCause::Start,
            state(Transport::Playing, 44_100, 2, 0.0, 1.0),
        );
        let _: Vec<f32> = playing.by_ref().take(2_000).collect();
        let (epoch, cursor) = (slot.epoch(), slot.write_cursor());
        hub.publish(
            FeedCause::Snapshot,
            state(Transport::Playing, 44_100, 2, 0.02, 1.0),
        );
        // The source plays on in the same epoch after the snapshot.
        let _: Vec<f32> = playing.collect();

        let events: Vec<FeedEvent> = c.events.try_iter().collect();
        assert_eq!(events.len(), 2);
        let snap = &events[1];
        assert_eq!(stamp(snap), (FeedCause::Snapshot, epoch, cursor));
        assert_eq!(snap.seq, events[0].seq + 1);
        assert_eq!(snap.state.transport, Transport::Playing);
        assert_eq!(snap.state.sample_rate, 44_100);
        assert_eq!(snap.state.position_secs, 0.02);
        assert_eq!(slot.epoch(), epoch);
        assert_eq!(segments(&slot), vec![segment(0, 1, STEREO)]);
        hub.detach(c.id);
    }

    // Drives the transitions the engine reports, in the order a session runs them, and checks what
    // each snapshot carries.
    #[test]
    fn snapshots_carry_each_transition() {
        let dir = TempDir::new("feed_transitions");
        let (a, b) = (dir.path.join("a.wav"), dir.path.join("b.wav"));
        write_wav(&a, 44_100, 2, 6_000);
        write_wav(&b, 44_100, 2, 4_000);
        let hub = FeedHub::new();
        let slot = Arc::clone(hub.slot());
        let c = hub.attach(true).expect("attaches");

        // Play: a cold source opens epoch 1 at the start of the ring.
        let mut playing = source(&a, None, Some(slot.cold()));
        hub.publish(
            FeedCause::Start,
            state(Transport::Playing, 44_100, 2, 0.0, 1.0),
        );
        let _: Vec<f32> = playing.by_ref().take(2_000).collect();
        let paused_at = slot.write_cursor();
        // Pause and resume keep the epoch and the cursor where the ring stopped.
        hub.publish(
            FeedCause::Pause,
            state(Transport::Paused, 44_100, 2, 0.01, 1.0),
        );
        hub.publish(
            FeedCause::Resume,
            state(Transport::Playing, 44_100, 2, 0.01, 1.0),
        );
        hub.publish(
            FeedCause::Volume,
            state(Transport::Playing, 44_100, 2, 0.01, 0.5),
        );
        // Seek: the cut source is replaced by a cold one in epoch 2.
        drop(playing);
        let cut = slot.write_cursor();
        let mut playing = source(&a, Some(0.05), Some(slot.cold()));
        hub.publish(
            FeedCause::Seek,
            state(Transport::Playing, 44_100, 2, 0.05, 0.5),
        );
        // Gapless: the next track queued warm continues epoch 2 at the boundary.
        let (input, output) = rodio::queue::queue::<f32>(false);
        let rest: Vec<f32> = playing.by_ref().collect();
        drop(playing);
        input.append(source(&b, None, Some(slot.warm())));
        let boundary = slot.write_cursor();
        hub.publish(
            FeedCause::Gapless,
            state(Transport::Playing, 44_100, 2, 0.0, 0.5),
        );
        let _: Vec<f32> = output.collect();
        let end = slot.write_cursor();
        hub.publish(
            FeedCause::Device,
            state(Transport::Playing, 44_100, 2, 0.09, 0.5),
        );
        hub.publish(FeedCause::Stop, state(Transport::Stopped, 0, 0, 0.0, 0.5));

        let events: Vec<FeedEvent> = c.events.try_iter().collect();
        let stamps: Vec<(FeedCause, u32, u64)> = events.iter().map(stamp).collect();
        assert_eq!(
            stamps,
            vec![
                (FeedCause::Start, 1, 0),
                (FeedCause::Pause, 1, paused_at),
                (FeedCause::Resume, 1, paused_at),
                (FeedCause::Volume, 1, paused_at),
                (FeedCause::Seek, 2, cut),
                (FeedCause::Gapless, 2, boundary),
                (FeedCause::Device, 2, end),
                (FeedCause::Stop, 2, end),
            ]
        );
        assert_eq!(boundary, cut + rest.len() as u64);
        assert_eq!(events[1].state.transport, Transport::Paused);
        assert_eq!(events[3].state.volume, 0.5);
        assert_eq!(events[4].state.position_secs, 0.05);
        assert_eq!(events[7].state.transport, Transport::Stopped);
        assert_eq!(events[7].state.sample_rate, 0);
        assert!(events.windows(2).all(|w| w[1].seq == w[0].seq + 1));
        assert_eq!(
            segments(&slot),
            vec![
                segment(0, 1, STEREO),
                segment(cut, 2, STEREO),
                segment(boundary, 2, STEREO)
            ]
        );
        hub.detach(c.id);
    }
}

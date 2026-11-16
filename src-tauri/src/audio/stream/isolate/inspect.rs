/*
 * Tags and covers of files the user opened, read in a decode helper so no byte of them is parsed in
 * this process. One helper answers every file of a staging burst in turn, in two steps per file: the
 * tags first, then the cover, each under its own CPU budget and wall-clock limit. A cover that fails
 * in any way costs only the cover. A tag step that runs out of time on main's own read drops the
 * file without blaming it: slow storage is not a hostile file. After two such files in a row the
 * rest of the burst is dropped untried. A tag step that runs out of time with no read outstanding,
 * or whose helper stops dead, is a failure of the helper, like a death.
 *
 * Only a helper that had answered nothing before can blame a file: a reused helper that fails on a
 * file may have been broken by an earlier one, so that file is tried once more in a fresh helper,
 * and is recorded as faulted only if that one fails too. A file a helper failed on is never read
 * in-process, recorded or not.
 *
 * The session (`file::session`) is shared with decoding: when no helper can be set up, the caller
 * reads opened files in-process for the same retry window. Only a launch that fails before any
 * file's bytes reached the helper counts as a setup failure, so no file can bring that about.
 */

// -- Library Imports --
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

// -- Local Imports --
use super::bridge::inspect::{InspectHelper, InspectLaunch, Served, StepError, StepLimits};
use super::file::{file_key, session, FileSession, FILE_OPEN_MS};
use super::wire::{check_edges, Inspected, HINT_MAX};
use crate::audio::stream::SPIN_CPU_MS;

// -- Module Declarations --
mod serve;

// -- Re-exports --
pub use super::wire::{InspectedCover, InspectedFile, Thumb};
pub(super) use serve::serve;
pub use serve::COVER_PIXELS_MAX;

/// The largest image beside a file that the helper is offered. It and its decode fit the file cap
/// together; a larger one leaves the file without that cover.
pub const ADJACENT_IMAGE_MAX: u64 = 256 << 20;

/// How long a tag step may take, main's own reads of the file included.
pub const TAG_WALL_MS: u64 = FILE_OPEN_MS;

/// The CPU a cover step may use: about four times what the largest cover admitted takes, a
/// 10,000 x 10,000 PNG or JPEG measured at 2.4 s in this build.
#[cfg(not(debug_assertions))]
pub const COVER_CPU_MS: u64 = 10_000;
/// `COVER_CPU_MS` in an unoptimized build, where the same JPEG takes 61 s: about three times that.
#[cfg(debug_assertions)]
pub const COVER_CPU_MS: u64 = 180_000;

/// How long a cover step may take, main's reads of an image beside the file included.
pub const COVER_WALL_MS: u64 = COVER_CPU_MS + FILE_OPEN_MS;

/// How long a helper may sit stopped dead in a step, with no read outstanding and the CPU of an
/// idle helper, before it is taken for hung.
pub const QUIET_MS: u64 = 5_000;

/// How many files in a row may time out on main's own read before the rest of the burst is
/// dropped untried: the storage behind them stopped answering.
const STORAGE_STALLS_MAX: u32 = 2;

/// What each step of a file may take.
#[derive(Clone, Copy, Debug)]
pub struct InspectLimits {
    pub tags: StepLimits,
    pub cover: StepLimits,
}

impl Default for InspectLimits {
    fn default() -> InspectLimits {
        let quiet = Duration::from_millis(QUIET_MS);
        InspectLimits {
            tags: StepLimits {
                cpu: Duration::from_millis(SPIN_CPU_MS),
                wall: Duration::from_millis(TAG_WALL_MS),
                quiet,
            },
            cover: StepLimits {
                cpu: Duration::from_millis(COVER_CPU_MS),
                wall: Duration::from_millis(COVER_WALL_MS),
                quiet,
            },
        }
    }
}

/// What became of one file's tag step.
#[derive(Debug)]
pub enum Inspection {
    Read(InspectedFile),
    /// The file does not open as audio.
    Unreadable,
    /// A fresh helper failed on this file, now or earlier in the session: drop it.
    Faulted,
    /// The storage did not serve the tags in time: drop the file, without blaming it.
    Slow,
    /// A helper that had answered other files failed on this one and no fresh helper could be had
    /// to try it again: drop it, without blaming it and without reading it in-process.
    Dropped,
    /// No helper can be set up here: read the file in-process.
    InProcess,
}

/// The inspecting helper of one staging burst, launched at the first file that needs it. Dropping
/// the burst ends its helper.
pub struct InspectBurst {
    session: Arc<FileSession>,
    edges: [u32; 2],
    helper: Option<InspectHelper>,
    // The file last read may ask for its cover.
    covering: bool,
    // Files in a row whose tag step timed out on main's own read.
    storage_stalls: u32,
    pub limits: InspectLimits,
    /// Files tried again in a fresh helper.
    #[cfg(test)]
    pub(crate) retries: usize,
    /// Added to each helper's command line.
    #[cfg(test)]
    pub(crate) args: &'static [&'static str],
    /// Makes every read of a served file wait until this channel's sender is dropped.
    #[cfg(test)]
    pub(crate) stall_reads: Option<crossbeam_channel::Receiver<()>>,
}

impl InspectBurst {
    /// A burst asking for thumbnails at `edges`, on this thread's session.
    pub fn new(edges: [u32; 2]) -> InspectBurst {
        debug_assert!(
            check_edges(edges).is_ok(),
            "{edges:?} do not fit one answer"
        );
        InspectBurst {
            session: session(),
            edges,
            helper: None,
            covering: false,
            storage_stalls: 0,
            limits: InspectLimits::default(),
            #[cfg(test)]
            retries: 0,
            #[cfg(test)]
            args: &[],
            #[cfg(test)]
            stall_reads: None,
        }
    }

    /// Reads `path`'s tags in the burst's helper.
    pub fn read_tags(&mut self, path: &Path) -> Inspection {
        self.covering = false;
        // The storage stopped answering for the files before this one.
        if self.storage_stalls >= STORAGE_STALLS_MAX {
            return Inspection::Slow;
        }
        let key = file_key(path);
        let hint = path
            .extension()
            .and_then(|e| e.to_str())
            .filter(|e| e.len() <= HINT_MAX)
            .map(str::to_ascii_lowercase);
        let limits = self.limits.tags;
        let mut retried = false;
        // A helper died or hung on this file in this call: it is never read in-process after.
        let mut struck = false;
        loop {
            let Some(audio) = self.open(path) else {
                return Inspection::Unreadable;
            };
            let Some(helper) = self.helper() else {
                return if self.session.is_faulted(&key) {
                    Inspection::Faulted
                } else if struck {
                    Inspection::Dropped
                } else {
                    Inspection::InProcess
                };
            };
            let reused = helper.answered();
            let answer = helper.read_tags(audio, hint.clone(), limits);
            self.storage_stalls = match answer {
                Err(StepError::TimedOut { storage: true }) => self.storage_stalls + 1,
                _ => 0,
            };
            match answer {
                Ok(Inspected::Read(file)) => {
                    self.covering = true;
                    return Inspection::Read(file);
                }
                Ok(Inspected::Unreadable) => return Inspection::Unreadable,
                Err(StepError::TimedOut { storage: true }) => {
                    self.helper = None;
                    return Inspection::Slow;
                }
                // A helper that stopped with no read outstanding failed like one that died.
                Err(StepError::TimedOut { storage: false } | StepError::Fault(_)) => {
                    self.helper = None;
                    struck = true;
                    if reused && !retried {
                        retried = true;
                        #[cfg(test)]
                        {
                            self.retries += 1;
                        }
                        continue;
                    }
                    self.session.mark_faulted(key);
                    return Inspection::Faulted;
                }
            }
        }
    }

    /// The cover of the file `read_tags` last read: its own picture, else `image` beside it. None
    /// when there is none that decodes, or the step failed in any way; a failure replaces the
    /// helper and blames nothing.
    pub fn cover(&mut self, image: Option<&Path>) -> Option<InspectedCover> {
        if !std::mem::take(&mut self.covering) {
            return None;
        }
        let image = image.and_then(|image| self.open(image)).and_then(offered);
        let (edges, limits) = (self.edges, self.limits.cover);
        // The picture lives in the helper that read the tags.
        let helper = self.helper.as_mut()?;
        match helper.cover(image, edges, limits) {
            Ok(cover) => cover,
            Err(_) => {
                self.helper = None;
                None
            }
        }
    }

    /// Ends the helper; the next file starts another.
    pub fn reset(&mut self) {
        self.helper = None;
        self.covering = false;
    }

    /// Whether the burst holds a helper that still runs.
    #[cfg(test)]
    pub(crate) fn helper_alive(&self) -> bool {
        self.helper.as_ref().is_some_and(InspectHelper::alive)
    }

    // The running helper, launched if there is none and the session allows one. A helper that ended
    // between files is replaced without blaming either.
    fn helper(&mut self) -> Option<&mut InspectHelper> {
        if self.helper.as_ref().is_some_and(|helper| !helper.alive()) {
            self.helper = None;
        }
        if self.helper.is_none() {
            if self.session.setup_down() {
                return None;
            }
            self.session.launching();
            match InspectHelper::launch(self.launch()) {
                Ok(helper) => self.helper = Some(helper),
                Err(e) => {
                    self.session.setup_failed(&e);
                    return None;
                }
            }
        }
        self.helper.as_mut()
    }

    fn launch(&self) -> InspectLaunch {
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering;
            let exe = self
                .session
                .fail_setup
                .load(Ordering::Acquire)
                .then(|| std::env::temp_dir().join("plisto-no-such-helper.exe"));
            InspectLaunch {
                args: self.args,
                exe,
            }
        }
        #[cfg(not(test))]
        InspectLaunch::default()
    }

    // The file at `path` opened to be served, with its length.
    fn open(&self, path: &Path) -> Option<Served> {
        let file = File::open(path).ok()?;
        let len = file.metadata().ok()?.len();
        #[cfg(test)]
        if let Some(stall) = &self.stall_reads {
            return Some(Served::new(tests::Stalled(stall.clone()), len));
        }
        Some(Served::new(file, len))
    }
}

// The image beside a file, when it is small enough to offer the helper.
fn offered(image: Served) -> Option<Served> {
    (image.byte_len() <= ADJACENT_IMAGE_MAX).then_some(image)
}

#[cfg(test)]
pub(crate) mod tests;

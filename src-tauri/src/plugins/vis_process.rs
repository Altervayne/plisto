/*
 * The rule that ends a plugin visualizer's renderer process when it spins out of sight. Pure: the
 * WebView2 lists, CPU readings and process handles come from `vis_process_win`.
 *
 * A process may be ended only when a fresh list shows a main frame on the app's own origin, so the
 * main document's process is known, and the process is not that one, holds no main frame, and
 * either serves frames that are all on a visualizer host or serves none and was listed earlier,
 * under the same creation time, serving visualizer frames only. It must also have held near one
 * core through a ten second run in which none of its plugin's visualizers was shown, and the front
 * end must have reported the shown visualizers at least once since the process was first tracked.
 * Until a report arrives, or after a rejected one, the shown set is unknown and nothing is ended.
 *
 * The watch tracks a renderer by an open handle, taken after the list that names it and confirmed
 * by a later one, so the pid it checks and the pid it acts on name one process.
 */

// -- Library Imports --
use std::time::Duration;

// -- Local Imports --
use super::frame_host::vis_host::parse_vis_url;

mod shown;
mod watch;

pub use shown::{shown_label, Interval, Shown};
pub use watch::{idle_after, Watch, IDLE_TICKS};

/// The share of one core a process holds through every interval of a busy run.
const NEAR_ONE_CORE: f64 = 0.9;
/// How long a busy run lasts before the process is ended.
pub const BUSY_FOR: Duration = Duration::from_secs(10);
// The origins the main window's own pages load from, in a dev run and in a built app.
const APP_ORIGINS: &[&str] = &["http://localhost:1420", "http://tauri.localhost"];

#[derive(Debug, Clone)]
pub struct Frame {
    pub source: String,
    pub main: bool,
}

/// One process as WebView2 lists it, with the frames it serves.
#[derive(Debug, Clone)]
pub struct Listed {
    pub pid: u32,
    pub renderer: bool,
    pub frames: Vec<Frame>,
}

impl Listed {
    /// A renderer serving at least one frame, every one of them a subframe on a visualizer host.
    pub fn vis_only(&self) -> bool {
        self.renderer
            && !self.frames.is_empty()
            && self
                .frames
                .iter()
                .all(|f| !f.main && parse_vis_url(&f.source).is_some())
    }

    /// Whether any frame it serves is on a visualizer host.
    pub fn serves_vis(&self) -> bool {
        self.frames.iter().any(|f| parse_vis_url(&f.source).is_some())
    }

    fn vis_labels(&self) -> impl Iterator<Item = String> + '_ {
        self.frames
            .iter()
            .filter_map(|f| parse_vis_url(&f.source).map(|(label, _)| label.to_string()))
    }
}

/// Why a process is not ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NoAppDocument,
    MainDocument,
    NotListed,
    NotRenderer,
    MainFrame,
    FramelessUnseen,
    OutsideVisHosts,
    NotTracked,
    NotConfirmed,
    ShownUnknown,
    NoReportSinceTracked,
    Shown,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::NoAppDocument => {
                "no main frame on the app origin is listed, so its process is unknown"
            }
            Refusal::MainDocument => "serves the main document",
            Refusal::NotListed => "not a WebView2 process",
            Refusal::NotRenderer => "not a renderer",
            Refusal::MainFrame => "serves a main frame",
            Refusal::FramelessUnseen => "frameless and never seen serving visualizer frames only",
            Refusal::OutsideVisHosts => "serves a frame outside the visualizer hosts",
            Refusal::NotTracked => "not tracked by the watch",
            Refusal::NotConfirmed => "not confirmed serving visualizer frames only",
            Refusal::ShownUnknown => "the shown visualizers are unknown",
            Refusal::NoReportSinceTracked => "no shown report has arrived since it was tracked",
            Refusal::Shown => "a visualizer of its plugin is shown",
        }
    }
}

// ---- Guard ----

/// Whether `pid`, whose open handle reports `created`, may be ended, judged on a fresh list.
/// `seen` holds `(pid, creation time)` of every process listed serving visualizer frames only.
pub fn end_allowed(
    list: &[Listed],
    seen: &[(u32, u64)],
    pid: u32,
    created: u64,
) -> Result<(), Refusal> {
    let documents = main_document_pids(list);
    if documents.is_empty() {
        return Err(Refusal::NoAppDocument);
    }
    if documents.contains(&pid) {
        return Err(Refusal::MainDocument);
    }
    let process = list
        .iter()
        .find(|p| p.pid == pid)
        .ok_or(Refusal::NotListed)?;
    if !process.renderer {
        return Err(Refusal::NotRenderer);
    }
    if process.frames.iter().any(|f| f.main) {
        return Err(Refusal::MainFrame);
    }
    if process.frames.is_empty() {
        return if seen.contains(&(pid, created)) {
            Ok(())
        } else {
            Err(Refusal::FramelessUnseen)
        };
    }
    if process.vis_only() {
        Ok(())
    } else {
        Err(Refusal::OutsideVisHosts)
    }
}

/// The pids of the processes listed as serving a main frame on the app's own origin.
fn main_document_pids(list: &[Listed]) -> Vec<u32> {
    list.iter()
        .filter(|p| {
            p.frames
                .iter()
                .any(|f| f.main && APP_ORIGINS.contains(&origin_of(&f.source)))
        })
        .map(|p| p.pid)
        .collect()
}

/// The `scheme://authority` prefix of an absolute URL, or the whole string when it has none.
fn origin_of(url: &str) -> &str {
    let Some(start) = url.find("://").map(|i| i + 3) else {
        return url;
    };
    let end = url[start..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |i| start + i);
    &url[..end]
}

// ---- Load ----

/// CPU time in 100 ns units, used over a wall interval, as a share of one core.
pub fn share_of_one_core(cpu_100ns: u64, wall: Duration) -> f64 {
    if wall.is_zero() {
        return 0.0;
    }
    cpu_100ns as f64 / (wall.as_nanos() as f64 / 100.0)
}

/// A busy run: the wall time over which a process held near one core with none of its plugin's
/// visualizers shown.
#[derive(Debug, Default)]
pub struct Load {
    busy: Duration,
}

impl Load {
    /// Adds one interval of `cpu` (100 ns units) over `wall`. An interval under the bar, or one in
    /// which a visualizer of the plugin may have been shown, restarts the run. True once the run
    /// reaches `BUSY_FOR`.
    pub fn observe(&mut self, cpu_100ns: u64, wall: Duration, shown: bool) -> bool {
        if wall.is_zero() {
            return false;
        }
        if shown || share_of_one_core(cpu_100ns, wall) < NEAR_ONE_CORE {
            self.busy = Duration::ZERO;
            return false;
        }
        self.busy += wall;
        self.busy >= BUSY_FOR
    }
}

#[cfg(test)]
mod tests;

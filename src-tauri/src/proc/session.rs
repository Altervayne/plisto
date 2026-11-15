/*
 * A helper's launches over one session: the container they share, and the isolation the first
 * launches settle on. A launch tries the less privileged container first. The plain container
 * stands in only when the less privileged one cannot run here: older Windows builds can lack the
 * ACLs it needs to load. A failure in the plain container, or once the session has settled, is the
 * caller's to report; nothing weaker stands behind it.
 *
 * The profile is set up at the first launch and only a success is kept, so a failed setup is tried
 * again by the next launch. A profile deleted under a running session, as an uninstall cancelled
 * after its pre-uninstall hook does, fails the next launch: the profile is then created again and
 * that launch retried once.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

// -- Local Imports --
use super::contained::Isolation;
use super::container::{AppContainer, SetupError, SetupStep};
use super::helper::HELPER_PROFILE;
use super::helper_launch::{await_ready, launch, prepare, Helper};

/// A helper that reached Ready, with its stdout after the Ready, or why it did not.
type Launched = Result<(Helper, File), SetupError>;

/// The decode helper's session.
pub static DECODE_HELPER: Session = Session::new(HELPER_PROFILE);

/// How one launch went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ready,
    /// The helper did not start, or ended before its Ready.
    Ended,
    /// The helper was still running when the wait for its Ready ran out.
    TimedOut,
}

/// What made a less privileged launch fall back to the plain container.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    Ended,
    TimedOut,
}

/// What a launch's outcome leads to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// Later launches use this isolation.
    Settle(Isolation),
    /// The helper is ready; the session stays as it is.
    Keep,
    /// Launch once more in the plain container. With `settle`, the session settles on it if it
    /// reaches Ready.
    RetryPlain { settle: bool, reason: Fallback },
    /// No retry.
    Fail,
}

/// The decision after a launch in `tried`. `settled` is the session's isolation, if any;
/// `timeouts` counts the earlier less privileged timeouts the plain container answered for;
/// `plain_settles` is the `settle` of the retry that led to a plain launch.
pub fn after_launch(
    tried: Isolation,
    outcome: Outcome,
    settled: Option<Isolation>,
    timeouts: u32,
    plain_settles: bool,
) -> Next {
    match (outcome, settled, tried) {
        (Outcome::Ready, Some(_), _) => Next::Keep,
        (Outcome::Ready, None, Isolation::LessPrivileged) => {
            Next::Settle(Isolation::LessPrivileged)
        }
        (Outcome::Ready, None, Isolation::Plain) if plain_settles => Next::Settle(Isolation::Plain),
        (Outcome::Ready, None, Isolation::Plain) => Next::Keep,
        (Outcome::Ended, None, Isolation::LessPrivileged) => Next::RetryPlain {
            settle: true,
            reason: Fallback::Ended,
        },
        // A single timeout can be a slow machine; a second one in the session is the container.
        (Outcome::TimedOut, None, Isolation::LessPrivileged) => Next::RetryPlain {
            settle: timeouts >= 1,
            reason: Fallback::TimedOut,
        },
        _ => Next::Fail,
    }
}

#[derive(Default)]
struct State {
    container: Option<Arc<AppContainer>>,
    settled: Option<Isolation>,
    timeouts: u32,
    warned: bool,
}

pub struct Session {
    profile: &'static str,
    state: Mutex<State>,
}

impl Session {
    pub const fn new(profile: &'static str) -> Session {
        Session {
            profile,
            state: Mutex::new(State {
                container: None,
                settled: None,
                timeouts: 0,
                warned: false,
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Every update leaves the state whole, so a panic while it was held leaves nothing to repair.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The session's container, with `exe` granted to it. Set up at the first call that succeeds.
    pub fn container(&self, exe: &Path) -> Result<Arc<AppContainer>, SetupError> {
        if let Some(container) = &self.state().container {
            return Ok(container.clone());
        }
        self.renew(exe)
    }

    /// Sets the container up again and keeps it for the session.
    fn renew(&self, exe: &Path) -> Result<Arc<AppContainer>, SetupError> {
        let container = Arc::new(prepare(self.profile, exe)?);
        self.state().container = Some(container.clone());
        Ok(container)
    }

    /// The isolation the session has settled on, if any.
    #[cfg(any(test, debug_assertions))]
    pub fn settled(&self) -> Option<Isolation> {
        self.state().settled
    }

    /// Starts `exe` with `args` as a helper and waits up to `ready_wait` for its Ready, returning
    /// the helper and its stdout after the Ready.
    pub fn launch(
        &self,
        exe: &Path,
        args: &[&OsStr],
        memory: usize,
        ready_wait: Duration,
    ) -> Launched {
        let (settled, timeouts) = {
            let state = self.state();
            (state.settled, state.timeouts)
        };
        let mut tried = settled.unwrap_or(Isolation::LessPrivileged);
        let mut plain_settles = false;
        let mut answered_timeout = false;
        loop {
            let (outcome, launched) = self.attempt(exe, tried, args, memory, ready_wait)?;
            match after_launch(tried, outcome, settled, timeouts, plain_settles) {
                Next::Settle(isolation) => {
                    let mut state = self.state();
                    state.settled.get_or_insert(isolation);
                    state.timeouts += u32::from(answered_timeout);
                    return launched;
                }
                Next::Keep => {
                    self.state().timeouts += u32::from(answered_timeout);
                    return launched;
                }
                Next::Fail => return launched,
                Next::RetryPlain { settle, reason } => {
                    self.warn_once(reason, &launched);
                    answered_timeout = reason == Fallback::TimedOut;
                    plain_settles = settle;
                    tried = Isolation::Plain;
                }
            }
        }
    }

    /// One launch and its wait for Ready. A setup failure is returned at once; a helper that did
    /// not reach Ready has had its job closed by the time this returns.
    fn attempt(
        &self,
        exe: &Path,
        isolation: Isolation,
        args: &[&OsStr],
        memory: usize,
        ready_wait: Duration,
    ) -> Result<(Outcome, Launched), SetupError> {
        let container = self.container(exe)?;
        let started = match launch(&container, isolation, exe, args, memory) {
            Ok(helper) => Ok(helper),
            // A deleted profile fails the launch: create it again and retry once.
            Err(_) => launch(&*self.renew(exe)?, isolation, exe, args, memory),
        };
        let mut helper = match started {
            Ok(helper) => helper,
            Err(e) => return Ok((Outcome::Ended, Err(e))),
        };
        let stdout = helper
            .process
            .stdout
            .take()
            .expect("a new helper has its stdout");
        match await_ready(stdout, ready_wait) {
            Ok(stdout) => Ok((Outcome::Ready, Ok((helper, stdout)))),
            Err(e) => {
                // A broken pipe means the helper ended; only a wait that ran out with the helper
                // still running is a timeout.
                let alive = matches!(helper.process.wait_timeout(Duration::ZERO), Ok(None));
                let outcome = if e.kind() == io::ErrorKind::TimedOut && alive {
                    Outcome::TimedOut
                } else {
                    Outcome::Ended
                };
                Ok((outcome, Err(SetupError::at(SetupStep::Launch)(e))))
            }
        }
    }

    fn warn_once(&self, reason: Fallback, launched: &Launched) {
        let mut state = self.state();
        if state.warned {
            return;
        }
        state.warned = true;
        let error = launched
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default();
        let case = match reason {
            Fallback::Ended => "the helper did not start or ended before its Ready",
            Fallback::TimedOut => "the helper sent no Ready in time",
        };
        eprintln!(
            "warn: decode isolation: in the less privileged container {case} ({error}); \
             retrying in the plain AppContainer"
        );
    }
}

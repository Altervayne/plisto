/*
 * The AppContainer profile a helper runs in. The profile has no capabilities: a process in it reaches
 * no network, and of the user's files and registry keys only those that grant the profile's own SID
 * or, unless it runs less privileged, every app package. The SID is derived from the profile name,
 * so it is the same on every launch.
 */

// -- Library Imports --
use std::fmt;
use std::io;
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{FreeSid, PSID};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

const DISPLAY_NAME: &str = "Plisto decoder";
const DESCRIPTION: &str = "Decodes audio for Plisto";
/// The mutex every Plisto process of the user holds across a profile call or a DACL edit: Windows
/// fails profile creations made at the same time, and a DACL edit reads, merges and writes.
const SETUP_MUTEX: &str = "Local\\Plisto.DecodeHelper.Setup";
/// How long a setup step waits for another process's step to finish.
const SETUP_WAIT: Duration = Duration::from_secs(10);
/// How often a wait for the setup mutex checks whether it was cancelled.
const SETUP_POLL_MS: u32 = 5;

/// Whether the work a setup step is for was cancelled. Checked while the step waits.
pub type Cancelled<'a> = &'a dyn Fn() -> bool;

/// For a setup step nothing cancels.
pub const NEVER: Cancelled<'static> = &|| false;

/// The setup mutex, held until dropped.
pub(super) struct SetupLock(HANDLE);

impl Drop for SetupLock {
    fn drop(&mut self) {
        // SAFETY: the mutex is owned by this thread, which took it in `setup_lock`, and the handle
        // is closed exactly once, here.
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

/// Takes the setup mutex, waiting at most `SETUP_WAIT`. A cancel ends the wait with `Interrupted`.
/// A mutex left by a process that died holding it is taken over.
pub(super) fn setup_lock(cancelled: Cancelled) -> io::Result<SetupLock> {
    // SAFETY: no attributes and a live, NUL-terminated name; the handle is closed below or by the
    // lock made from it.
    let handle = unsafe { CreateMutexW(None, false, &HSTRING::from(SETUP_MUTEX)) }?;
    let deadline = Instant::now() + SETUP_WAIT;
    let failed = loop {
        // SAFETY: the handle was just opened.
        match unsafe { WaitForSingleObject(handle, SETUP_POLL_MS) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => return Ok(SetupLock(handle)),
            WAIT_TIMEOUT if cancelled() => {
                break io::Error::new(io::ErrorKind::Interrupted, "the setup was cancelled")
            }
            WAIT_TIMEOUT if Instant::now() < deadline => {}
            WAIT_TIMEOUT => {
                break io::Error::new(
                    io::ErrorKind::TimedOut,
                    "another Plisto process holds the decode helper setup",
                )
            }
            _ => break io::Error::last_os_error(),
        }
    };
    // SAFETY: the handle is open and closed once.
    let _ = unsafe { CloseHandle(handle) };
    Err(failed)
}

/// The SID of an AppContainer profile that exists.
pub struct AppContainer(PSID);

// The SID is never written after Windows returns it, and FreeSid may run on any thread.
unsafe impl Send for AppContainer {}
unsafe impl Sync for AppContainer {}

impl AppContainer {
    /// Creates the profile with no capabilities, or derives the SID of the profile that already
    /// exists under `name`.
    pub fn open(name: &str, cancelled: Cancelled) -> io::Result<AppContainer> {
        let _setup = setup_lock(cancelled)?;
        let name = HSTRING::from(name);
        // SAFETY: every string is a live, NUL-terminated HSTRING and no capability array is passed; the
        // returned SID is owned by the AppContainer made from it.
        let created = unsafe {
            CreateAppContainerProfile(
                &name,
                &HSTRING::from(DISPLAY_NAME),
                &HSTRING::from(DESCRIPTION),
                None,
            )
        };
        match created {
            Ok(sid) => Ok(AppContainer(sid)),
            Err(e) if e.code() == ERROR_ALREADY_EXISTS.to_hresult() => {
                // SAFETY: as above; the derived SID is owned by the AppContainer made from it.
                unsafe { DeriveAppContainerSidFromAppContainerName(&name) }
                    .map(AppContainer)
                    .map_err(io::Error::from)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// The SID, valid while self lives.
    pub fn sid(&self) -> PSID {
        self.0
    }
}

impl Drop for AppContainer {
    fn drop(&mut self) {
        // SAFETY: the SID came from CreateAppContainerProfile or its Derive call, which hand it out to
        // be freed with FreeSid, and it is freed exactly once, here.
        unsafe { FreeSid(self.0) };
    }
}

/// Deletes the profile and the per-user storage Windows made for it.
pub fn delete(name: &str) -> io::Result<()> {
    let _setup = setup_lock(NEVER)?;
    // SAFETY: a live, NUL-terminated HSTRING.
    unsafe { DeleteAppContainerProfile(&HSTRING::from(name)) }.map_err(io::Error::from)
}

/// The part of the container setup that failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupStep {
    Profile,
    Access,
    Launch,
}

/// A container setup failure: the step and the Windows error. No weaker sandbox stands behind it.
#[derive(Debug)]
pub struct SetupError {
    pub step: SetupStep,
    pub error: io::Error,
}

impl SetupError {
    pub fn at(step: SetupStep) -> impl FnOnce(io::Error) -> SetupError {
        move |error| SetupError { step, error }
    }
}

impl fmt::Display for SetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let step = match self.step {
            SetupStep::Profile => "profile",
            SetupStep::Access => "folder access",
            SetupStep::Launch => "launch",
        };
        write!(f, "{step}: {}", self.error)
    }
}

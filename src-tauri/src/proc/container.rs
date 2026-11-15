/*
 * The AppContainer profile a helper runs in. The profile has no capabilities: a process in it reaches
 * no network, and of the user's files and registry keys only those that grant the profile's own SID
 * or, unless it runs less privileged, every app package. The SID is derived from the profile name,
 * so it is the same on every launch.
 */

// -- Library Imports --
use std::fmt;
use std::io;

use windows::core::HSTRING;
use windows::Win32::Foundation::ERROR_ALREADY_EXISTS;
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{FreeSid, PSID};

const DISPLAY_NAME: &str = "Plisto decoder";
const DESCRIPTION: &str = "Decodes audio for Plisto";

/// The SID of an AppContainer profile that exists.
pub struct AppContainer(PSID);

// The SID is never written after Windows returns it, and FreeSid may run on any thread.
unsafe impl Send for AppContainer {}
unsafe impl Sync for AppContainer {}

impl AppContainer {
    /// Creates the profile with no capabilities, or derives the SID of the profile that already
    /// exists under `name`.
    pub fn open(name: &str) -> io::Result<AppContainer> {
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

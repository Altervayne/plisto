/*
 * The one error the install commands return. `code` is stable and snake_case so the frontend can map
 * it to its own text; `detail` is a short English line for logs and devtools, never shown as is.
 */

// -- Library Imports --
use std::fmt;
use std::io;

use serde::Serialize;

// -- Local Imports --
use super::revalidate::CheckError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    TooLarge,
    TooManyFiles,
    UnsafePath,
    LinkNotAllowed,
    StreamNotAllowed,
    NameCollision,
    BadArchive,
    InvalidManifest,
    BadIcon,
    MissingFile,
    AlreadyInstalled,
    UnknownToken,
    RegistryUnavailable,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstallError {
    pub code: ErrorCode,
    pub detail: String,
}

impl InstallError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> InstallError {
        InstallError {
            code,
            detail: detail.into(),
        }
    }

    pub fn io(what: &str, e: io::Error) -> InstallError {
        InstallError::new(ErrorCode::Io, format!("{what}: {e}"))
    }
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for InstallError {}

impl From<CheckError> for InstallError {
    fn from(e: CheckError) -> Self {
        let code = match &e {
            CheckError::FolderMissing => ErrorCode::NotFound,
            CheckError::FolderNotPlain | CheckError::ManifestNotPlain => ErrorCode::LinkNotAllowed,
            CheckError::ManifestMissing | CheckError::MissingFile(_) => ErrorCode::MissingFile,
            CheckError::ManifestUnreadable(_) => ErrorCode::Io,
            CheckError::Manifest(_) | CheckError::WrongId => ErrorCode::InvalidManifest,
            CheckError::Icon(_) => ErrorCode::BadIcon,
        };
        InstallError::new(code, e.to_string())
    }
}

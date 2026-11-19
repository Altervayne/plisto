/*
 * The startup-read evidence command: the front end reports a read that failed, timed out, arrived late
 * or recovered, and it lands in `boot.log`. Async and off the database state, so it answers while the
 * index is busy and never blocks the main thread. A log I/O error is dropped, never returned.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::bootlog::BootLog;

const READS: [&str; 4] = ["roots", "tracks", "organization", "playlists"];
const OUTCOMES: [&str; 4] = ["failed", "timeout", "late", "recovered"];

/// Refuses a `read` or `outcome` outside the known sets.
fn validate(read: &str, outcome: &str) -> Result<(), String> {
    if !READS.contains(&read) {
        return Err(format!("unknown read: {read}"));
    }
    if !OUTCOMES.contains(&outcome) {
        return Err(format!("unknown outcome: {outcome}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn log_boot_read(
    log: State<'_, BootLog>,
    read: String,
    outcome: String,
    attempt: u32,
    elapsed_ms: u64,
    error: Option<String>,
) -> Result<(), String> {
    validate(&read, &outcome)?;
    log.log_read(
        &read,
        &outcome,
        attempt,
        elapsed_ms,
        error.as_deref().unwrap_or(""),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values_pass() {
        for read in READS {
            for outcome in OUTCOMES {
                assert!(validate(read, outcome).is_ok());
            }
        }
    }

    #[test]
    fn unknown_values_are_refused() {
        assert!(validate("library", "failed").is_err());
        assert!(validate("roots", "ok").is_err());
        assert!(validate("", "").is_err());
        assert!(validate("Roots", "failed").is_err());
    }
}

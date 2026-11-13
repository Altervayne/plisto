/*
 * What the scan records about a file or folder it could not read: the closed set of reasons, the
 * kinds of finding, and the classifier that maps an error to a reason. The classifier walks an
 * error's source chain looking for an `io::Error`, because lofty wraps the OS error inside its
 * parse error and the Display text of that wrapper names only the format. Windows raw OS codes are
 * checked first: they are what separates a locked or denied file from a corrupt one.
 */

// -- Library Imports --
use std::error::Error;
use std::io;

use lofty::error::FileParseError;

/// Longest `detail` stored, in characters.
const MAX_DETAIL_CHARS: usize = 300;

/// Where in the scan a finding arose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IssueKind {
    /// The file was indexed but its tags could not be parsed.
    Tags,
    /// The file's size and modified time could not be read.
    Stat,
    /// A directory could not be listed.
    Folder,
}

impl IssueKind {
    /// The kind stored under `name`, or None when it is not one of the three.
    pub fn parse(name: &str) -> Option<Self> {
        [IssueKind::Tags, IssueKind::Stat, IssueKind::Folder]
            .into_iter()
            .find(|k| k.as_str() == name)
    }

    /// The value stored in `scan_issues.kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::Tags => "tags",
            IssueKind::Stat => "stat",
            IssueKind::Folder => "folder",
        }
    }
}

/// Why a read failed, as a closed set the interface words in each language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Reason {
    AccessDenied,
    InUse,
    PathTooLong,
    CorruptOrUnsupported,
    DiskError,
    Other,
}

impl Reason {
    /// The reason stored under `name`, or None when it is not one of the closed set.
    pub fn parse(name: &str) -> Option<Self> {
        [
            Reason::AccessDenied,
            Reason::InUse,
            Reason::PathTooLong,
            Reason::CorruptOrUnsupported,
            Reason::DiskError,
            Reason::Other,
        ]
        .into_iter()
        .find(|r| r.as_str() == name)
    }

    /// The value stored in `scan_issues.reason`.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::AccessDenied => "access_denied",
            Reason::InUse => "in_use",
            Reason::PathTooLong => "path_too_long",
            Reason::CorruptOrUnsupported => "corrupt_or_unsupported",
            Reason::DiskError => "disk_error",
            Reason::Other => "other",
        }
    }
}

/// One finding of a pass, before it is written. `key` is the canonical path key, the row's identity;
/// `path` is the real-case path shown to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueDraft {
    pub path: String,
    pub key: String,
    pub root_id: i64,
    pub kind: IssueKind,
    pub reason: Reason,
    pub detail: String,
}

/// The reason for `err`, or None when it is not an issue: a missing file is left to reconcile, which
/// already flags a vanished file, so recording it would only race a delete.
pub fn classify(err: &(dyn Error + 'static)) -> Option<Reason> {
    let mut mapped = None;
    let mut not_found = false;
    let mut parse_error = false;
    let mut cur = Some(err);
    while let Some(e) = cur {
        if let Some(io) = e.downcast_ref::<io::Error>() {
            mapped = mapped.or_else(|| io_reason(io));
            not_found |= io.kind() == io::ErrorKind::NotFound;
        }
        parse_error |= e.is::<FileParseError>();
        cur = e.source();
    }
    // A raw code outranks the kind: Windows reports a dropped network path (53) as NotFound.
    match mapped {
        Some(reason) => Some(reason),
        None if not_found => None,
        None if parse_error => Some(Reason::CorruptOrUnsupported),
        None => Some(Reason::Other),
    }
}

/// The reason an `io::Error` alone names, if it names one.
fn io_reason(err: &io::Error) -> Option<Reason> {
    #[cfg(windows)]
    match err.raw_os_error() {
        Some(5) => return Some(Reason::AccessDenied),
        Some(32 | 33) => return Some(Reason::InUse),
        Some(206) => return Some(Reason::PathTooLong),
        Some(23 | 121 | 1117 | 1450 | 53 | 64) => return Some(Reason::DiskError),
        _ => {}
    }
    (err.kind() == io::ErrorKind::PermissionDenied).then_some(Reason::AccessDenied)
}

/// The text kept as `detail`: the error and each cause in its chain, joined, then sanitized.
pub fn describe(err: &(dyn Error + 'static)) -> String {
    let mut parts = Vec::new();
    let mut cur = Some(err);
    while let Some(e) = cur {
        parts.push(e.to_string());
        cur = e.source();
    }
    sanitize_detail(&parts.join(": "))
}

/// Flattens line breaks and other control characters to spaces and cuts the text to 300
/// characters, so a stored detail is one short line.
pub fn sanitize_detail(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c < ' ' || matches!(c, '\u{7F}' | '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .take(MAX_DETAIL_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(code: i32) -> Option<Reason> {
        classify(&io::Error::from_raw_os_error(code))
    }

    #[cfg(windows)]
    #[test]
    fn access_denied_is_code_5_or_the_permission_kind() {
        assert_eq!(os(5), Some(Reason::AccessDenied));
        let kind = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(classify(&kind), Some(Reason::AccessDenied));
    }

    #[cfg(windows)]
    #[test]
    fn a_sharing_or_lock_violation_is_in_use() {
        assert_eq!(os(32), Some(Reason::InUse));
        assert_eq!(os(33), Some(Reason::InUse));
    }

    #[cfg(windows)]
    #[test]
    fn code_206_is_path_too_long() {
        assert_eq!(os(206), Some(Reason::PathTooLong));
    }

    #[cfg(windows)]
    #[test]
    fn device_and_network_drops_are_disk_errors() {
        for code in [23, 121, 1117, 1450, 53, 64] {
            assert_eq!(os(code), Some(Reason::DiskError), "code {code}");
        }
    }

    #[test]
    fn an_unrecognised_io_error_is_other() {
        assert_eq!(classify(&io::Error::other("odd")), Some(Reason::Other));
    }

    #[test]
    fn a_missing_file_is_not_an_issue() {
        assert_eq!(classify(&io::Error::from(io::ErrorKind::NotFound)), None);
    }

    #[test]
    fn a_lofty_parse_error_with_no_os_cause_is_corrupt() {
        let dir = std::env::temp_dir().join(format!(
            "plisto_issues_corrupt_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("broken.mp3");
        std::fs::write(&file, b"this is not audio").unwrap();

        let err = crate::covers::read_with_art(&file)
            .err()
            .expect("must fail");
        assert_eq!(classify(&err), Some(Reason::CorruptOrUnsupported));
        assert!(
            describe(&err).starts_with("failed to parse"),
            "the detail leads with lofty's own message"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn an_os_cause_inside_a_parse_error_wins_over_corrupt() {
        let wrapped: FileParseError = io::Error::from_raw_os_error(5).into();
        assert_eq!(classify(&wrapped), Some(Reason::AccessDenied));
        let gone: FileParseError = io::Error::from(io::ErrorKind::NotFound).into();
        assert_eq!(classify(&gone), None);
    }

    #[test]
    fn detail_is_cut_at_300_chars_on_a_char_boundary() {
        let long = "e\u{301}".repeat(400);
        let cut = sanitize_detail(&long);
        assert_eq!(cut.chars().count(), 300);
        let multibyte = "\u{e9}".repeat(500);
        assert_eq!(sanitize_detail(&multibyte).chars().count(), 300);
        assert_eq!(sanitize_detail("short"), "short");
    }

    #[test]
    fn detail_flattens_control_characters_to_spaces() {
        assert_eq!(
            sanitize_detail("a\r\nb\tc\u{7F}d\u{2028}e\u{0}f"),
            "a  b c d e f"
        );
    }

    #[test]
    fn wire_names_are_stable() {
        let all = [
            (Reason::AccessDenied, "access_denied"),
            (Reason::InUse, "in_use"),
            (Reason::PathTooLong, "path_too_long"),
            (Reason::CorruptOrUnsupported, "corrupt_or_unsupported"),
            (Reason::DiskError, "disk_error"),
            (Reason::Other, "other"),
        ];
        for (reason, name) in all {
            assert_eq!(reason.as_str(), name);
            assert_eq!(Reason::parse(name), Some(reason));
        }
        assert_eq!(Reason::parse("nope"), None);
        assert_eq!(IssueKind::parse("folder"), Some(IssueKind::Folder));
        assert_eq!(IssueKind::parse(""), None);
        assert_eq!(IssueKind::Tags.as_str(), "tags");
        assert_eq!(IssueKind::Stat.as_str(), "stat");
        assert_eq!(IssueKind::Folder.as_str(), "folder");
    }
}

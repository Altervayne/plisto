/*
 * The names of a write's staging files beside the source: `.plisto-tmp-<op>-<name>` for the temp and
 * `.plisto-tmp-bak-<op>-<name>` for the kept original. The shared `.plisto-tmp-` prefix keeps both out
 * of the scan and the change watcher. The op id keeps two writes of one file, or a kept backup and a
 * later write, from ever sharing a name. An op id is lowercase hex, so it never reads as `bak`.
 */

// -- Library Imports --
use std::io;

use ring::rand::{SecureRandom, SystemRandom};

pub const OP_ID_LEN: usize = 16;
const PREFIX: &str = ".plisto-tmp-";
const BACKUP_TAG: &str = "bak-";
// NTFS caps one path component at 255 UTF-16 units.
const MAX_COMPONENT: usize = 255;

/// A staging file name read back into its op id and the source name it was made from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Staged<'a> {
    Temp { op: &'a str, name: &'a str },
    Backup { op: &'a str, name: &'a str },
}

/// A fresh random op id of `OP_ID_LEN` lowercase hex characters.
pub fn new_op_id() -> io::Result<String> {
    let mut bytes = [0u8; OP_ID_LEN / 2];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| io::Error::other("cannot draw an op id"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The temp beside the source file `name`.
pub fn temp_name(op: &str, name: &str) -> String {
    fit(format!("{PREFIX}{op}-"), name)
}

/// The kept original beside the source file `name`.
pub fn backup_name(op: &str, name: &str) -> String {
    fit(format!("{PREFIX}{BACKUP_TAG}{op}-"), name)
}

/// Reads a staging name back. None for any other name, an export's `.plisto-tmp-` temp included. A
/// name `fit` shortened comes back shortened, not as the source name, so callers map a staged file to
/// its source through the journal, never through this.
pub fn parse(file_name: &str) -> Option<Staged<'_>> {
    let rest = file_name.strip_prefix(PREFIX)?;
    let (backup, rest) = match rest.strip_prefix(BACKUP_TAG) {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let (op, name) = rest.split_once('-')?;
    let hex = op.len() == OP_ID_LEN && op.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex || name.is_empty() {
        return None;
    }
    Some(if backup {
        Staged::Backup { op, name }
    } else {
        Staged::Temp { op, name }
    })
}

/// `head` then `name`, the stem shortened when the whole would pass the component cap. The extension
/// stays, since a tag writer picks the format by it.
fn fit(head: String, name: &str) -> String {
    let budget = MAX_COMPONENT.saturating_sub(units(&head));
    if units(name) <= budget {
        return head + name;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let mut left = budget.saturating_sub(units(ext));
    let mut out = head;
    for c in stem.chars() {
        if c.len_utf16() > left {
            break;
        }
        left -= c.len_utf16();
        out.push(c);
    }
    out.push_str(ext);
    out
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scan::{run_scan, ScanRoot};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    const OP: &str = "0123456789abcdef";

    #[test]
    fn op_ids_are_hex_and_distinct() {
        let a = new_op_id().unwrap();
        let b = new_op_id().unwrap();
        assert_eq!(a.len(), OP_ID_LEN);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn names_round_trip() {
        let name = "01 - Intro - Live.opus";
        assert_eq!(
            temp_name(OP, name),
            ".plisto-tmp-0123456789abcdef-01 - Intro - Live.opus"
        );
        assert_eq!(
            backup_name(OP, name),
            ".plisto-tmp-bak-0123456789abcdef-01 - Intro - Live.opus"
        );
        assert_eq!(
            parse(&temp_name(OP, name)),
            Some(Staged::Temp { op: OP, name })
        );
        assert_eq!(
            parse(&backup_name(OP, name)),
            Some(Staged::Backup { op: OP, name })
        );
    }

    #[test]
    fn other_names_do_not_parse() {
        assert_eq!(parse("01 - Song.mp3"), None);
        // An export's staging temp carries no op id.
        assert_eq!(parse(".plisto-tmp-04 - Exported Title.flac"), None);
        assert_eq!(parse(".plisto-tmp-0123456789ABCDEF-a.flac"), None);
        assert_eq!(parse(".plisto-tmp-0123456789abcdef-"), None);
        assert_eq!(parse(".plisto-tmp-bak-0123456789abcde-a.flac"), None);
    }

    #[test]
    fn a_long_name_is_cut_in_the_stem_and_keeps_its_extension() {
        let name = format!("{}.flac", "e\u{301}".repeat(200));
        let backup = backup_name(OP, &name);
        assert_eq!(units(&backup), MAX_COMPONENT);
        assert!(backup.ends_with(".flac"));
        let Some(Staged::Backup { name: kept, .. }) = parse(&backup) else {
            panic!("{backup}");
        };
        assert!(name.starts_with(kept.trim_end_matches(".flac")));
    }

    #[test]
    fn the_scan_skips_both_names() {
        let base = std::env::temp_dir().join(format!("plisto_names_scan_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let music = base.join("music");
        fs::create_dir_all(&music).unwrap();
        let name = "01 - Song.mp3";
        fs::write(music.join(name), b"").unwrap();
        fs::write(music.join(temp_name(OP, name)), b"").unwrap();
        fs::write(music.join(backup_name(OP, name)), b"").unwrap();

        let db_path = base.join("plisto.sqlite");
        let id = {
            let conn = db::open_db(&db_path).unwrap();
            db::get_or_create_root(&conn, &music.to_string_lossy(), 1000)
                .unwrap()
                .0
        };
        let roots = [ScanRoot {
            id,
            path: music.clone(),
            units: None,
        }];
        let cancel = Arc::new(AtomicBool::new(false));
        let sum = run_scan(&roots, &db_path, &cancel, 1000, &HashMap::new(), |_| {}).unwrap();
        let _ = fs::remove_dir_all(&base);
        assert_eq!(sum.total, 1, "only the source is walked");
    }
}

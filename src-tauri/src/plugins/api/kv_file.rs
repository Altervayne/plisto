/*
 * The `kv.json` format behind `storage.*`: `{"version":1,"entries":{...}}` in compact JSON with keys in
 * byte order, so its length is a pure function of the entries and the quota can be checked before a
 * write. A file that is not a valid store is moved aside, never deleted; a file that cannot be read at
 * all is left where it is.
 */

// -- Library Imports --
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// -- Local Imports --
use super::storage::QUOTA_BYTES;
use crate::plugins::install::rename_with_retry;

pub type Kv = BTreeMap<String, Value>;

const VERSION: u32 = 1;

#[derive(Serialize)]
struct Out<'a> {
    version: u32,
    entries: &'a Kv,
}

#[derive(Deserialize)]
struct In {
    version: u32,
    entries: Kv,
}

#[derive(Debug, PartialEq, Eq)]
pub enum KvLoad {
    /// The file exists but is not a valid store.
    Corrupt,
    /// The file could not be read; its content is unknown.
    Unreadable,
}

/// The bytes of the file for `kv`.
pub fn encode(kv: &Kv) -> Vec<u8> {
    serde_json::to_vec(&Out {
        version: VERSION,
        entries: kv,
    })
    .unwrap_or_default()
}

/// Reads the store at `path`; `None` when there is no file. A file over the quota is corrupt, since
/// no write of ours produces one.
pub fn load(path: &Path) -> Result<Option<Kv>, KvLoad> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(KvLoad::Unreadable),
    };
    if meta.is_file() && meta.len() > QUOTA_BYTES as u64 {
        return Err(KvLoad::Corrupt);
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(KvLoad::Unreadable),
    };
    match serde_json::from_slice::<In>(&bytes) {
        Ok(file) if file.version == VERSION => Ok(Some(file.entries)),
        _ => Err(KvLoad::Corrupt),
    }
}

/// Moves the file at `path` over `bad`, replacing an older one.
pub fn quarantine(path: &Path, bad: &Path) -> io::Result<()> {
    rename_with_retry(path, bad)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::stage::Temp;
    use serde_json::json;

    #[test]
    fn the_encoding_is_compact_and_in_byte_order() {
        let mut kv = Kv::new();
        assert_eq!(encode(&kv), br#"{"version":1,"entries":{}}"#);
        kv.insert("b".into(), json!(1));
        kv.insert("B".into(), json!(null));
        kv.insert("\u{e9}".into(), json!({ "x": [true] }));
        assert_eq!(
            String::from_utf8(encode(&kv)).unwrap(),
            "{\"version\":1,\"entries\":{\"B\":null,\"b\":1,\"\u{e9}\":{\"x\":[true]}}}"
        );
    }

    #[test]
    fn a_store_round_trips_and_a_missing_file_is_none() {
        let t = Temp::new("api-kv");
        let path = t.0.join("kv.json");
        assert_eq!(load(&path), Ok(None));
        let mut kv = Kv::new();
        kv.insert("k".into(), json!("v"));
        fs::write(&path, encode(&kv)).unwrap();
        assert_eq!(load(&path), Ok(Some(kv)));
    }

    #[test]
    fn anything_that_is_not_a_version_one_store_is_corrupt() {
        let t = Temp::new("api-kv");
        let path = t.0.join("kv.json");
        for text in [
            "",
            "not json",
            "[]",
            "{}",
            r#"{"version":1}"#,
            r#"{"entries":{}}"#,
            r#"{"version":2,"entries":{}}"#,
            r#"{"version":1,"entries":[]}"#,
            r#"{"version":"1","entries":{}}"#,
        ] {
            fs::write(&path, text).unwrap();
            assert_eq!(load(&path), Err(KvLoad::Corrupt), "{text:?}");
        }
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert_eq!(load(&path), Err(KvLoad::Corrupt));
        fs::write(&path, vec![b' '; QUOTA_BYTES + 1]).unwrap();
        assert_eq!(load(&path), Err(KvLoad::Corrupt));
    }

    #[test]
    fn a_path_that_cannot_be_read_is_unreadable() {
        let t = Temp::new("api-kv");
        let path = t.0.join("kv.json");
        fs::create_dir_all(&path).unwrap();
        assert_eq!(load(&path), Err(KvLoad::Unreadable));
        assert!(path.is_dir());
    }

    #[test]
    fn quarantine_moves_the_file_and_replaces_an_older_one() {
        let t = Temp::new("api-kv");
        let path = t.0.join("kv.json");
        let bad = t.0.join("kv.json.bad");
        fs::write(&path, "first").unwrap();
        quarantine(&path, &bad).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(&bad).unwrap(), "first");
        fs::write(&path, "second").unwrap();
        quarantine(&path, &bad).unwrap();
        assert_eq!(fs::read_to_string(&bad).unwrap(), "second");
    }
}

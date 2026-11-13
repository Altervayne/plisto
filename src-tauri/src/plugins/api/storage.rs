/*
 * The `storage.*` methods: a plugin's small key-value store, kept in memory after the first call and
 * written through to `kv.json` in the plugin's own data folder. The file location comes only from the
 * admitted plugin id, never from an argument. Every call runs under the plugin's storage gate, which
 * is the one lock held across disk work; it re-checks the serving set once inside, so a call admitted
 * before a disable or uninstall cannot touch the file after `forget` has drained the gate. A write
 * that would take the file past the quota is refused before anything changes.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::{Arc, PoisonError};

use serde_json::{json, Map, Value};

// -- Local Imports --
use super::error::ApiError;
use super::files::{ensure_data_dir, write_atomic};
use super::kv_file::{encode, load, quarantine, Kv, KvLoad};
use super::log::host_line;
use super::rate::RateClass;
use super::state::PluginGates;
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::plugins::manifest::Capability;
use crate::plugins::paths::{kv_bad_file, kv_file};

pub const QUOTA_BYTES: usize = 1_048_576;
pub const MAX_KEY_BYTES: usize = 128;
pub const MAX_VALUE_BYTES: usize = 131_072;

const NEED: Need = Need::Cap(Capability::Storage);

pub(super) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "storage.get",
        need: NEED,
        class: RateClass::StorageRead,
        run: get,
    },
    MethodSpec {
        name: "storage.set",
        need: NEED,
        class: RateClass::StorageWrite,
        run: set,
    },
    MethodSpec {
        name: "storage.remove",
        need: NEED,
        class: RateClass::StorageWrite,
        run: remove,
    },
    MethodSpec {
        name: "storage.keys",
        need: NEED,
        class: RateClass::StorageRead,
        run: keys,
    },
    MethodSpec {
        name: "storage.clear",
        need: NEED,
        class: RateClass::StorageWrite,
        run: clear,
    },
    MethodSpec {
        name: "storage.usage",
        need: NEED,
        class: RateClass::StorageRead,
        run: usage,
    },
];

/// A plugin's entries and the byte length of the file that holds them (0 when there is none).
#[derive(Debug)]
struct Store {
    kv: Kv,
    usage: usize,
}

/// A plugin's cached storage. `forget` resets it to its default, which drops the cache.
#[derive(Debug, Default)]
pub struct StorageSlot {
    store: Option<Store>,
}

/// A key or prefix: at most `MAX_KEY_BYTES`, with no control character.
fn is_plain_text(text: &str) -> bool {
    text.len() <= MAX_KEY_BYTES && !text.chars().any(|c| c < ' ' || c == '\u{7F}')
}

fn key_arg(args: &Map<String, Value>) -> Result<String, ApiError> {
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_args("'key' must be a string."))?;
    if key.is_empty() || !is_plain_text(key) {
        return Err(ApiError::invalid_args(
            "'key' must be 1 to 128 bytes with no control characters.",
        ));
    }
    Ok(key.to_string())
}

/// Opens the plugin's store, quarantining a file that is not valid. A file that cannot be read is an
/// error and leaves the slot empty.
fn open(app_data: &Path, id: &str, gates: &PluginGates) -> Result<Store, ApiError> {
    let path = kv_file(app_data, id);
    match load(&path) {
        Ok(Some(kv)) => {
            let usage = encode(&kv).len();
            Ok(Store { kv, usage })
        }
        Ok(None) => Ok(Store {
            kv: Kv::new(),
            usage: 0,
        }),
        Err(KvLoad::Unreadable) => Err(ApiError::unavailable()),
        Err(KvLoad::Corrupt) => {
            quarantine(&path, &kv_bad_file(app_data, id)).map_err(|_| ApiError::unavailable())?;
            // Storage gate first, then the log gate, as `forget` takes them.
            let _log = gates.log.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = host_line(
                app_data,
                id,
                "storage file was not valid and was moved to kv.json.bad; storage reset",
            );
            Ok(Store {
                kv: Kv::new(),
                usage: 0,
            })
        }
    }
}

/// Runs `f` on the plugin's store under its storage gate.
fn with_store<R>(
    ctx: &CallCtx<'_>,
    f: impl FnOnce(&mut Store, &Path) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    let gates: Arc<PluginGates> = ctx.api.gates(ctx.id);
    let mut slot = gates.storage.lock().unwrap_or_else(PoisonError::into_inner);
    if !ctx.enabled.contains(ctx.id) {
        return Err(ApiError::unavailable());
    }
    ensure_data_dir(ctx.app_data, ctx.id).map_err(|_| ApiError::unavailable())?;
    if slot.store.is_none() {
        slot.store = Some(open(ctx.app_data, ctx.id, &gates)?);
    }
    let path = kv_file(ctx.app_data, ctx.id);
    match slot.store.as_mut() {
        Some(store) => f(store, &path),
        None => Err(ApiError::unavailable()),
    }
}

/// Writes the store as it now stands. Nothing reaches the disk or `store.usage` when the file would
/// pass the quota or the write fails; the caller restores its change.
fn persist(path: &Path, store: &mut Store) -> Result<(), ApiError> {
    let bytes = encode(&store.kv);
    if bytes.len() > QUOTA_BYTES {
        return Err(ApiError::too_large(
            "The storage quota of 1048576 bytes would be exceeded.",
        ));
    }
    write_atomic(path, &bytes).map_err(|_| ApiError::unavailable())?;
    store.usage = bytes.len();
    Ok(())
}

fn get(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(get_value(ctx, args))
}

fn get_value(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let key = key_arg(args)?;
    with_store(ctx, |store, _| {
        Ok(match store.kv.get(&key) {
            Some(value) => json!({ "found": true, "value": value }),
            None => json!({ "found": false, "value": null }),
        })
    })
}

fn set(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(set_value(ctx, args))
}

fn set_value(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let key = key_arg(args)?;
    let value = args
        .get("value")
        .ok_or_else(|| ApiError::invalid_args("'value' is required."))?
        .clone();
    let size = serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len());
    if size > MAX_VALUE_BYTES {
        return Err(ApiError::too_large("The value is over 131072 bytes."));
    }
    with_store(ctx, |store, path| {
        if store.kv.get(&key) == Some(&value) {
            return Ok(json!({ "usage": store.usage }));
        }
        let old = store.kv.insert(key.clone(), value);
        if let Err(e) = persist(path, store) {
            match old {
                Some(old) => store.kv.insert(key, old),
                None => store.kv.remove(&key),
            };
            return Err(e);
        }
        Ok(json!({ "usage": store.usage }))
    })
}

fn remove(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(remove_value(ctx, args))
}

fn remove_value(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let key = key_arg(args)?;
    with_store(ctx, |store, path| {
        let Some(old) = store.kv.remove(&key) else {
            return Ok(json!({ "removed": false, "usage": store.usage }));
        };
        if let Err(e) = persist(path, store) {
            store.kv.insert(key, old);
            return Err(e);
        }
        Ok(json!({ "removed": true, "usage": store.usage }))
    })
}

fn keys(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(list_keys(ctx, args))
}

fn list_keys(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let prefix = match args.get("prefix") {
        None => "",
        Some(Value::String(prefix)) if is_plain_text(prefix) => prefix,
        Some(_) => {
            return Err(ApiError::invalid_args(
                "'prefix' must be at most 128 bytes with no control characters.",
            ))
        }
    };
    with_store(ctx, |store, _| {
        // A `BTreeMap` of strings iterates in byte order.
        let keys: Vec<&String> = store.kv.keys().filter(|k| k.starts_with(prefix)).collect();
        Ok(json!({ "keys": keys }))
    })
}

fn clear(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    Outcome::Done(clear_all(ctx))
}

fn clear_all(ctx: &CallCtx<'_>) -> Result<Value, ApiError> {
    with_store(ctx, |store, path| {
        if store.kv.is_empty() {
            return Ok(json!({ "usage": store.usage }));
        }
        let old = std::mem::take(&mut store.kv);
        if let Err(e) = persist(path, store) {
            store.kv = old;
            return Err(e);
        }
        Ok(json!({ "usage": store.usage }))
    })
}

fn usage(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    Outcome::Done(with_store(ctx, |store, _| {
        Ok(json!({ "usage": store.usage, "quota": QUOTA_BYTES }))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::{admit, dispatch, run, FakeHost};
    use crate::plugins::manifest::Tier;
    use crate::plugins::paths::{data_dir, log_file};
    use crate::plugins::registry::{Entry, EntryState, Registry};
    use crate::plugins::revalidate::Problems;
    use crate::plugins::session::BootState;
    use crate::plugins::stage::Temp;
    use crate::plugins::state::PluginsState;
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    const ID: &str = "com.example.demo";
    const OTHER: &str = "com.example.other";

    /// Plugins serving over one app data folder, called through `dispatch` with a clock that moves
    /// a second per call so the rate buckets never get in the way.
    struct Rig {
        plugins: PluginsState,
        dir: PathBuf,
        host: FakeHost,
        t0: Instant,
        tick: Cell<u64>,
    }

    impl Rig {
        fn new(dir: &Path, ids: &[&str], granted: Vec<Capability>) -> Rig {
            let entries = ids
                .iter()
                .map(|id| Entry {
                    id: id.to_string(),
                    version: "1.0.0".into(),
                    tier: Tier::Ui,
                    enabled: true,
                    granted: granted.clone(),
                    installed_at: 1,
                    manifest_hash: "h".into(),
                    state: EntryState::Ready,
                    source_path: None,
                    sidebar_collapsed: false,
                    ready_enabled: None,
                })
                .collect();
            let registry = Registry {
                entries,
                ..Registry::default()
            };
            Rig {
                plugins: PluginsState::new(registry, Problems::new(), BootState::default()),
                dir: dir.to_path_buf(),
                host: FakeHost::default(),
                t0: Instant::now(),
                tick: Cell::new(0),
            }
        }

        fn granted(dir: &Path) -> Rig {
            Rig::new(dir, &[ID, OTHER], vec![Capability::Storage])
        }

        fn now(&self) -> Instant {
            self.tick.set(self.tick.get() + 1);
            self.t0 + Duration::from_secs(self.tick.get())
        }

        fn call_as(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError> {
            dispatch(
                &self.plugins.enabled_set(),
                self.plugins.api(),
                id,
                method,
                &args.to_string(),
                &self.dir,
                &self.host,
                self.now(),
            )
        }

        fn call(&self, method: &str, args: Value) -> Result<Value, ApiError> {
            self.call_as(ID, method, args)
        }

        fn set(&self, key: &str, value: Value) -> Result<Value, ApiError> {
            self.call("storage.set", json!({ "key": key, "value": value }))
        }

        fn get(&self, key: &str) -> Value {
            self.call("storage.get", json!({ "key": key })).unwrap()
        }

        fn usage(&self) -> u64 {
            self.call("storage.usage", json!({})).unwrap()["usage"]
                .as_u64()
                .unwrap()
        }

        fn file(&self) -> PathBuf {
            kv_file(&self.dir, ID)
        }
    }

    fn code(result: Result<Value, ApiError>) -> ApiCode {
        result.unwrap_err().code
    }

    #[test]
    fn every_method_works_on_the_happy_path() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        assert_eq!(rig.get("a"), json!({ "found": false, "value": null }));
        assert_eq!(
            rig.call("storage.usage", json!({})),
            Ok(json!({ "usage": 0, "quota": 1_048_576 }))
        );

        let set = rig.set("a", json!({ "n": [1, "x", null] })).unwrap();
        let file = fs::read(rig.file()).unwrap();
        assert_eq!(file, br#"{"version":1,"entries":{"a":{"n":[1,"x",null]}}}"#);
        assert_eq!(set, json!({ "usage": file.len() }));
        assert_eq!(
            rig.get("a"),
            json!({ "found": true, "value": { "n": [1, "x", null] } })
        );

        rig.set("b", json!("two")).unwrap();
        assert_eq!(
            rig.call("storage.keys", json!({})),
            Ok(json!({ "keys": ["a", "b"] }))
        );
        // Setting the same value again changes nothing.
        let before = rig.usage();
        assert_eq!(rig.set("b", json!("two")), Ok(json!({ "usage": before })));

        let removed = rig.call("storage.remove", json!({ "key": "a" })).unwrap();
        assert_eq!(removed["removed"], true);
        assert_eq!(removed["usage"], rig.usage());
        let missing = rig.call("storage.remove", json!({ "key": "a" })).unwrap();
        assert_eq!(missing["removed"], false);
        assert_eq!(rig.get("a")["found"], false);

        let cleared = rig.call("storage.clear", json!({})).unwrap();
        assert_eq!(
            fs::read(rig.file()).unwrap(),
            br#"{"version":1,"entries":{}}"#
        );
        assert_eq!(cleared, json!({ "usage": 26 }));
        assert_eq!(
            rig.call("storage.keys", json!({})),
            Ok(json!({ "keys": [] }))
        );
        // Clearing an empty store, or removing from one, writes nothing new.
        assert_eq!(rig.call("storage.clear", json!({})), Ok(cleared));
    }

    #[test]
    fn a_null_value_is_a_value_and_a_missing_one_is_refused() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        rig.set("n", Value::Null).unwrap();
        assert_eq!(rig.get("n"), json!({ "found": true, "value": null }));
        assert_eq!(
            code(rig.call("storage.set", json!({ "key": "m" }))),
            ApiCode::InvalidArgs
        );
        assert_eq!(rig.get("m")["found"], false);
    }

    #[test]
    fn keys_follow_the_key_rule() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        let two_byte_max = "\u{e9}".repeat(64);
        assert_eq!(two_byte_max.len(), MAX_KEY_BYTES);
        for ok in [
            "a",
            &"k".repeat(128),
            &two_byte_max,
            "../x",
            "a b",
            "\u{1F600}",
        ] {
            rig.set(ok, json!(1)).unwrap();
            assert_eq!(rig.get(ok)["found"], true, "{ok:?}");
        }
        let bad = [
            String::new(),
            "k".repeat(129),
            "\u{e9}".repeat(65),
            "a\nb".into(),
            "a\u{0}b".into(),
            "\u{1F}".into(),
            "a\u{7F}".into(),
        ];
        for key in bad {
            for method in ["storage.get", "storage.set", "storage.remove"] {
                let args = json!({ "key": key, "value": 1 });
                assert_eq!(
                    code(rig.call(method, args)),
                    ApiCode::InvalidArgs,
                    "{key:?}"
                );
            }
        }
        for args in [json!({}), json!({ "key": 5 }), json!({ "key": null })] {
            assert_eq!(code(rig.call("storage.get", args)), ApiCode::InvalidArgs);
        }
    }

    #[test]
    fn keys_are_listed_by_prefix_in_byte_order() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        for key in ["b", "a2", "a10", "A", "a", "\u{e9}", "ab"] {
            rig.set(key, json!(0)).unwrap();
        }
        let list = |args: Value| rig.call("storage.keys", args).unwrap()["keys"].clone();
        assert_eq!(
            list(json!({})),
            json!(["A", "a", "a10", "a2", "ab", "b", "\u{e9}"])
        );
        assert_eq!(list(json!({ "prefix": "" })), list(json!({})));
        assert_eq!(
            list(json!({ "prefix": "a" })),
            json!(["a", "a10", "a2", "ab"])
        );
        assert_eq!(list(json!({ "prefix": "a1" })), json!(["a10"]));
        assert_eq!(list(json!({ "prefix": "zz" })), json!([]));
        assert_eq!(list(json!({ "prefix": "k".repeat(128) })), json!([]));
        for prefix in [json!("k".repeat(129)), json!("a\nb"), json!(5), json!(null)] {
            assert_eq!(
                code(rig.call("storage.keys", json!({ "prefix": prefix }))),
                ApiCode::InvalidArgs
            );
        }
    }

    #[test]
    fn a_value_is_capped_at_131072_serialized_bytes() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        // The quotes count: 131,070 characters serialize to 131,072 bytes.
        assert!(rig.set("fits", json!("x".repeat(131_070))).is_ok());
        let before = fs::read(rig.file()).unwrap();
        assert_eq!(
            code(rig.set("over", json!("x".repeat(131_071)))),
            ApiCode::TooLarge
        );
        assert_eq!(rig.get("over")["found"], false);
        assert_eq!(fs::read(rig.file()).unwrap(), before);
    }

    #[test]
    fn the_quota_is_exact_and_a_refused_write_changes_nothing() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        for i in 0..8 {
            rig.set(&format!("k{i}"), json!("a".repeat(130_000)))
                .unwrap();
        }
        // Adding key "z" with an n-character string grows the file by n + 7 bytes.
        let n = QUOTA_BYTES - rig.usage() as usize - 7;
        assert!(n + 2 <= MAX_VALUE_BYTES);
        rig.set("z", json!("z".repeat(n))).unwrap();
        assert_eq!(rig.usage(), QUOTA_BYTES as u64);
        assert_eq!(fs::metadata(rig.file()).unwrap().len(), QUOTA_BYTES as u64);

        let before = fs::read(rig.file()).unwrap();
        assert_eq!(
            code(rig.set("z", json!("z".repeat(n + 1)))),
            ApiCode::TooLarge
        );
        assert_eq!(code(rig.set("y", json!(""))), ApiCode::TooLarge);
        assert_eq!(fs::read(rig.file()).unwrap(), before);
        assert_eq!(rig.usage(), QUOTA_BYTES as u64);
        assert_eq!(rig.get("z")["value"], json!("z".repeat(n)));
        assert_eq!(rig.get("y")["found"], false);
        let listed = rig.call("storage.keys", json!({})).unwrap();
        assert_eq!(listed["keys"].as_array().unwrap().len(), 9);

        // Replacing with something smaller, or removing, frees room.
        rig.set("z", json!("z")).unwrap();
        assert!(rig.usage() < QUOTA_BYTES as u64);
        assert!(rig.set("y", json!("fits now")).is_ok());
    }

    #[test]
    fn plugins_have_separate_files_and_no_argument_names_a_path() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        rig.set("shared", json!("mine")).unwrap();
        assert_eq!(rig.get("shared")["value"], "mine");
        let theirs = rig.call_as(OTHER, "storage.get", json!({ "key": "shared" }));
        assert_eq!(theirs, Ok(json!({ "found": false, "value": null })));
        rig.call_as(
            OTHER,
            "storage.set",
            json!({ "key": "shared", "value": "theirs", "id": ID, "path": "..", "plugin_id": ID }),
        )
        .unwrap();
        assert_eq!(rig.get("shared")["value"], "mine");
        assert_ne!(kv_file(&t.0, ID), kv_file(&t.0, OTHER));
        assert!(kv_file(&t.0, OTHER).is_file());
        // A key that looks like a path is only a key.
        rig.set("../../escape", json!(1)).unwrap();
        let mut names: Vec<String> = fs::read_dir(t.0.join("plugins-data"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [ID, OTHER]);
        assert!(!t.0.join("escape").exists());
    }

    #[test]
    fn storage_survives_a_fresh_api_state() {
        let t = Temp::new("api-storage");
        Rig::granted(&t.0).set("keep", json!([1, 2])).unwrap();
        let again = Rig::granted(&t.0);
        assert_eq!(again.get("keep"), json!({ "found": true, "value": [1, 2] }));
        assert_eq!(again.usage(), fs::metadata(again.file()).unwrap().len());
    }

    #[test]
    fn a_corrupt_file_is_quarantined_and_storage_starts_empty() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        fs::create_dir_all(data_dir(&t.0, ID)).unwrap();
        fs::write(rig.file(), "{ not a store").unwrap();
        assert_eq!(rig.get("a"), json!({ "found": false, "value": null }));
        assert!(!rig.file().exists());
        assert_eq!(
            fs::read_to_string(kv_bad_file(&t.0, ID)).unwrap(),
            "{ not a store"
        );
        let log = fs::read_to_string(log_file(&t.0, ID)).unwrap();
        assert_eq!(log.lines().count(), 1);
        assert!(log.contains(" HOST storage file was not valid"));
        // The store works again, and a second bad file replaces the first in the one slot.
        rig.set("a", json!(1)).unwrap();
        assert_eq!(rig.get("a")["found"], true);

        let second = Rig::granted(&t.0);
        fs::write(second.file(), r#"{"version":9,"entries":{}}"#).unwrap();
        assert_eq!(second.get("a")["found"], false);
        assert_eq!(
            fs::read_to_string(kv_bad_file(&t.0, ID)).unwrap(),
            r#"{"version":9,"entries":{}}"#
        );
    }

    #[test]
    fn an_unreadable_file_answers_unavailable_and_is_left_alone() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        // A folder where the file belongs cannot be read as a file.
        fs::create_dir_all(rig.file().join("inside")).unwrap();
        for _ in 0..2 {
            assert_eq!(code(rig.set("a", json!(1))), ApiCode::Unavailable);
            assert_eq!(
                code(rig.call("storage.get", json!({ "key": "a" }))),
                ApiCode::Unavailable
            );
        }
        assert!(rig.file().join("inside").is_dir());
        assert!(!kv_bad_file(&t.0, ID).exists());
        assert!(!log_file(&t.0, ID).exists());
        // Once it can be read, the plugin carries on.
        fs::remove_dir_all(rig.file()).unwrap();
        assert!(rig.set("a", json!(1)).is_ok());
    }

    #[test]
    fn a_call_admitted_before_forget_answers_unavailable_at_the_gate() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        rig.set("a", json!(1)).unwrap();
        let enabled = rig.plugins.enabled_set();
        let api = rig.plugins.api();
        let admitted = admit(&enabled, api, ID, "storage.get", 11, rig.now()).unwrap();
        // The plugin is uninstalled between admission and the gate.
        rig.plugins.withdraw(ID);
        api.forget(ID);
        let args = r#"{"key":"a"}"#;
        let late = run(&admitted, args, &t.0, &rig.host, api).unwrap_err();
        assert_eq!(late, ApiError::unavailable());
        drop(admitted);
        assert_eq!(
            code(rig.call("storage.get", json!({ "key": "a" }))),
            ApiCode::Unavailable
        );
        // The data stays on disk.
        assert!(rig.file().is_file());
    }

    #[test]
    fn forget_drops_the_cache_so_the_next_call_reads_the_file() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        rig.set("a", json!(1)).unwrap();
        assert_eq!(rig.get("a")["found"], true);
        fs::remove_file(rig.file()).unwrap();
        // Still answered from memory.
        assert_eq!(rig.get("a")["found"], true);
        rig.plugins.api().forget(ID);
        assert_eq!(rig.get("a")["found"], false);
        assert_eq!(rig.usage(), 0);
    }

    #[test]
    fn storage_needs_the_storage_grant() {
        let t = Temp::new("api-storage");
        let rig = Rig::new(&t.0, &[ID], Vec::new());
        for (method, args) in [
            ("storage.get", json!({ "key": "a" })),
            ("storage.set", json!({ "key": "a", "value": 1 })),
            ("storage.remove", json!({ "key": "a" })),
            ("storage.keys", json!({})),
            ("storage.clear", json!({})),
            ("storage.usage", json!({})),
        ] {
            assert_eq!(code(rig.call(method, args)), ApiCode::Denied, "{method}");
        }
        assert!(!data_dir(&t.0, ID).exists());
    }

    #[test]
    fn a_failed_write_leaves_the_old_file_and_the_cache() {
        let t = Temp::new("api-storage");
        let rig = Rig::granted(&t.0);
        rig.set("a", json!(1)).unwrap();
        let before = fs::read(rig.file()).unwrap();
        let usage = rig.usage();
        // A folder at the temp name makes every write fail before the rename.
        let temp = rig.file().with_file_name("kv.json.tmp");
        fs::create_dir_all(&temp).unwrap();
        assert_eq!(code(rig.set("b", json!(2))), ApiCode::Unavailable);
        assert_eq!(code(rig.set("a", json!(9))), ApiCode::Unavailable);
        assert_eq!(
            code(rig.call("storage.remove", json!({ "key": "a" }))),
            ApiCode::Unavailable
        );
        assert_eq!(
            code(rig.call("storage.clear", json!({}))),
            ApiCode::Unavailable
        );
        assert_eq!(fs::read(rig.file()).unwrap(), before);
        assert_eq!(rig.usage(), usage);
        assert_eq!(rig.get("a")["value"], 1);
        assert_eq!(rig.get("b")["found"], false);
        fs::remove_dir_all(&temp).unwrap();
        assert!(rig.set("b", json!(2)).is_ok());
    }

    #[test]
    fn the_storage_methods_are_in_the_table() {
        let names = crate::plugins::api::method_names();
        for name in [
            "storage.get",
            "storage.set",
            "storage.remove",
            "storage.keys",
            "storage.clear",
            "storage.usage",
        ] {
            assert!(names.contains(&name), "{name}");
        }
    }
}

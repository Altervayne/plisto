/*
 * The plugin API's memory per plugin: rate buckets, the count of calls in flight, the one open page
 * slot, open toasts and prompts with gesture tokens, chips and sidebar item state, and the gates that
 * serialize a plugin's own file work. The map locks are held only for in-memory work, never across
 * disk I/O; `forget` takes them one after the other. The one nesting is the sidebar store's lock, then
 * the serving set's (see `sidebar.rs`). A plugin's
 * gates are the one place a lock is held across disk work; they are kept for the life of the process,
 * so a call made after a re-enable never runs beside an older call under a different gate.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};

// -- Local Imports --
use super::error::ApiError;
use super::rate::{PluginBuckets, RateClass};
use super::sidebar::SidebarStore;
use super::storage::StorageSlot;
use super::ui_state::UiState;
use super::MAX_IN_FLIGHT;

/// Locks serializing one plugin's file work. Never taken under any other lock.
#[derive(Debug, Default)]
pub struct PluginGates {
    pub storage: Mutex<StorageSlot>,
    pub log: Mutex<()>,
}

#[derive(Default)]
struct Inner {
    buckets: HashMap<String, PluginBuckets>,
    // One counter per plugin and per `forget`: a guard from before a `forget` lowers only its own.
    in_flight: HashMap<String, Arc<AtomicU32>>,
    open_page: Option<String>,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    // Never shrinks: one entry per plugin ever called.
    gates: Mutex<HashMap<String, Arc<PluginGates>>>,
    ui: UiState,
    sidebar: SidebarStore,
    // The plugins' read-only library connection, opened on first use. Never taken under another lock.
    reader: Mutex<Option<Connection>>,
}

fn open_reader(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

/// Cheap to clone; every clone shares the same state.
#[derive(Clone, Default)]
pub struct ApiState(Arc<Shared>);

/// Holds one in-flight slot of a plugin; dropping it gives the slot back.
pub struct InFlight(Arc<AtomicU32>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ApiState {
    fn with_buckets<R>(
        &self,
        id: &str,
        now: Instant,
        f: impl FnOnce(&mut PluginBuckets) -> R,
    ) -> R {
        let mut inner = lock(&self.0.inner);
        let buckets = inner
            .buckets
            .entry(id.to_string())
            .or_insert_with(|| PluginBuckets::new(now));
        f(buckets)
    }

    /// Spends one token from the plugin's `all` bucket.
    pub fn take_all(&self, id: &str, now: Instant) -> Result<(), ApiError> {
        self.with_buckets(id, now, |b| b.take_all(now))
            .map_err(ApiError::rate_limited)
    }

    /// Spends one token from the plugin's bucket for `class`.
    pub fn take(&self, id: &str, class: RateClass, now: Instant) -> Result<(), ApiError> {
        self.with_buckets(id, now, |b| b.take(class, now))
            .map_err(ApiError::rate_limited)
    }

    /// Claims an in-flight slot, refused `busy` when the plugin already has `MAX_IN_FLIGHT`.
    pub fn enter(&self, id: &str) -> Result<InFlight, ApiError> {
        let mut inner = lock(&self.0.inner);
        let counter = inner.in_flight.entry(id.to_string()).or_default().clone();
        // Every claim takes the `inner` lock, so the check and the increment cannot interleave.
        if counter.load(Ordering::Acquire) >= MAX_IN_FLIGHT {
            return Err(ApiError::busy());
        }
        counter.fetch_add(1, Ordering::AcqRel);
        Ok(InFlight(counter))
    }

    /// The plugin's gates, created on first use.
    pub fn gates(&self, id: &str) -> Arc<PluginGates> {
        lock(&self.0.gates)
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Records that `id`'s page is shown, or that it no longer is. Closing a page that is not the
    /// recorded one changes nothing.
    pub fn set_page_open(&self, id: &str, open: bool) {
        let mut inner = lock(&self.0.inner);
        if open {
            inner.open_page = Some(id.to_string());
        } else if inner.open_page.as_deref() == Some(id) {
            inner.open_page = None;
        }
    }

    pub fn open_page(&self) -> Option<String> {
        lock(&self.0.inner).open_page.clone()
    }

    pub fn is_page_open(&self, id: &str) -> bool {
        lock(&self.0.inner).open_page.as_deref() == Some(id)
    }

    /// Open toasts and prompts, and gesture tokens.
    pub fn ui(&self) -> &UiState {
        &self.0.ui
    }

    /// Chips and sidebar item state.
    pub fn sidebar(&self) -> &SidebarStore {
        &self.0.sidebar
    }

    /// Runs `f` on a read-only connection to the database file at `path`, opened on first use and kept.
    /// Plugin reads use it so a long scan never holds the app's own connection. A connection that
    /// cannot be opened is `unavailable`, with no detail, and the next call tries again.
    pub fn with_reader<R>(
        &self,
        path: &Path,
        f: impl FnOnce(&Connection) -> Result<R, ApiError>,
    ) -> Result<R, ApiError> {
        let mut slot = lock(&self.0.reader);
        if slot.is_none() {
            *slot = Some(open_reader(path).map_err(|_| ApiError::unavailable())?);
        }
        match slot.as_ref() {
            Some(conn) => f(conn),
            None => Err(ApiError::unavailable()),
        }
    }

    /// Drops everything kept for `id` except its gates, and ends its open toasts and prompts. Waits
    /// for a storage call of `id` that is running to finish, so none outlives this.
    pub fn forget(&self, id: &str) {
        {
            let mut inner = lock(&self.0.inner);
            inner.buckets.remove(id);
            inner.in_flight.remove(id);
            if inner.open_page.as_deref() == Some(id) {
                inner.open_page = None;
            }
        }
        self.0.ui.release(id);
        self.0.ui.drop_gestures(id);
        self.0.sidebar.forget(id);
        let gates = lock(&self.0.gates).get(id).cloned();
        if let Some(gates) = gates {
            *lock(&gates.storage) = StorageSlot::default();
            drop(lock(&gates.log));
        }
    }

    #[cfg(test)]
    pub(super) fn in_flight(&self, id: &str) -> u32 {
        lock(&self.0.inner)
            .in_flight
            .get(id)
            .map_or(0, |count| count.load(Ordering::Acquire))
    }

    #[cfg(test)]
    pub(super) fn has_buckets(&self, id: &str) -> bool {
        lock(&self.0.inner).buckets.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "com.example.a";
    const B: &str = "com.example.b";

    #[test]
    fn the_seventeenth_call_in_flight_is_busy_until_one_ends() {
        let api = ApiState::default();
        let mut held: Vec<InFlight> = (0..16).map(|_| api.enter(A).unwrap()).collect();
        assert_eq!(api.in_flight(A), 16);
        assert_eq!(api.enter(A).err(), Some(ApiError::busy()));
        // Another plugin has its own count.
        assert!(api.enter(B).is_ok());
        held.pop();
        assert_eq!(api.in_flight(A), 15);
        held.push(api.enter(A).unwrap());
        drop(held);
        assert_eq!(api.in_flight(A), 0);
    }

    #[test]
    fn the_page_slot_holds_one_page() {
        let api = ApiState::default();
        assert_eq!(api.open_page(), None);
        api.set_page_open(A, true);
        assert!(api.is_page_open(A));
        // The next report overwrites the slot.
        api.set_page_open(B, true);
        assert_eq!(api.open_page().as_deref(), Some(B));
        assert!(!api.is_page_open(A));
        // Closing a page that is not recorded changes nothing.
        api.set_page_open(A, false);
        assert!(api.is_page_open(B));
        api.set_page_open(B, false);
        assert_eq!(api.open_page(), None);
    }

    #[test]
    fn forget_clears_buckets_in_flight_and_the_page_slot() {
        let api = ApiState::default();
        let now = Instant::now();
        for _ in 0..10 {
            api.take(A, RateClass::Ambient, now).unwrap();
        }
        assert!(api.take(A, RateClass::Ambient, now).is_err());
        let guard = api.enter(A).unwrap();
        api.set_page_open(A, true);
        api.take(B, RateClass::Ambient, now).unwrap();
        let gates = api.gates(A);

        api.forget(A);
        assert!(!api.has_buckets(A));
        assert_eq!(api.in_flight(A), 0);
        assert_eq!(api.open_page(), None);
        assert!(api.has_buckets(B));
        // A guard from before the forget does not underflow the new count.
        drop(guard);
        assert_eq!(api.in_flight(A), 0);
        assert_eq!(api.take(A, RateClass::Ambient, now), Ok(()));
        // The gates survive.
        assert!(Arc::ptr_eq(&gates, &api.gates(A)));
    }

    #[test]
    fn a_guard_from_before_a_forget_leaves_the_new_count_alone() {
        let api = ApiState::default();
        let old = api.enter(A).unwrap();
        api.forget(A);
        let _new = api.enter(A).unwrap();
        assert_eq!(api.in_flight(A), 1);
        drop(old);
        assert_eq!(api.in_flight(A), 1);
    }

    #[test]
    fn forget_leaves_another_plugins_open_page() {
        let api = ApiState::default();
        api.set_page_open(B, true);
        api.forget(A);
        assert!(api.is_page_open(B));
    }
}

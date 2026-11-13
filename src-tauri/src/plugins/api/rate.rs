/*
 * Per-plugin token buckets. Every call spends one token from the plugin's `all` bucket and one from
 * its method's class bucket. Tokens are counted in integer milli-tokens and refilled from the clock
 * the caller passes in, so the math is exact and testable without waiting.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

/// The rate class of a method: which bucket besides `all` it spends from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateClass {
    Ambient,
    StorageRead,
    StorageWrite,
    Log,
    Toast,
    Confirm,
    Chips,
    Sidebar,
    Nav,
    /// Clicks on a plugin's sidebar controls. Not a method, so it never spends from `all`.
    Input,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Limit {
    capacity: u64,
    // Milli-tokens per second, so a refill slower than one per second stays exact.
    milli_per_sec: u64,
}

const ALL: Limit = Limit {
    capacity: 100,
    milli_per_sec: 50_000,
};

impl RateClass {
    fn limit(self) -> Limit {
        let (capacity, milli_per_sec) = match self {
            RateClass::Ambient => (10, 2_000),
            RateClass::StorageRead => (60, 30_000),
            RateClass::StorageWrite => (20, 5_000),
            RateClass::Log => (40, 10_000),
            RateClass::Toast => (3, 100),
            RateClass::Confirm => (1, 100),
            RateClass::Chips => (10, 4_000),
            RateClass::Sidebar => (20, 10_000),
            RateClass::Nav => (3, 1_000),
            RateClass::Input => (5, 5_000),
        };
        Limit {
            capacity,
            milli_per_sec,
        }
    }
}

const MILLI: u64 = 1000;
const NANOS_PER_SEC: u128 = 1_000_000_000;

#[derive(Clone, Debug)]
pub struct Bucket {
    limit: Limit,
    milli: u64,
    // The instant the stored milli-tokens are counted up to. Advanced only by the time a refill
    // used, so no fraction of a milli-token is ever lost.
    last: Instant,
}

impl Bucket {
    fn full(limit: Limit, now: Instant) -> Bucket {
        Bucket {
            limit,
            milli: limit.capacity * MILLI,
            last: now,
        }
    }

    fn refill(&mut self, now: Instant) {
        let cap = self.limit.capacity * MILLI;
        let elapsed = now.saturating_duration_since(self.last).as_nanos();
        let rate = u128::from(self.limit.milli_per_sec);
        let earned = (elapsed * rate / NANOS_PER_SEC) as u64;
        if self.milli.saturating_add(earned) >= cap {
            self.milli = cap;
            self.last = now;
        } else {
            self.milli += earned;
            let used = u128::from(earned) * NANOS_PER_SEC / rate;
            self.last += Duration::from_nanos(used as u64);
        }
    }

    /// Milliseconds until the bucket holds one whole token; 0 when it does.
    fn wait_ms(&mut self, now: Instant) -> u64 {
        self.refill(now);
        let missing = u128::from(MILLI.saturating_sub(self.milli));
        let needed = (missing * NANOS_PER_SEC).div_ceil(u128::from(self.limit.milli_per_sec));
        // Time since `last` already counts towards the next milli-token.
        let progress = now.saturating_duration_since(self.last).as_nanos();
        needed.saturating_sub(progress).div_ceil(1_000_000) as u64
    }

    fn take(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.milli < MILLI {
            return false;
        }
        self.milli -= MILLI;
        true
    }
}

/// One plugin's buckets, shared by all its frames.
#[derive(Clone, Debug)]
pub struct PluginBuckets {
    all: Bucket,
    ambient: Bucket,
    storage_read: Bucket,
    storage_write: Bucket,
    log: Bucket,
    toast: Bucket,
    confirm: Bucket,
    chips: Bucket,
    sidebar: Bucket,
    nav: Bucket,
    input: Bucket,
}

impl PluginBuckets {
    /// Every bucket starts full.
    pub fn new(now: Instant) -> PluginBuckets {
        let full = |class: RateClass| Bucket::full(class.limit(), now);
        PluginBuckets {
            all: Bucket::full(ALL, now),
            ambient: full(RateClass::Ambient),
            storage_read: full(RateClass::StorageRead),
            storage_write: full(RateClass::StorageWrite),
            log: full(RateClass::Log),
            toast: full(RateClass::Toast),
            confirm: full(RateClass::Confirm),
            chips: full(RateClass::Chips),
            sidebar: full(RateClass::Sidebar),
            nav: full(RateClass::Nav),
            input: full(RateClass::Input),
        }
    }

    fn class(&mut self, class: RateClass) -> &mut Bucket {
        match class {
            RateClass::Ambient => &mut self.ambient,
            RateClass::StorageRead => &mut self.storage_read,
            RateClass::StorageWrite => &mut self.storage_write,
            RateClass::Log => &mut self.log,
            RateClass::Toast => &mut self.toast,
            RateClass::Confirm => &mut self.confirm,
            RateClass::Chips => &mut self.chips,
            RateClass::Sidebar => &mut self.sidebar,
            RateClass::Nav => &mut self.nav,
            RateClass::Input => &mut self.input,
        }
    }

    /// Spends one token from `all`, or returns the milliseconds until one is there.
    pub fn take_all(&mut self, now: Instant) -> Result<(), u64> {
        if self.all.take(now) {
            Ok(())
        } else {
            Err(self.all.wait_ms(now))
        }
    }

    /// Spends one token from the class bucket, or returns the milliseconds until both it and `all`
    /// hold a token again.
    pub fn take(&mut self, class: RateClass, now: Instant) -> Result<(), u64> {
        if self.class(class).take(now) {
            return Ok(());
        }
        let class_wait = self.class(class).wait_ms(now);
        Err(class_wait.max(self.all.wait_ms(now)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_full_bucket_bursts_to_capacity_then_refuses() {
        let t0 = Instant::now();
        let mut b = PluginBuckets::new(t0);
        for _ in 0..10 {
            assert_eq!(b.take(RateClass::Ambient, t0), Ok(()));
        }
        // 2 per second: the next token is 500 ms away.
        assert_eq!(b.take(RateClass::Ambient, t0), Err(500));
        assert_eq!(b.take(RateClass::Ambient, t0 + ms(499)), Err(1));
        assert_eq!(b.take(RateClass::Ambient, t0 + ms(500)), Ok(()));
        assert_eq!(b.take(RateClass::Ambient, t0 + ms(500)), Err(500));
    }

    #[test]
    fn refill_never_goes_above_capacity() {
        let t0 = Instant::now();
        let mut b = PluginBuckets::new(t0);
        for _ in 0..20 {
            b.take(RateClass::StorageWrite, t0).unwrap();
        }
        let later = t0 + Duration::from_secs(3600);
        for _ in 0..20 {
            assert_eq!(b.take(RateClass::StorageWrite, later), Ok(()));
        }
        assert_eq!(b.take(RateClass::StorageWrite, later), Err(200));
    }

    #[test]
    fn partial_refills_add_up_without_loss() {
        let t0 = Instant::now();
        let mut b = PluginBuckets::new(t0);
        for _ in 0..40 {
            b.take(RateClass::Log, t0).unwrap();
        }
        // 10 per second is one token per 100 ms; ten polls 10 ms apart earn exactly one.
        for step in 1..10 {
            assert!(b.take(RateClass::Log, t0 + ms(step * 10)).is_err());
        }
        assert_eq!(b.take(RateClass::Log, t0 + ms(100)), Ok(()));
        // A sub-millisecond step still counts towards the next token.
        assert_eq!(
            b.take(RateClass::Log, t0 + ms(199) + Duration::from_micros(999)),
            Err(1)
        );
        assert_eq!(b.take(RateClass::Log, t0 + ms(200)), Ok(()));
    }

    #[test]
    fn the_all_bucket_holds_100_and_refills_50_per_second() {
        let t0 = Instant::now();
        let mut b = PluginBuckets::new(t0);
        for _ in 0..100 {
            assert_eq!(b.take_all(t0), Ok(()));
        }
        assert_eq!(b.take_all(t0), Err(20));
        assert_eq!(b.take_all(t0 + ms(20)), Ok(()));
    }

    #[test]
    fn retry_after_is_the_wait_of_the_emptier_bucket() {
        let t0 = Instant::now();
        let mut b = PluginBuckets::new(t0);
        for _ in 0..100 {
            b.take_all(t0).unwrap();
        }
        for _ in 0..20 {
            b.take(RateClass::StorageWrite, t0).unwrap();
        }
        // StorageWrite waits 200 ms, all waits 20 ms.
        assert_eq!(b.take(RateClass::StorageWrite, t0), Err(200));
        // With the class bucket full, only `all` is empty, and `take` does not spend from it.
        assert_eq!(b.take(RateClass::StorageRead, t0), Ok(()));
    }

    #[test]
    fn a_slow_class_bursts_then_refills_one_per_ten_seconds() {
        let t0 = Instant::now();
        let mut b = PluginBuckets::new(t0);
        for _ in 0..3 {
            assert_eq!(b.take(RateClass::Toast, t0), Ok(()));
        }
        assert_eq!(b.take(RateClass::Toast, t0), Err(10_000));
        assert_eq!(b.take(RateClass::Toast, t0 + ms(9_999)), Err(1));
        assert_eq!(b.take(RateClass::Toast, t0 + ms(10_000)), Ok(()));
        assert_eq!(b.take(RateClass::Toast, t0 + ms(10_000)), Err(10_000));
        // Confirm holds one.
        assert_eq!(b.take(RateClass::Confirm, t0), Ok(()));
        assert_eq!(b.take(RateClass::Confirm, t0), Err(10_000));
    }

    #[test]
    fn the_new_classes_hold_their_capacity() {
        let t0 = Instant::now();
        for (class, capacity, wait) in [
            (RateClass::Chips, 10, 250),
            (RateClass::Sidebar, 20, 100),
            (RateClass::Nav, 3, 1_000),
            (RateClass::Input, 5, 200),
        ] {
            let mut b = PluginBuckets::new(t0);
            for _ in 0..capacity {
                assert_eq!(b.take(class, t0), Ok(()), "{class:?}");
            }
            assert_eq!(b.take(class, t0), Err(wait), "{class:?}");
        }
    }

    #[test]
    fn a_clock_that_goes_back_earns_nothing() {
        let t0 = Instant::now() + Duration::from_secs(10);
        let mut b = PluginBuckets::new(t0);
        for _ in 0..10 {
            b.take(RateClass::Ambient, t0).unwrap();
        }
        assert_eq!(b.take(RateClass::Ambient, t0 - ms(5000)), Err(500));
    }
}

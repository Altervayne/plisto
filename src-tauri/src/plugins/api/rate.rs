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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Limit {
    capacity: u64,
    per_sec: u64,
}

const ALL: Limit = Limit {
    capacity: 100,
    per_sec: 50,
};

impl RateClass {
    fn limit(self) -> Limit {
        let (capacity, per_sec) = match self {
            RateClass::Ambient => (10, 2),
            RateClass::StorageRead => (60, 30),
            RateClass::StorageWrite => (20, 5),
            RateClass::Log => (40, 10),
        };
        Limit { capacity, per_sec }
    }
}

const MILLI: u64 = 1000;

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
        // per_sec tokens per second is per_sec milli-tokens per millisecond.
        let earned = (elapsed * u128::from(self.limit.per_sec) / 1_000_000) as u64;
        if self.milli.saturating_add(earned) >= cap {
            self.milli = cap;
            self.last = now;
        } else {
            self.milli += earned;
            let used = u128::from(earned) * 1_000_000 / u128::from(self.limit.per_sec);
            self.last += Duration::from_nanos(used as u64);
        }
    }

    /// Milliseconds until the bucket holds one whole token; 0 when it does.
    fn wait_ms(&mut self, now: Instant) -> u64 {
        self.refill(now);
        MILLI
            .saturating_sub(self.milli)
            .div_ceil(self.limit.per_sec)
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
        }
    }

    fn class(&mut self, class: RateClass) -> &mut Bucket {
        match class {
            RateClass::Ambient => &mut self.ambient,
            RateClass::StorageRead => &mut self.storage_read,
            RateClass::StorageWrite => &mut self.storage_write,
            RateClass::Log => &mut self.log,
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
    fn a_clock_that_goes_back_earns_nothing() {
        let t0 = Instant::now() + Duration::from_secs(10);
        let mut b = PluginBuckets::new(t0);
        for _ in 0..10 {
            b.take(RateClass::Ambient, t0).unwrap();
        }
        assert_eq!(b.take(RateClass::Ambient, t0 - ms(5000)), Err(500));
    }
}

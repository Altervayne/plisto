/*
 * The ping rhythm and silence detection for one running child, pure and driven by the instants it is
 * given. A child is alive as long as valid pongs keep coming; silence only marks it as not responding,
 * once per silence, and a late pong brings it back. Nothing here ever ends a process.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

pub const PING_EVERY: Duration = Duration::from_secs(1);
/// How long without a valid pong before the child counts as not responding.
pub const SILENCE: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Beat {
    /// Send a ping with this sequence number.
    Ping(u64),
    /// The child just crossed the silence threshold.
    WentSilent,
    /// A valid pong ended a silence.
    Recovered,
    Nothing,
}

#[derive(Debug)]
pub struct Heartbeat {
    last_ping_seq: u64,
    last_pong_seq: u64,
    last_alive: Instant,
    next_ping: Instant,
    hung: bool,
}

impl Heartbeat {
    /// Starts at `ready`: the child counts as alive at `now`, and the first ping is due a period later.
    pub fn start(now: Instant) -> Heartbeat {
        Heartbeat {
            last_ping_seq: 0,
            last_pong_seq: 0,
            last_alive: now,
            next_ping: now + PING_EVERY,
            hung: false,
        }
    }

    /// What is due at `now`: a ping once a period, and `WentSilent` once when silence passes the threshold.
    pub fn tick(&mut self, now: Instant) -> Vec<Beat> {
        let mut beats = Vec::new();
        if now >= self.next_ping {
            self.last_ping_seq += 1;
            self.next_ping = now + PING_EVERY;
            beats.push(Beat::Ping(self.last_ping_seq));
        }
        if !self.hung && now.saturating_duration_since(self.last_alive) >= SILENCE {
            self.hung = true;
            beats.push(Beat::WentSilent);
        }
        beats
    }

    /// Takes a pong. A seq not after the last pong, or never pinged, is a protocol error.
    pub fn pong(&mut self, seq: u64, now: Instant) -> Result<Beat, ()> {
        if seq <= self.last_pong_seq || seq > self.last_ping_seq {
            return Err(());
        }
        self.last_pong_seq = seq;
        self.last_alive = now;
        if self.hung {
            self.hung = false;
            return Ok(Beat::Recovered);
        }
        Ok(Beat::Nothing)
    }

    pub fn is_hung(&self) -> bool {
        self.hung
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_ping_goes_out_every_second() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::start(t0);
        let mut pings = Vec::new();
        // Ticks every 250 ms over 4 s, answering each ping at once.
        for step in 1..=16 {
            let now = t0 + ms(250 * step);
            for beat in hb.tick(now) {
                if let Beat::Ping(seq) = beat {
                    pings.push((seq, step * 250));
                    assert_eq!(hb.pong(seq, now), Ok(Beat::Nothing));
                }
            }
        }
        assert_eq!(pings, [(1, 1000), (2, 2000), (3, 3000), (4, 4000)]);
        assert!(!hb.is_hung());
    }

    #[test]
    fn silence_fires_once_at_three_seconds_and_a_late_pong_recovers_without_refiring() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::start(t0);
        assert_eq!(hb.tick(t0 + ms(1000)), [Beat::Ping(1)]);
        assert_eq!(hb.tick(t0 + ms(2000)), [Beat::Ping(2)]);
        assert!(hb.tick(t0 + ms(2999)).is_empty());
        assert_eq!(hb.tick(t0 + ms(3000)), [Beat::Ping(3), Beat::WentSilent]);
        assert_eq!(hb.tick(t0 + ms(4000)), [Beat::Ping(4)]);
        assert!(hb.is_hung());
        // A late answer to an old ping still counts.
        assert_eq!(hb.pong(2, t0 + ms(4100)), Ok(Beat::Recovered));
        assert!(!hb.is_hung());
        assert_eq!(hb.pong(4, t0 + ms(4200)), Ok(Beat::Nothing));
        assert_eq!(hb.tick(t0 + ms(5200)), [Beat::Ping(5)]);
        // Silent again: fires again, once.
        assert_eq!(hb.tick(t0 + ms(7200)), [Beat::Ping(6), Beat::WentSilent]);
        assert_eq!(hb.tick(t0 + ms(8200)), [Beat::Ping(7)]);
    }

    #[test]
    fn an_out_of_range_pong_is_refused() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::start(t0);
        assert_eq!(hb.pong(1, t0), Err(()), "nothing was pinged");
        hb.tick(t0 + ms(1000));
        hb.tick(t0 + ms(2000));
        assert_eq!(hb.pong(3, t0 + ms(2000)), Err(()), "never pinged");
        assert_eq!(hb.pong(0, t0 + ms(2000)), Err(()));
        assert_eq!(hb.pong(2, t0 + ms(2000)), Ok(Beat::Nothing));
        assert_eq!(hb.pong(2, t0 + ms(2000)), Err(()), "already answered");
        assert_eq!(
            hb.pong(1, t0 + ms(2000)),
            Err(()),
            "older than the last pong"
        );
        // A refused pong does not count as alive.
        assert_eq!(hb.tick(t0 + ms(5000)), [Beat::Ping(3), Beat::WentSilent]);
    }
}

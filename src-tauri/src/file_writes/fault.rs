/*
 * The fault seam for crash tests. A write operation takes a `Fault` and checks it after each durable
 * step; a test builds one that stops the operation right after a chosen step, leaving files and rows
 * as a killed process would. The value travels with the operation, so tests running in parallel never
 * share a stop. Outside tests the value is empty and every check passes.
 */

/// The durable steps of a write, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Step {
    Journaled,
    TempWritten,
    TempSynced,
    Replaced,
    SourceSynced,
    Finished,
    Swept,
}

#[cfg(test)]
impl Step {
    pub const ALL: [Step; 7] = [
        Step::Journaled,
        Step::TempWritten,
        Step::TempSynced,
        Step::Replaced,
        Step::SourceSynced,
        Step::Finished,
        Step::Swept,
    ];
}

/// The step an operation was stopped after.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Aborted(pub Step);

/// Where a test stops one operation. Production code passes `Fault::NONE`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fault {
    #[cfg(test)]
    stop: Option<Step>,
}

impl Fault {
    pub const NONE: Fault = Fault {
        #[cfg(test)]
        stop: None,
    };

    #[cfg(test)]
    pub fn abort_after(step: Step) -> Fault {
        Fault { stop: Some(step) }
    }

    /// Called right after `step` is durable. Err when the operation must return there.
    pub fn check(self, step: Step) -> Result<(), Aborted> {
        #[cfg(test)]
        if self.stop == Some(step) {
            return Err(Aborted(step));
        }
        #[cfg(not(test))]
        let _ = step;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fault_stops_only_at_its_step() {
        for stop in Step::ALL {
            let fault = Fault::abort_after(stop);
            for step in Step::ALL {
                let want = if step == stop {
                    Err(Aborted(step))
                } else {
                    Ok(())
                };
                assert_eq!(fault.check(step), want, "{stop:?} at {step:?}");
            }
        }
    }

    #[test]
    fn no_fault_never_stops() {
        for step in Step::ALL {
            assert_eq!(Fault::NONE.check(step), Ok(()));
            assert_eq!(Fault::default().check(step), Ok(()));
        }
    }

    #[test]
    fn steps_run_in_write_order() {
        assert!(Step::ALL.windows(2).all(|w| w[0] < w[1]));
    }
}

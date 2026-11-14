/*
 * Calls from a native plugin's page to its own child. Each one takes the next `seq` of the run, goes
 * out as `call`, and waits on a channel of its own for the child's `result`. The table's lock covers
 * map work only and nothing waits while holding it, so the pump, the supervisor and command threads
 * never queue behind a relay. When the run ends, every open relay fails at once and the table takes no
 * new one.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};
use serde_json::Value;

// -- Local Imports --
use super::child::SendError;
use super::protocol::HostMessage;
use super::status::HostState;
use super::{lock, NativeHost, Run};
use crate::plugins::api::error::ApiError;

/// How long a page call waits for the child's answer.
pub const RELAY_TIMEOUT: Duration = Duration::from_secs(10);

type Answer = Result<Value, ApiError>;

#[derive(Default)]
struct Table {
    // The last seq given out; the first relay of a run is 1.
    last_seq: u64,
    open: HashMap<u64, Sender<Answer>>,
    closed: bool,
}

/// The open relays of one run.
#[derive(Default)]
pub struct Relays(Mutex<Table>);

impl Relays {
    /// Opens a relay with the next seq. None once the run has ended.
    fn open(&self) -> Option<(u64, Receiver<Answer>)> {
        let mut table = lock(&self.0);
        if table.closed {
            return None;
        }
        table.last_seq += 1;
        let seq = table.last_seq;
        let (tx, rx) = bounded(1);
        table.open.insert(seq, tx);
        Some((seq, rx))
    }

    /// Gives up on relay `seq`; a later answer to it is unknown.
    fn cancel(&self, seq: u64) {
        lock(&self.0).open.remove(&seq);
    }

    /// Answers relay `seq`. False when no relay with that seq is open: never sent, answered already,
    /// or given up on.
    pub fn resolve(&self, seq: u64, answer: Answer) -> bool {
        let waiting = lock(&self.0).open.remove(&seq);
        match waiting {
            Some(tx) => {
                let _ = tx.try_send(answer);
                true
            }
            None => false,
        }
    }

    /// Fails every open relay with `unavailable` and refuses new ones.
    pub fn fail_all(&self) {
        let open: Vec<Sender<Answer>> = {
            let mut table = lock(&self.0);
            table.closed = true;
            table.open.drain().map(|(_, tx)| tx).collect()
        };
        for tx in open {
            let _ = tx.try_send(Err(ApiError::unavailable()));
        }
    }

    #[cfg(test)]
    pub fn open_count(&self) -> usize {
        lock(&self.0).open.len()
    }
}

/// What the page gets for a child's `result`: the result, `null` when there is none, or the child's
/// error message as `plugin_error`.
pub fn answer(ok: bool, result: Option<Value>, error: Option<Value>) -> Answer {
    if ok {
        return Ok(result.unwrap_or(Value::Null));
    }
    let message = error
        .as_ref()
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str);
    Err(ApiError::plugin_error(message))
}

impl NativeHost {
    /// Hands a call from plugin `id`'s page to its child and waits for the answer, up to the relay
    /// timeout. `unavailable` when the child is neither running nor not responding, or when its run
    /// ends meanwhile; `busy` when its outbox is full.
    pub fn relay(&self, id: &str, method: &str, args: Value) -> Answer {
        let Some((run, child)) = self.ready_run(id) else {
            return Err(ApiError::unavailable());
        };
        let answering = matches!(
            self.board.host(id),
            Some(HostState::Running | HostState::NotResponding)
        );
        if !answering {
            return Err(ApiError::unavailable());
        }
        let Some((seq, answered)) = run.relays.open() else {
            return Err(ApiError::unavailable());
        };
        let call = HostMessage::Call {
            seq,
            method: method.to_string(),
            args,
        };
        if let Err(e) = child.send(&call) {
            run.relays.cancel(seq);
            return Err(match e {
                SendError::Full => ApiError::busy(),
                SendError::TooLarge => {
                    ApiError::too_large("The arguments do not fit in one frame to the plugin.")
                }
                SendError::Closed => ApiError::unavailable(),
            });
        }
        wait(&run, seq, &answered, self.relay_timeout)
    }
}

fn wait(run: &Arc<Run>, seq: u64, answered: &Receiver<Answer>, timeout: Duration) -> Answer {
    match answered.recv_timeout(timeout) {
        Ok(answer) => answer,
        Err(RecvTimeoutError::Timeout) => {
            run.relays.cancel(seq);
            Err(ApiError::timeout())
        }
        Err(RecvTimeoutError::Disconnected) => Err(ApiError::unavailable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use serde_json::json;

    #[test]
    fn seqs_count_from_one_and_each_answer_reaches_its_own_relay() {
        let relays = Relays::default();
        let (one, first) = relays.open().unwrap();
        let (two, second) = relays.open().unwrap();
        assert_eq!((one, two), (1, 2));
        assert!(relays.resolve(2, Ok(json!("b"))));
        assert!(relays.resolve(1, Ok(json!("a"))));
        assert_eq!(first.try_recv().unwrap(), Ok(json!("a")));
        assert_eq!(second.try_recv().unwrap(), Ok(json!("b")));
        // Answered, so a second answer and an unknown seq are refused.
        assert!(!relays.resolve(1, Ok(Value::Null)));
        assert!(!relays.resolve(9, Ok(Value::Null)));
        assert_eq!(relays.open_count(), 0);
    }

    #[test]
    fn a_cancelled_relay_takes_no_answer() {
        let relays = Relays::default();
        let (seq, _) = relays.open().unwrap();
        relays.cancel(seq);
        assert!(!relays.resolve(seq, Ok(Value::Null)));
    }

    #[test]
    fn fail_all_answers_every_open_relay_and_closes_the_table() {
        let relays = Relays::default();
        let waiting: Vec<Receiver<Answer>> = (0..3).map(|_| relays.open().unwrap().1).collect();
        relays.fail_all();
        for rx in waiting {
            assert_eq!(rx.try_recv().unwrap(), Err(ApiError::unavailable()));
        }
        assert!(relays.open().is_none());
        assert_eq!(relays.open_count(), 0);
    }

    #[test]
    fn a_result_becomes_the_pages_answer() {
        assert_eq!(
            answer(true, Some(json!({"a": 1})), None),
            Ok(json!({"a": 1}))
        );
        assert_eq!(answer(true, None, None), Ok(Value::Null));
        let error = answer(false, None, Some(json!({"message": "x".repeat(300)}))).unwrap_err();
        assert_eq!(error.code, ApiCode::PluginError);
        assert_eq!(error.message.len(), 200);
        // A missing or non-text message gets the fixed text.
        for error in [
            None,
            Some(json!({})),
            Some(json!({"message": 5})),
            Some(json!("x")),
        ] {
            let refused = answer(false, Some(json!(1)), error).unwrap_err();
            assert_eq!(refused, ApiError::plugin_error(None));
        }
    }

    #[test]
    fn a_wait_that_runs_out_is_a_timeout_and_gives_the_relay_up() {
        let run = Arc::new(Run::new());
        let (seq, answered) = run.relays.open().unwrap();
        let waited = wait(&run, seq, &answered, Duration::from_millis(1));
        assert_eq!(waited, Err(ApiError::timeout()));
        assert!(!run.relays.resolve(seq, Ok(Value::Null)));
    }
}

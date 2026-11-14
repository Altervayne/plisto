/*
 * One running native plugin: its process, its job, and two threads that own its pipes. Plisto never
 * reads or writes a pipe itself. Outgoing frames go through a bounded queue that never blocks the
 * sender: a child that stops reading fills the queue and further sends fail. Incoming frames wait in
 * a bounded inbox as raw bytes and are parsed only when taken, so the inbox never holds more than its
 * frame count times the frame cap; when it is full the reader waits, so a child that floods its
 * output only blocks on its own pipe.
 * Dropping the handle closes the job, which kills the whole process tree.
 */

// -- Library Imports --
use std::io::{BufReader, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::process::{self, ChildStdin};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender, TrySendError};
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::WaitForSingleObject;

// -- Local Imports --
use super::job::Job;
use super::launch::{launch, LaunchSpec};
use super::protocol::{
    decode, encode, read_frame, ChildMessage, Decoded, FrameError, HostMessage, CHILD_KINDS,
    PROTOCOL_VERSION,
};

/// Frames waiting to be written to the child.
pub const OUTBOX_CAP: usize = 64;
/// Frames waiting to be read by Plisto.
pub const INBOX_CAP: usize = 64;
// After a forced kill, how long to wait for the process to be gone.
const KILL_WAIT: Duration = Duration::from_secs(5);
const READ_BUFFER: usize = 64 * 1024;

/// Why the child's output ended: it closed the stream cleanly.
pub const CLOSED_EXITED: &str = "exited";
/// Why the child's output ended: a frame broke, so nothing after it can be trusted.
pub const CLOSED_PROTOCOL: &str = "protocol";

/// What the inbox delivers. Reporting is the caller's job: the inbox logs nothing.
#[derive(Debug, PartialEq)]
pub enum Inbound {
    Message(ChildMessage),
    /// A well-formed frame of a type Plisto does not know; the type tag, shortened.
    Unknown(String),
    /// A frame that is not JSON or has the wrong fields; a short reason, never the payload.
    Malformed(String),
    /// The child's output ended, with `CLOSED_EXITED` or `CLOSED_PROTOCOL`; nothing follows.
    Closed(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    /// The child is not reading fast enough; the message was dropped.
    Full,
    /// The child's input is gone.
    Closed,
    /// The message is over the frame cap and was not queued.
    TooLarge,
}

/// What the reader thread queues.
enum Raw {
    Frame(Vec<u8>),
    Closed(String),
}

/// The receiving end of a child's output. Clones share one queue.
#[derive(Clone)]
pub struct Inbox {
    rx: Receiver<Raw>,
}

impl Inbox {
    /// The next frame, parsed as it is taken. Unknown types and malformed bodies are returned, not
    /// skipped, so the caller can count them.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<Inbound, RecvTimeoutError> {
        Ok(match self.rx.recv_timeout(timeout)? {
            Raw::Frame(body) => match decode::<ChildMessage>(&body, CHILD_KINDS) {
                Decoded::Message(message) => Inbound::Message(message),
                Decoded::Unknown(kind) => Inbound::Unknown(kind),
                Decoded::Malformed(why) => Inbound::Malformed(why),
            },
            Raw::Closed(why) => Inbound::Closed(why),
        })
    }

    /// Takes and drops everything, unparsed, until the child's output ends.
    pub fn discard(&self) {
        for _ in self.rx.iter() {}
    }

    /// Frames waiting to be taken.
    pub fn waiting(&self) -> usize {
        self.rx.len()
    }
}

#[derive(Debug, PartialEq)]
pub enum HandshakeError {
    Timeout,
    /// The child's output ended before `ready`, with the reason.
    Exited(String),
    /// `ready` named another protocol version.
    Protocol(u32),
    /// `hello` could not be queued.
    Send(SendError),
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::Timeout => f.write_str("no ready in time"),
            HandshakeError::Exited(why) => write!(f, "exited before ready ({why})"),
            HandshakeError::Protocol(v) => write!(f, "speaks protocol {v}"),
            HandshakeError::Send(e) => write!(f, "cannot send hello ({e:?})"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// It exited by itself within the grace period.
    Clean,
    Killed,
}

pub struct Child {
    id: String,
    pid: u32,
    // Declared before the process so the job closes, killing the tree, before its handle is released.
    job: Job,
    process: process::Child,
    outbox: Sender<Vec<u8>>,
    inbox: Inbox,
}

impl Child {
    /// Launches the plugin and starts its pipe threads. Nothing is sent yet.
    pub fn spawn(id: &str, spec: &LaunchSpec) -> std::io::Result<Child> {
        let (mut process, job) = launch(spec)?;
        let stdin = process.stdin.take();
        let stdout = process.stdout.take();
        let (outbox, outgoing) = bounded(OUTBOX_CAP);
        let (incoming, inbox) = bounded(INBOX_CAP);
        let child = Child {
            id: id.to_string(),
            pid: process.id(),
            job,
            process,
            outbox,
            inbox: Inbox { rx: inbox },
        };
        let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
            return Err(std::io::Error::other("the child has no pipes"));
        };
        thread::Builder::new()
            .name(format!("plugin-out-{id}"))
            .spawn(move || write_loop(stdin, outgoing))?;
        thread::Builder::new()
            .name(format!("plugin-in-{id}"))
            .spawn(move || read_loop(stdout, incoming))?;
        Ok(child)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Queues a message without waiting.
    pub fn send(&self, message: &HostMessage) -> Result<(), SendError> {
        let frame = encode(message).map_err(|_| SendError::TooLarge)?;
        self.outbox.try_send(frame).map_err(|e| match e {
            TrySendError::Full(_) => SendError::Full,
            TrySendError::Disconnected(_) => SendError::Closed,
        })
    }

    /// A handle on the inbox, for a thread that consumes it.
    pub fn inbox(&self) -> Inbox {
        self.inbox.clone()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<Inbound, RecvTimeoutError> {
        self.inbox.recv_timeout(timeout)
    }

    /// Sends `hello` and waits for `ready`. Anything else before it is dropped.
    pub fn handshake(&self, hello: &HostMessage, timeout: Duration) -> Result<(), HandshakeError> {
        self.send(hello).map_err(HandshakeError::Send)?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.inbox.recv_timeout(left) {
                Ok(Inbound::Message(ChildMessage::Ready { protocol })) => {
                    return match protocol {
                        PROTOCOL_VERSION => Ok(()),
                        other => Err(HandshakeError::Protocol(other)),
                    };
                }
                Ok(Inbound::Message(_) | Inbound::Unknown(_) | Inbound::Malformed(_)) => {}
                Ok(Inbound::Closed(why)) => return Err(HandshakeError::Exited(why)),
                Err(RecvTimeoutError::Timeout) => return Err(HandshakeError::Timeout),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(HandshakeError::Exited("reader gone".into()))
                }
            }
        }
    }

    /// Waits up to `timeout` for the process to exit. True once it has.
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        let handle = HANDLE(self.process.as_raw_handle());
        // Safety: the process handle stays open while `self.process` lives.
        let event = unsafe { WaitForSingleObject(handle, ms) };
        event == WAIT_OBJECT_0
    }

    /// Kills the whole tree now and waits for the process to be gone.
    pub fn kill(&self) {
        if let Err(e) = self.job.terminate() {
            eprintln!("plugins: {}: cannot terminate the job: {e}", self.id);
        }
        self.wait_exit(KILL_WAIT);
    }

    /// Asks the child to shut down, gives it `grace` to exit, then kills it. Whatever it started is
    /// killed either way.
    pub fn stop(&self, grace: Duration) -> Stopped {
        if self.wait_exit(Duration::ZERO) {
            self.kill();
            return Stopped::Clean;
        }
        // A full or closed queue just means the grace runs out.
        let _ = self.send(&HostMessage::Shutdown);
        let clean = self.wait_exit(grace);
        self.kill();
        if clean {
            Stopped::Clean
        } else {
            Stopped::Killed
        }
    }

    /// Frames waiting in the inbox.
    #[cfg(test)]
    pub fn inbox_len(&self) -> usize {
        self.inbox.waiting()
    }
}

fn write_loop(mut stdin: ChildStdin, outgoing: Receiver<Vec<u8>>) {
    for frame in outgoing {
        if stdin
            .write_all(&frame)
            .and_then(|()| stdin.flush())
            .is_err()
        {
            return;
        }
    }
}

fn read_loop(stdout: impl Read, incoming: Sender<Raw>) {
    let mut reader = BufReader::with_capacity(READ_BUFFER, stdout);
    let end = loop {
        match read_frame(&mut reader) {
            Ok(Some(body)) => {
                // Waits while the inbox is full; fails only once Plisto dropped the child.
                if incoming.send(Raw::Frame(body)).is_err() {
                    return;
                }
            }
            Ok(None) | Err(FrameError::Io(_)) => break CLOSED_EXITED,
            Err(_) => break CLOSED_PROTOCOL,
        }
    };
    let _ = incoming.send(Raw::Closed(end.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn taken(bytes: Vec<u8>) -> Vec<Inbound> {
        let (tx, rx) = bounded(INBOX_CAP);
        read_loop(Cursor::new(bytes), tx);
        let inbox = Inbox { rx };
        let mut out = Vec::new();
        loop {
            let next = inbox.recv_timeout(Duration::ZERO).unwrap();
            let done = matches!(next, Inbound::Closed(_));
            out.push(next);
            if done {
                return out;
            }
        }
    }

    fn frame(json: &str) -> Vec<u8> {
        format!("{}\n{json}\n", json.len()).into_bytes()
    }

    #[test]
    fn unknown_and_malformed_frames_are_surfaced_and_the_stream_goes_on() {
        let mut bytes = frame(r#"{"type":"pong","seq":1}"#);
        bytes.extend(frame(r#"{"type":"teleport","x":1}"#));
        bytes.extend(frame("not json"));
        bytes.extend(frame(r#"{"type":"pong","seq":"secret-payload"}"#));
        bytes.extend(frame(r#"{"type":"status","state":"bogus"}"#));
        bytes.extend(frame(r#"{"type":"pong","seq":2}"#));
        let got = taken(bytes);
        assert_eq!(got.len(), 7);
        assert_eq!(got[0], Inbound::Message(ChildMessage::Pong { seq: 1 }));
        assert_eq!(got[1], Inbound::Unknown("teleport".into()));
        for malformed in &got[2..5] {
            match malformed {
                Inbound::Malformed(why) => assert!(!why.contains("secret-payload"), "{why}"),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(got[5], Inbound::Message(ChildMessage::Pong { seq: 2 }));
        assert_eq!(got[6], Inbound::Closed(CLOSED_EXITED.into()));
    }

    #[test]
    fn a_clean_end_of_output_closes_as_exited() {
        assert_eq!(taken(Vec::new()), [Inbound::Closed(CLOSED_EXITED.into())]);
    }

    #[test]
    fn a_broken_frame_closes_as_protocol_after_the_frames_before_it() {
        let over = format!("{}\n", (1 << 20) + 1).into_bytes();
        for broken in [&b"abc
"[..], b"10
{\"type\"", b"2
{}x", &over[..]] {
            let mut bytes = frame(r#"{"type":"pong","seq":1}"#);
            bytes.extend_from_slice(broken);
            let got = taken(bytes);
            assert_eq!(got.len(), 2, "{broken:?}");
            assert_eq!(got[0], Inbound::Message(ChildMessage::Pong { seq: 1 }));
            assert_eq!(got[1], Inbound::Closed(CLOSED_PROTOCOL.into()));
        }
    }
}

/*
 * The sinks behind the startup sandbox self-check. Every webview starts with browser args that keep
 * WebRTC from leaving the machine (webview_guard.rs), but the runtime updates itself and could stop
 * reading them. So at every start the main window aims a WebRTC test at two loopback sinks opened here,
 * then asks what reached them. A sink only counts: datagrams on the UDP one, accepted connections on
 * the TCP one. It never answers, never parses, and reads into a small buffer it discards.
 *
 * One check is open at a time. Its sinks run on one thread over non-blocking sockets polled on a short
 * interval with a bounded number of reads per poll, so closing waits at most one poll even under a
 * flood, and a check nobody closes ends itself after its lifetime. Counts saturate.
 */

// -- Library Imports --
use std::io::{self, ErrorKind};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tauri::{State, Webview};

const MAIN_LABEL: &str = "main";
const LIFETIME: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(10);
const READ_BUFFER: usize = 64;
const PER_TICK: usize = 64;
const TOKEN_BYTES: usize = 16;
// Windows reports a datagram larger than the buffer as this error, after discarding it.
#[cfg(windows)]
const WSAEMSGSIZE: i32 = 10040;

/// Where the test should aim, and the token that closes the check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SandboxSinks {
    pub token: String,
    pub udp_port: u16,
    pub tcp_port: u16,
}

/// What reached the sinks while the check was open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SandboxSeen {
    pub udp: u32,
    pub tcp: u32,
}

#[derive(Default)]
struct Counts {
    udp: AtomicU32,
    tcp: AtomicU32,
}

struct OpenCheck {
    token: String,
    stop: Arc<AtomicBool>,
    counts: Arc<Counts>,
    sinks: JoinHandle<()>,
}

impl OpenCheck {
    /// Stops the sinks, which releases both ports, and reads what they counted.
    fn finish(self) -> SandboxSeen {
        self.stop.store(true, Ordering::SeqCst);
        // A sink that panicked has still counted what it saw.
        let _ = self.sinks.join();
        SandboxSeen {
            udp: self.counts.udp.load(Ordering::SeqCst),
            tcp: self.counts.tcp.load(Ordering::SeqCst),
        }
    }
}

/// The open check, if any.
pub struct SandboxCheck {
    open: Mutex<Option<OpenCheck>>,
    lifetime: Duration,
}

impl Default for SandboxCheck {
    fn default() -> Self {
        Self::with_lifetime(LIFETIME)
    }
}

impl SandboxCheck {
    fn with_lifetime(lifetime: Duration) -> Self {
        Self {
            open: Mutex::new(None),
            lifetime,
        }
    }

    fn slot(&self) -> MutexGuard<'_, Option<OpenCheck>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens fresh sinks, closing any check still open.
    fn open(&self) -> Result<SandboxSinks, String> {
        let mut slot = self.slot();
        if let Some(previous) = slot.take() {
            previous.finish();
        }
        let failed = |e: io::Error| format!("cannot open the sandbox check sinks: {e}");
        let (udp, tcp) = bind_sinks().map_err(failed)?;
        let sinks = SandboxSinks {
            token: new_token()?,
            udp_port: udp.local_addr().map_err(failed)?.port(),
            tcp_port: tcp.local_addr().map_err(failed)?.port(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let counts = Arc::new(Counts::default());
        let deadline = Instant::now() + self.lifetime;
        let handle = {
            let (stop, counts) = (stop.clone(), counts.clone());
            thread::Builder::new()
                .name("sandbox-check".into())
                .spawn(move || run_sinks(udp, tcp, &stop, &counts, deadline))
                .map_err(failed)?
        };
        *slot = Some(OpenCheck {
            token: sinks.token.clone(),
            stop,
            counts,
            sinks: handle,
        });
        Ok(sinks)
    }

    /// Closes the check opened under `token`. Any other token leaves the open check as it is.
    fn close(&self, token: &str) -> Result<SandboxSeen, String> {
        let mut slot = self.slot();
        match slot.take() {
            Some(check) if check.token == token => {
                let seen = check.finish();
                eprintln!(
                    "sandbox check: {} datagrams, {} connections reached the sinks",
                    seen.udp, seen.tcp
                );
                Ok(seen)
            }
            other => {
                *slot = other;
                Err("no sandbox check is open under that token".to_string())
            }
        }
    }

    #[cfg(test)]
    fn sinks_running(&self) -> bool {
        self.slot()
            .as_ref()
            .is_some_and(|check| !check.sinks.is_finished())
    }
}

/// Both sinks on loopback, on ports the OS picks, non-blocking.
fn bind_sinks() -> io::Result<(UdpSocket, TcpListener)> {
    let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let udp = UdpSocket::bind(loopback)?;
    udp.set_nonblocking(true)?;
    let tcp = TcpListener::bind(loopback)?;
    tcp.set_nonblocking(true)?;
    Ok((udp, tcp))
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "cannot draw a sandbox check token".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Counts until stopped or past `deadline`, then drops both sockets.
fn run_sinks(
    udp: UdpSocket,
    tcp: TcpListener,
    stop: &AtomicBool,
    counts: &Counts,
    deadline: Instant,
) {
    let mut buffer = [0u8; READ_BUFFER];
    loop {
        // Read before draining, so whatever arrived before the stop is still counted.
        let last = stop.load(Ordering::SeqCst) || Instant::now() >= deadline;
        drain(&counts.udp, || udp_read(udp.recv(&mut buffer)));
        drain(&counts.tcp, || tcp_accept(tcp.accept().map(drop)));
        if last {
            return;
        }
        thread::sleep(POLL);
    }
}

/// What one read or accept on a sink says.
#[derive(Debug, PartialEq, Eq)]
enum Read {
    Arrival,
    Empty,
    Other,
}

fn udp_read(result: io::Result<usize>) -> Read {
    match result {
        Ok(_) => Read::Arrival,
        #[cfg(windows)]
        Err(e) if e.raw_os_error() == Some(WSAEMSGSIZE) => Read::Arrival,
        Err(e) if e.kind() == ErrorKind::WouldBlock => Read::Empty,
        Err(_) => Read::Other,
    }
}

/// A connection reset or aborted before it was accepted still reached the port.
fn tcp_accept(result: io::Result<()>) -> Read {
    match result {
        Ok(()) => Read::Arrival,
        Err(e) if e.kind() == ErrorKind::WouldBlock => Read::Empty,
        Err(e)
            if matches!(
                e.kind(),
                ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted
            ) =>
        {
            Read::Arrival
        }
        Err(_) => Read::Other,
    }
}

/// Up to `PER_TICK` reads, so a sender that outpaces the sink cannot keep it from seeing a stop.
fn drain(count: &AtomicU32, mut read: impl FnMut() -> Read) {
    for _ in 0..PER_TICK {
        match read() {
            // The sink thread is the only writer, so a load and a store do not race.
            Read::Arrival => count.store(
                count.load(Ordering::SeqCst).saturating_add(1),
                Ordering::SeqCst,
            ),
            Read::Empty => return,
            Read::Other => {}
        }
    }
}

/// Opens a check for the webview `label`: the main window only.
fn open_from(label: &str, check: &SandboxCheck) -> Result<SandboxSinks, String> {
    if label != MAIN_LABEL {
        return Err("the sandbox check runs from the main window only".to_string());
    }
    check.open()
}

/// Closes a check for the webview `label`: the main window only.
fn close_from(label: &str, check: &SandboxCheck, token: &str) -> Result<SandboxSeen, String> {
    if label != MAIN_LABEL {
        return Err("the sandbox check runs from the main window only".to_string());
    }
    check.close(token)
}

/// Opens the loopback sinks the startup WebRTC test aims at. A check still open is closed first.
#[tauri::command(async)]
pub fn sandbox_check_open(
    webview: Webview,
    check: State<'_, SandboxCheck>,
) -> Result<SandboxSinks, String> {
    open_from(webview.label(), &check)
}

/// Closes the check opened under `token` and returns what reached its sinks.
#[tauri::command(async)]
pub fn sandbox_check_close(
    token: String,
    webview: Webview,
    check: State<'_, SandboxCheck>,
) -> Result<SandboxSeen, String> {
    close_from(webview.label(), &check, &token)
}

#[cfg(test)]
mod tests;

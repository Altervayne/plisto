// The sinks against real loopback sockets: exact counts, the token, the main-window gate, loopback
// binds, and the self-shutdown after a short injected lifetime.

// -- Library Imports --
use std::net::{IpAddr, TcpStream};

// -- Local Imports --
use super::*;

const SETTLE: Duration = Duration::from_millis(200);

fn send_datagram(port: u16, len: usize) {
    let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    sender
        .send_to(&vec![7u8; len], (Ipv4Addr::LOCALHOST, port))
        .unwrap();
}

fn connect(port: u16) -> io::Result<TcpStream> {
    TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SETTLE)
}

/// Whether a fresh socket can take `port` on loopback, which it cannot while a sink holds it.
fn udp_port_free(port: u16) -> bool {
    UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// Sends datagrams to `port` as fast as it can until the returned flag is set.
fn flood(port: u16) -> (Arc<AtomicBool>, JoinHandle<()>) {
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let handle = thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            // A closed port can surface as an error on the next send; keep going.
            let _ = sender.send_to(&[7u8; 32], (Ipv4Addr::LOCALHOST, port));
        }
    });
    (done, handle)
}

#[test]
fn a_flood_does_not_hold_close_back() {
    let check = SandboxCheck::default();
    let sinks = check.open().unwrap();
    let (done, sender) = flood(sinks.udp_port);
    thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    let seen = check.close(&sinks.token).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(seen.udp > 0);
    done.store(true, Ordering::SeqCst);
    sender.join().unwrap();
}

#[test]
fn the_lifetime_ends_the_sinks_under_a_flood() {
    let check = SandboxCheck::with_lifetime(Duration::from_millis(50));
    let sinks = check.open().unwrap();
    let (done, sender) = flood(sinks.udp_port);
    let started = Instant::now();
    while check.sinks_running() {
        assert!(started.elapsed() < Duration::from_secs(1), "never shut");
        thread::sleep(POLL);
    }
    done.store(true, Ordering::SeqCst);
    sender.join().unwrap();
    assert!(check.close(&sinks.token).unwrap().udp > 0);
}

#[test]
fn a_connection_reset_before_accept_counts_and_other_errors_do_not_stop_the_drain() {
    let error = |kind: ErrorKind| Err(io::Error::from(kind));
    assert_eq!(tcp_accept(Ok(())), Read::Arrival);
    assert_eq!(tcp_accept(error(ErrorKind::ConnectionReset)), Read::Arrival);
    assert_eq!(
        tcp_accept(error(ErrorKind::ConnectionAborted)),
        Read::Arrival
    );
    assert_eq!(tcp_accept(error(ErrorKind::WouldBlock)), Read::Empty);
    assert_eq!(tcp_accept(error(ErrorKind::PermissionDenied)), Read::Other);

    // An error ahead of queued connections does not hide them.
    let count = AtomicU32::new(0);
    let mut queue = vec![Read::Empty, Read::Arrival, Read::Other, Read::Arrival];
    drain(&count, || queue.pop().unwrap());
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[test]
fn a_drain_is_bounded_per_tick_and_saturates() {
    let count = AtomicU32::new(u32::MAX - 1);
    let mut reads = 0;
    drain(&count, || {
        reads += 1;
        Read::Arrival
    });
    assert_eq!(reads, PER_TICK);
    assert_eq!(count.load(Ordering::SeqCst), u32::MAX);

    let mut reads = 0;
    drain(&count, || {
        reads += 1;
        Read::Other
    });
    assert_eq!(reads, PER_TICK);
}

#[test]
fn a_datagram_larger_than_the_buffer_is_an_arrival() {
    assert_eq!(udp_read(Ok(3)), Read::Arrival);
    assert_eq!(
        udp_read(Err(io::Error::from(ErrorKind::WouldBlock))),
        Read::Empty
    );
    #[cfg(windows)]
    assert_eq!(
        udp_read(Err(io::Error::from_raw_os_error(WSAEMSGSIZE))),
        Read::Arrival
    );
}

#[test]
fn the_sinks_count_exactly_and_close_releases_them() {
    let check = SandboxCheck::default();
    let sinks = open_from(MAIN_LABEL, &check).unwrap();
    assert_eq!(sinks.token.len(), TOKEN_BYTES * 2);
    assert!(!udp_port_free(sinks.udp_port));

    send_datagram(sinks.udp_port, 20);
    // Larger than the read buffer, as a real STUN or TURN packet is.
    send_datagram(sinks.udp_port, 1200);
    let first = connect(sinks.tcp_port).unwrap();
    let second = connect(sinks.tcp_port).unwrap();
    thread::sleep(SETTLE);

    let seen = close_from(MAIN_LABEL, &check, &sinks.token).unwrap();
    assert_eq!(seen, SandboxSeen { udp: 2, tcp: 2 });
    drop((first, second));

    assert!(!check.sinks_running());
    assert!(udp_port_free(sinks.udp_port));
    assert!(connect(sinks.tcp_port).is_err());
    assert!(close_from(MAIN_LABEL, &check, &sinks.token).is_err());
}

#[test]
fn traffic_sent_just_before_close_is_counted() {
    let check = SandboxCheck::default();
    for _ in 0..5 {
        let sinks = check.open().unwrap();
        send_datagram(sinks.udp_port, 32);
        let connection = connect(sinks.tcp_port).unwrap();
        assert_eq!(
            check.close(&sinks.token).unwrap(),
            SandboxSeen { udp: 1, tcp: 1 }
        );
        drop(connection);
    }
}

#[test]
fn a_check_with_no_traffic_counts_nothing() {
    let check = SandboxCheck::default();
    let sinks = check.open().unwrap();
    thread::sleep(POLL * 3);
    assert_eq!(
        check.close(&sinks.token).unwrap(),
        SandboxSeen { udp: 0, tcp: 0 }
    );
}

#[test]
fn a_wrong_token_leaves_the_open_check_alone() {
    let check = SandboxCheck::default();
    let sinks = check.open().unwrap();
    for wrong in ["", "nope", &sinks.token[1..], &sinks.token.to_uppercase()] {
        if wrong == sinks.token {
            continue;
        }
        assert!(check.close(wrong).is_err(), "{wrong:?}");
    }
    assert!(check.sinks_running());
    send_datagram(sinks.udp_port, 8);
    thread::sleep(SETTLE);
    assert_eq!(check.close(&sinks.token).unwrap().udp, 1);
}

#[test]
fn a_second_open_invalidates_the_first() {
    let check = SandboxCheck::default();
    let first = check.open().unwrap();
    let second = check.open().unwrap();
    assert_ne!(first.token, second.token);
    assert!(udp_port_free(first.udp_port));
    assert!(check.close(&first.token).is_err());
    assert!(check.sinks_running());
    assert!(check.close(&second.token).is_ok());
}

#[test]
fn repeated_opens_leave_one_sink_thread() {
    let check = SandboxCheck::default();
    let mut ports = Vec::new();
    for _ in 0..20 {
        ports.push(check.open().unwrap().udp_port);
    }
    let last = ports.pop().unwrap();
    for port in ports {
        assert!(udp_port_free(port), "{port}");
    }
    assert!(!udp_port_free(last));
    assert!(check.sinks_running());
}

#[test]
fn only_the_main_window_opens_or_closes() {
    let check = SandboxCheck::default();
    for label in ["tray", "nowplaying", "Main", ""] {
        assert!(open_from(label, &check).is_err(), "{label:?}");
        assert!(!check.sinks_running(), "{label:?}");
    }
    let sinks = open_from(MAIN_LABEL, &check).unwrap();
    for label in ["tray", "nowplaying", "Main", ""] {
        assert!(
            close_from(label, &check, &sinks.token).is_err(),
            "{label:?}"
        );
        assert!(check.sinks_running(), "{label:?}");
    }
    assert!(close_from(MAIN_LABEL, &check, &sinks.token).is_ok());
}

#[test]
fn the_sinks_bind_loopback_only() {
    let (udp, tcp) = bind_sinks().unwrap();
    for addr in [udp.local_addr().unwrap(), tcp.local_addr().unwrap()] {
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(addr.port(), 0);
    }
}

#[test]
fn sinks_left_open_shut_themselves_after_their_lifetime() {
    let check = SandboxCheck::with_lifetime(Duration::from_millis(50));
    let sinks = check.open().unwrap();
    send_datagram(sinks.udp_port, 8);
    let started = Instant::now();
    while check.sinks_running() {
        assert!(started.elapsed() < Duration::from_secs(5), "never shut");
        thread::sleep(POLL);
    }
    assert!(udp_port_free(sinks.udp_port));
    assert!(connect(sinks.tcp_port).is_err());
    assert_eq!(
        check.close(&sinks.token).unwrap(),
        SandboxSeen { udp: 1, tcp: 0 }
    );
}

#[test]
fn the_dtos_serialize_with_the_fixed_field_names() {
    let sinks = SandboxSinks {
        token: "t".into(),
        udp_port: 1,
        tcp_port: 2,
    };
    assert_eq!(
        serde_json::to_value(&sinks).unwrap(),
        serde_json::json!({ "token": "t", "udp_port": 1, "tcp_port": 2 })
    );
    assert_eq!(
        serde_json::to_value(SandboxSeen { udp: 3, tcp: 4 }).unwrap(),
        serde_json::json!({ "udp": 3, "tcp": 4 })
    );
}

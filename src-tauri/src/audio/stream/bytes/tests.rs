use super::*;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

// Long enough that a reader that should be blocked would have returned, short enough to keep the
// suite fast.
const STILL_BLOCKED: Duration = Duration::from_millis(40);
const PROMPTLY: Duration = Duration::from_secs(2);

fn control() -> Arc<StreamControl> {
    Arc::new(StreamControl::new())
}

// Reads `buf_len` bytes' worth once on a thread and sends the result back.
fn read_on_thread<R: Read + Send + 'static>(
    mut reader: R,
    buf_len: usize,
) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = vec![0u8; buf_len];
        let res = reader.read(&mut buf).map(|n| buf[..n].to_vec());
        let _ = tx.send(res);
    });
    rx
}

#[test]
fn byte_ring_blocks_the_reader_until_bytes_arrive() {
    let (writer, ring) = byte_ring(64, control());
    assert!(!ring.is_seekable());
    assert_eq!(ring.byte_len(), None);

    let rx = read_on_thread(ring, 16);
    assert!(
        rx.recv_timeout(STILL_BLOCKED).is_err(),
        "returned before any byte"
    );
    writer.try_write(b"abc").unwrap();
    assert_eq!(rx.recv_timeout(PROMPTLY).unwrap().unwrap(), b"abc");

    // After a finish the rest drains, then the end reads as zero bytes.
    let (writer, mut ring) = byte_ring(64, control());
    writer.try_write(b"xy").unwrap();
    writer.finish();
    let mut buf = [0u8; 8];
    assert_eq!(ring.read(&mut buf).unwrap(), 2);
    assert_eq!(ring.read(&mut buf).unwrap(), 0);
    assert!(ring.seek(SeekFrom::Start(0)).is_err());
}

#[test]
fn byte_ring_reports_room_and_never_overwrites() {
    let (writer, mut ring) = byte_ring(10, control());
    assert_eq!(writer.room(), 10);
    assert_eq!(writer.try_write(b"0123456"), Ok(3));
    assert_eq!(writer.room(), 3);
    // Too big for the room: refused whole, nothing written.
    assert_eq!(writer.try_write(b"abcd"), Err(WriteError::Full { room: 3 }));
    assert_eq!(writer.room(), 3);
    assert_eq!(writer.try_write(b"789"), Ok(0));
    assert_eq!(writer.try_write(b"z"), Err(WriteError::Full { room: 0 }));

    let mut buf = [0u8; 4];
    assert_eq!(ring.read(&mut buf).unwrap(), 4);
    assert_eq!(&buf, b"0123");
    assert_eq!(writer.room(), 4);
    // Wrapping around the ring keeps the order.
    assert_eq!(writer.try_write(b"abcd"), Ok(0));
    let mut all = Vec::new();
    let mut buf = [0u8; 3];
    while all.len() < 10 {
        let n = ring.read(&mut buf).unwrap();
        all.extend_from_slice(&buf[..n]);
    }
    assert_eq!(all, b"456789abcd");
    assert_eq!(writer.room(), 10);

    // A dropped reader closes the writer.
    drop(ring);
    assert_eq!(writer.try_write(b"x"), Err(WriteError::Closed));
}

#[test]
fn growing_buffer_seeks_inside_and_waits_beyond() {
    let (writer, mut body) = growing_buffer(8, control());
    assert!(body.is_seekable());
    assert_eq!(body.byte_len(), Some(8));
    writer.write(b"0123").unwrap();
    assert_eq!(writer.downloaded(), 4);

    // Inside what has arrived: seek and read at once.
    assert_eq!(body.seek(SeekFrom::Start(2)).unwrap(), 2);
    let mut buf = [0u8; 8];
    assert_eq!(body.read(&mut buf).unwrap(), 2);
    assert_eq!(&buf[..2], b"23");
    assert_eq!(body.seek(SeekFrom::Current(-3)).unwrap(), 1);
    // Past the stated length: refused.
    assert!(body.seek(SeekFrom::End(1)).is_err());
    // More than the stated length: refused whole.
    assert_eq!(writer.write(b"45678"), Err(WriteError::Full { room: 4 }));

    // Beyond what has arrived: the seek waits for the bytes.
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let res = body.seek(SeekFrom::Start(6));
        let mut buf = [0u8; 8];
        let n = body.read(&mut buf).unwrap();
        let _ = tx.send((res.unwrap(), buf[..n].to_vec()));
        body
    });
    assert!(
        rx.recv_timeout(STILL_BLOCKED).is_err(),
        "seek returned before the bytes"
    );
    writer.write(b"4567").unwrap();
    assert_eq!(rx.recv_timeout(PROMPTLY).unwrap(), (6, b"67".to_vec()));
    let mut body = handle.join().unwrap();
    assert_eq!(body.read(&mut buf).unwrap(), 0, "end of the body");

    // A body that finished short: a seek past where it stopped fails, a read there ends.
    let (writer, mut body) = growing_buffer(8, control());
    writer.write(b"01").unwrap();
    writer.finish();
    assert!(body.seek(SeekFrom::Start(5)).is_err());
    assert_eq!(body.seek(SeekFrom::Start(2)).unwrap(), 2);
    assert_eq!(body.read(&mut buf).unwrap(), 0);
}

#[test]
fn growing_buffer_refuses_writes_past_its_cap() {
    let (writer, _body) = growing_with(100, 10, 4, control());
    writer.write(b"0123456789").unwrap();
    assert_eq!(writer.write(b"x"), Err(WriteError::TooLarge));
    assert_eq!(writer.downloaded(), 10);
    // The public constructor caps at FINITE_MAX.
    let (writer, _body) = growing_buffer(FINITE_MAX + 1, control());
    assert_eq!(writer.shared.cap, FINITE_MAX);
}

#[test]
fn growing_buffer_reads_and_seeks_across_blocks() {
    // Blocks of 4 bytes: the body spans three, the last one short.
    let (writer, mut body) = growing_with(10, FINITE_MAX, 4, control());
    writer.write(b"012").unwrap();
    writer.write(b"3456789").unwrap();
    writer.finish();

    // One read stops at a block edge; read_exact spans it.
    assert_eq!(body.seek(SeekFrom::Start(2)).unwrap(), 2);
    let mut buf = [0u8; 4];
    assert_eq!(body.read(&mut buf).unwrap(), 2);
    assert_eq!(&buf[..2], b"23");
    body.seek(SeekFrom::Start(3)).unwrap();
    body.read_exact(&mut buf).unwrap();
    assert_eq!(&buf, b"3456");

    // A seek into the last block.
    assert_eq!(body.seek(SeekFrom::End(-1)).unwrap(), 9);
    assert_eq!(body.read(&mut buf).unwrap(), 1);
    assert_eq!(buf[0], b'9');
    assert_eq!(body.read(&mut buf).unwrap(), 0);

    let mut all = Vec::new();
    body.seek(SeekFrom::Start(0)).unwrap();
    body.read_to_end(&mut all).unwrap();
    assert_eq!(all, b"0123456789");
}

#[test]
fn cancel_wakes_a_blocked_read() {
    let ctl = control();
    let (_writer, ring) = byte_ring(16, Arc::clone(&ctl));
    let ring_rx = read_on_thread(ring, 8);
    let (_gw, body) = growing_buffer(16, Arc::clone(&ctl));
    let body_rx = read_on_thread(body, 8);
    assert!(ring_rx.recv_timeout(STILL_BLOCKED).is_err());

    ctl.cancel();
    let err = ring_rx.recv_timeout(PROMPTLY).unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);
    let err = body_rx.recv_timeout(PROMPTLY).unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);
}

#[test]
fn a_dropped_writer_wakes_the_reader_with_a_broken_pipe() {
    let (writer, ring) = byte_ring(16, control());
    let rx = read_on_thread(ring, 8);
    assert!(rx.recv_timeout(STILL_BLOCKED).is_err());
    drop(writer);
    let err = rx.recv_timeout(PROMPTLY).unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);

    let (writer, body) = growing_buffer(16, control());
    let rx = read_on_thread(body, 8);
    drop(writer);
    let err = rx.recv_timeout(PROMPTLY).unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
}

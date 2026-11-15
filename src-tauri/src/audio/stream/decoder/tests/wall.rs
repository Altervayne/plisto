/*
 * Hostile bytes the guards miss, or never see with the guards off, meeting the decode helper's wall.
 * Each input makes symphonia allocate from a forged size field, so with no helper it would allocate
 * hundreds of MiB in this process; in the helper the job's memory cap refuses the allocation and the
 * item ends `Isolated(Memory)`.
 */

use super::hostile_ogg::{chain_moved_on_after, evil_comment, mp4_with_esds, vorbis_comment};
use super::*;
use crate::audio::stream::bytes::GrowingBuffer;
use crate::audio::stream::isolate::bridge::spawn_unguarded;
use crate::audio::stream::test_containers::{ogg_page, vorbis_ident, vorbis_setup, FIRST};

const SERIAL: u32 = 0x5151;

// A finished, seekable body holding `bytes`.
fn seekable_body(bytes: &[u8], control: &Arc<StreamControl>) -> GrowingBuffer {
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(control));
    writer.write(bytes).unwrap();
    writer.finish();
    body
}

/// The smallest setup header symphonia's Vorbis decoder accepts for `vorbis_ident`: one book of two
/// 1-bit codewords, an empty floor 1, one residue, one mapping and one mode.
fn playable_setup() -> Vec<u8> {
    vorbis_setup(&[
        // One codebook: sync, 1 dimension, 2 entries, unordered, dense, lengths 1, no lookup.
        (0, 8),
        (0x56_4342, 24),
        (1, 16),
        (2, 24),
        (0, 1),
        (0, 1),
        (0, 5),
        (0, 5),
        (0, 4),
        // One time domain transform, a placeholder.
        (0, 6),
        (0, 16),
        // One floor 1 with no partitions, multiplier 1, 4 range bits.
        (0, 6),
        (1, 16),
        (0, 5),
        (0, 2),
        (4, 4),
        // One residue 0 over nothing, one classification with no books.
        (0, 6),
        (0, 16),
        (0, 24),
        (0, 24),
        (0, 24),
        (0, 6),
        (0, 8),
        (0, 3),
        (0, 1),
        // One mapping 0: one submap, no coupling, floor 0, residue 0.
        (0, 6),
        (0, 16),
        (0, 1),
        (0, 1),
        (0, 2),
        (0, 8),
        (0, 8),
        (0, 8),
        // One mode on mapping 0, then the framing bit.
        (0, 6),
        (0, 1),
        (0, 16),
        (0, 16),
        (0, 8),
        (1, 1),
    ])
}

fn the_gap_input_reaches_the_comment_reader() {
    // The known gap's input, with a setup header the decoder accepts, so the decode thread pulls
    // packets and symphonia's Vorbis comment reader meets the forged comment the guard let by.
    let control = Arc::new(StreamControl::new());
    let comment = vorbis_comment(&[]);
    let setup = playable_setup();
    let bytes = chain_moved_on_after(&[&comment, &setup]);
    let body = seekable_body(&bytes, &control);
    let (_, end) = start(media(body, Some("ogg")), &control).finish();
    assert_eq!(end, DecodeEnd::Isolated(Fault::Memory));
}

#[test]
fn the_known_ogg_guard_gap_ends_the_item_in_the_helper() {
    isolated(the_gap_input_reaches_the_comment_reader);
}

// Decodes `bytes` in a helper with its guards off.
fn unguarded_end(bytes: &[u8], hint: &'static str) -> DecodeEnd {
    let control = Arc::new(StreamControl::new());
    let body = seekable_body(bytes, &control);
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let (tx, ended) = mpsc::channel();
    let handle = spawn_unguarded(media(body, Some(hint)), queue, move |end| {
        let _ = tx.send(end);
    })
    .unwrap();
    Running {
        reader,
        ended,
        handle,
    }
    .finish()
    .1
}

fn forged_sizes_end_at_the_memory_cap() {
    // A Vorbis comment claiming 256 MiB, complete on its page.
    let mut comment = evil_comment();
    comment.extend_from_slice(&[b'x'; 16]);
    let mut ogg = ogg_page(SERIAL, 0, FIRST, &[&vorbis_ident()], false);
    ogg.extend(ogg_page(SERIAL, 1, 0, &[&comment], false));
    ogg.extend(ogg_page(SERIAL, 2, 0, &[&[0u8; 10]], false));
    assert_eq!(
        unguarded_end(&ogg, "ogg"),
        DecodeEnd::Isolated(Fault::Memory)
    );

    // An esds whose decoder-specific info claims 256 MiB.
    let mut children = vec![0x04, 18, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    children.extend_from_slice(&[0x05, 0xFF, 0xFF, 0xFF, 0x7F]);
    children.extend_from_slice(&[0x06, 1, 2]);
    let mut esds = vec![0u8; 4];
    esds.extend_from_slice(&[0x03, (3 + children.len()) as u8, 0, 1, 0]);
    esds.extend(children);
    assert_eq!(
        unguarded_end(&mp4_with_esds(esds), "m4a"),
        DecodeEnd::Isolated(Fault::Memory)
    );
}

#[test]
fn forged_ogg_comment_and_esds_end_at_the_memory_cap_with_guards_off() {
    isolated(forged_sizes_end_at_the_memory_cap);
}

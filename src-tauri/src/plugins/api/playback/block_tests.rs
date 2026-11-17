// -- Library Imports --
use serde_json::json;

// -- Local Imports --
use crate::audio::{PlayerCmd, QueueTrack};
use crate::commands::player::resolve_with_blocks;
use crate::db;
use crate::plugins::api::library_rows::playlist_track_ids;
use crate::plugins::api::test_rig::{insert_track, mark_gone, Rig};
use crate::plugins::manifest::Capability;

fn rig() -> Rig {
    Rig::new(&[
        Capability::PlaybackRead,
        Capability::PlaybackControl,
        Capability::LibraryRead,
    ])
}

/// The one command sent, as its queued (id, mark) pairs and its start index.
fn sent(rig: &Rig) -> (Vec<(i64, Option<u64>)>, Option<usize>) {
    let mut sent = rig.sent();
    assert_eq!(sent.len(), 1, "one command");
    let pairs = |queue: &[QueueTrack]| queue.iter().map(|t| (t.id, t.block)).collect();
    match sent.remove(0) {
        PlayerCmd::Play { queue, index } => (pairs(&queue), Some(index)),
        PlayerCmd::Enqueue(queue) | PlayerCmd::InsertNext(queue) => (pairs(&queue), None),
        _ => panic!("not a queue change"),
    }
}

/// Loose `x`, an album entry of three members, loose `y`: in a playlist that keeps the album's order
/// and in one that does not. Returns ([x, a, b, c, y], kept list, unkept list).
fn stock(rig: &Rig) -> ([i64; 5], i64, i64) {
    let mut conn = rig.conn();
    let t: Vec<i64> = ["x", "a", "b", "c", "y"]
        .iter()
        .map(|n| insert_track(&conn, &format!("C:\\Music\\{n}.flac"), n, "A"))
        .collect();
    let album = db::create_album(
        &mut conn,
        None,
        None,
        None,
        None,
        None,
        &t[1..4],
        "album",
        1,
    )
    .unwrap()
    .id;
    let mut lists = [0, 0];
    for (list, keep) in lists.iter_mut().zip([true, false]) {
        *list = db::create_playlist(&conn, None, 1).unwrap().id;
        db::add_tracks_to_playlist(&mut conn, *list, &[t[0]], 1).unwrap();
        db::add_albums_to_playlist(&mut conn, *list, &[album], keep, 1).unwrap();
        db::add_tracks_to_playlist(&mut conn, *list, &[t[4]], 1).unwrap();
    }
    ([t[0], t[1], t[2], t[3], t[4]], lists[0], lists[1])
}

#[test]
fn a_kept_album_entry_reaches_the_player_as_a_block() {
    let rig = rig();
    let ([x, a, b, c, y], kept, unkept) = stock(&rig);
    let block = Some(0);
    let reply = rig
        .call("queue.play", json!({ "playlist_id": kept, "start": 2 }))
        .unwrap();
    assert_eq!(reply, json!({ "queued": 5 }));
    assert_eq!(
        sent(&rig),
        (
            vec![(x, None), (a, block), (b, block), (c, block), (y, None)],
            Some(2)
        )
    );
    for method in ["queue.add", "queue.play_next"] {
        rig.call(method, json!({ "playlist_id": kept })).unwrap();
        assert_eq!(
            sent(&rig).0,
            [(x, None), (a, block), (b, block), (c, block), (y, None)],
            "{method}"
        );
    }

    // An entry that does not keep its order, an album and a track list send no block.
    let album = db::membership_album(&rig.conn(), a).unwrap();
    for args in [
        json!({ "playlist_id": unkept }),
        json!({ "album_id": album }),
        json!({ "track_ids": [a, b, c] }),
    ] {
        rig.call("queue.add", args.clone()).unwrap();
        assert!(
            sent(&rig).0.iter().all(|(_, mark)| mark.is_none()),
            "{args}"
        );
    }

    // A missing member leaves the block and the count.
    mark_gone(&rig.conn(), b);
    let reply = rig
        .call("queue.play", json!({ "playlist_id": kept }))
        .unwrap();
    assert_eq!(reply, json!({ "queued": 4 }));
    assert_eq!(
        sent(&rig),
        (vec![(x, None), (a, block), (c, block), (y, None)], Some(0))
    );
}

#[test]
fn a_kept_entry_with_one_present_member_marks_that_track_alone() {
    let rig = rig();
    let ([x, a, b, c, y], kept, _) = stock(&rig);
    mark_gone(&rig.conn(), a);
    mark_gone(&rig.conn(), c);
    let reply = rig
        .call("queue.play", json!({ "playlist_id": kept }))
        .unwrap();
    assert_eq!(reply, json!({ "queued": 3 }));
    assert_eq!(
        sent(&rig),
        (vec![(x, None), (b, Some(0)), (y, None)], Some(0))
    );
}

#[test]
fn a_start_counts_the_present_tracks_of_the_expansion() {
    let rig = rig();
    let ([_, _, b, c, _], kept, _) = stock(&rig);
    mark_gone(&rig.conn(), b);
    // Present: x, a, c, y; start 2 is c.
    rig.call("queue.play", json!({ "playlist_id": kept, "start": 2 }))
        .unwrap();
    let (queue, index) = sent(&rig);
    assert_eq!(queue[index.unwrap()].0, c);
}

#[test]
fn a_row_deleted_after_the_read_moves_the_start_and_keeps_the_marks() {
    let rig = rig();
    let ([x, a, b, c, y], kept, _) = stock(&rig);
    // The playlist is read, then x is deleted before the queue resolves.
    let (ids, spans) = playlist_track_ids(&rig.conn(), kept).unwrap().unwrap();
    assert_eq!(
        (ids.clone(), spans.clone()),
        (vec![x, a, b, c, y], vec![[1, 3]])
    );
    rig.conn()
        .execute("DELETE FROM tracks WHERE id = ?1", [x])
        .unwrap();
    // Start 2 asks for b.
    let (queue, start) = resolve_with_blocks(&ids, Some(spans), 2, rig.state());
    let marks: Vec<(i64, Option<u64>)> = queue.iter().map(|t| (t.id, t.block)).collect();
    assert_eq!(marks, [(a, Some(0)), (b, Some(0)), (c, Some(0)), (y, None)]);
    assert_eq!(queue[start].id, b);
}

#[test]
fn playback_queue_reports_the_engine_blocks_over_its_ids() {
    let rig = rig();
    let ([x, a, b, ..], _, _) = stock(&rig);
    {
        let mut mirror = rig.state().player_queue.lock().unwrap();
        mirror.ids = vec![x, -4, a, b];
        mirror.blocks = vec![[2, 2]];
    }
    rig.state().player_status.lock().unwrap().queue_index = 3;
    let queue = rig.call("playback.queue", json!({})).unwrap();
    // A block index counts the null of a track played off disk.
    assert_eq!(
        queue,
        json!({
            "track_ids": [x, null, a, b],
            "index": 3,
            "blocks": [{ "start": 2, "length": 2 }],
        })
    );
}

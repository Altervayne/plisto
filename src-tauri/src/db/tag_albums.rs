/*
 * The albums-from-tags writer: files many groups of loose tracks into new or existing albums in one
 * transaction, and replays that exact write backwards (revert) and forwards (reapply) from its receipt.
 * Every check runs before the first write, so a rejected batch leaves the database untouched. Numbering
 * is per disc: a track's disc resolves from the edit layer over the raw scan, and positions run 1..k
 * within each disc. Only `albums` and `album_tracks` are written; tags and edits are never touched.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

// -- Local Imports --
use super::album_numbering::{disc_highest, number_per_disc, read_incoming, Incoming};
use super::{album_kind, insert_album_track, membership_album, WriteError, ALBUM_KIND};
use crate::dto::{
    TagAlbumCreated, TagAlbumExtended, TagAlbumPlan, TagAlbumReceipt, TagAlbumTarget,
};
use crate::normalize::clean_text;

/// Files each plan's tracks into its target in one transaction and returns what was written. `covers`
/// runs parallel to `plans` and holds each new album's pre-filled cover. The whole batch is rejected
/// with StaleProposal when a track is unknown, already filed, or named twice, a plan is empty, a new
/// album would hold only missing files, or an existing target is gone or not a plain album.
pub fn create_albums_from_tags(
    conn: &mut Connection,
    plans: &[TagAlbumPlan],
    covers: &[Option<i64>],
    now: i64,
) -> Result<TagAlbumReceipt, WriteError> {
    let tx = conn.transaction()?;

    let mut seen: HashSet<i64> = HashSet::new();
    let mut staged: Vec<Vec<Incoming>> = Vec::with_capacity(plans.len());
    for plan in plans {
        if plan.track_ids.is_empty() {
            return Err(WriteError::StaleProposal);
        }
        let mut tracks = Vec::with_capacity(plan.track_ids.len());
        for &track_id in &plan.track_ids {
            if !seen.insert(track_id) || membership_album(&tx, track_id)?.is_some() {
                return Err(WriteError::StaleProposal);
            }
            tracks.push(read_incoming(&tx, track_id)?.ok_or(WriteError::StaleProposal)?);
        }
        match &plan.target {
            TagAlbumTarget::New { .. } => {
                if !tracks.iter().any(|t| t.present) {
                    return Err(WriteError::StaleProposal);
                }
            }
            TagAlbumTarget::Existing { album_id } => {
                if album_kind(&tx, *album_id)?.as_deref() != Some(ALBUM_KIND) {
                    return Err(WriteError::StaleProposal);
                }
            }
        }
        staged.push(tracks);
    }

    let mut receipt = TagAlbumReceipt::default();
    for (i, (plan, tracks)) in plans.iter().zip(&staged).enumerate() {
        match &plan.target {
            TagAlbumTarget::New { fields } => {
                let title = clean_text(&fields.title);
                let album_artist = clean_text(&fields.album_artist);
                let genre = clean_text(&fields.genre);
                let cover_id = covers.get(i).copied().flatten();
                tx.execute(
                    "INSERT INTO albums (title, album_artist, year, genre, cover_id, kind, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![title, album_artist, fields.year, genre, cover_id, ALBUM_KIND, now],
                )?;
                let id = tx.last_insert_rowid();
                let members = number_per_disc(tracks, HashMap::new());
                for m in &members {
                    insert_album_track(&tx, id, m.track_id, m.track_no)?;
                }
                receipt.created.push(TagAlbumCreated {
                    id,
                    title,
                    album_artist,
                    year: fields.year,
                    genre,
                    cover_id,
                    kind: ALBUM_KIND.to_string(),
                    created_at: now,
                    updated_at: now,
                    members,
                });
            }
            TagAlbumTarget::Existing { album_id } => {
                // Read the disc tops after any earlier plan in this batch, so a second plan into the
                // same album continues from the first.
                let members = number_per_disc(tracks, disc_highest(&tx, *album_id)?);
                for m in &members {
                    insert_album_track(&tx, *album_id, m.track_id, m.track_no)?;
                }
                match receipt
                    .extended
                    .iter_mut()
                    .find(|e| e.album_id == *album_id)
                {
                    Some(entry) => entry.members.extend(members),
                    None => {
                        let prev_updated_at = album_updated_at(&tx, *album_id)?;
                        receipt.extended.push(TagAlbumExtended {
                            album_id: *album_id,
                            members,
                            prev_updated_at,
                            updated_at: now,
                        });
                    }
                }
                set_updated_at(&tx, *album_id, now)?;
            }
        }
    }

    tx.commit()?;
    Ok(receipt)
}

/// Undoes a batch from its receipt: deletes the albums it created and pulls the tracks it appended out
/// of existing albums, restoring their prior updated_at. Rejected with StaleProposal, nothing changed,
/// when a created album no longer holds exactly its receipt members or an appended track has moved.
pub fn revert_albums_from_tags(
    conn: &mut Connection,
    receipt: &TagAlbumReceipt,
) -> Result<(), WriteError> {
    let tx = conn.transaction()?;

    for album in &receipt.created {
        let mut held = member_ids(&tx, album.id)?;
        let mut expected: Vec<i64> = album.members.iter().map(|m| m.track_id).collect();
        held.sort_unstable();
        expected.sort_unstable();
        if album_kind(&tx, album.id)?.is_none() || held != expected {
            return Err(WriteError::StaleProposal);
        }
    }
    for entry in &receipt.extended {
        for m in &entry.members {
            if membership_album(&tx, m.track_id)? != Some(entry.album_id) {
                return Err(WriteError::StaleProposal);
            }
        }
    }

    for album in &receipt.created {
        tx.execute("DELETE FROM albums WHERE id = ?1", params![album.id])?;
    }
    for entry in &receipt.extended {
        for m in &entry.members {
            tx.execute(
                "DELETE FROM album_tracks WHERE album_id = ?1 AND track_id = ?2",
                params![entry.album_id, m.track_id],
            )?;
        }
        set_updated_at(&tx, entry.album_id, entry.prev_updated_at)?;
    }

    tx.commit()?;
    Ok(())
}

/// Redoes a reverted batch from its receipt: re-creates its albums under the same ids and stamps, and
/// re-appends its members at the same positions. Rejected with StaleProposal, nothing changed, when a
/// track is gone or filed again, a created id is taken, or an existing target is no longer a plain album.
pub fn reapply_albums_from_tags(
    conn: &mut Connection,
    receipt: &TagAlbumReceipt,
) -> Result<(), WriteError> {
    let tx = conn.transaction()?;

    let mut seen: HashSet<i64> = HashSet::new();
    let members = receipt
        .created
        .iter()
        .flat_map(|a| &a.members)
        .chain(receipt.extended.iter().flat_map(|e| &e.members));
    for m in members {
        if !seen.insert(m.track_id)
            || read_incoming(&tx, m.track_id)?.is_none()
            || membership_album(&tx, m.track_id)?.is_some()
        {
            return Err(WriteError::StaleProposal);
        }
    }
    for album in &receipt.created {
        if album_kind(&tx, album.id)?.is_some() {
            return Err(WriteError::StaleProposal);
        }
    }
    for entry in &receipt.extended {
        if album_kind(&tx, entry.album_id)?.as_deref() != Some(ALBUM_KIND) {
            return Err(WriteError::StaleProposal);
        }
    }

    for album in &receipt.created {
        tx.execute(
            "INSERT INTO albums (id, title, album_artist, year, genre, cover_id, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                album.id,
                album.title,
                album.album_artist,
                album.year,
                album.genre,
                album.cover_id,
                album.kind,
                album.created_at,
                album.updated_at,
            ],
        )?;
        for m in &album.members {
            insert_album_track(&tx, album.id, m.track_id, m.track_no)?;
        }
    }
    for entry in &receipt.extended {
        for m in &entry.members {
            insert_album_track(&tx, entry.album_id, m.track_id, m.track_no)?;
        }
        set_updated_at(&tx, entry.album_id, entry.updated_at)?;
    }

    tx.commit()?;
    Ok(())
}

/// Every member track id of an album, in no particular order.
fn member_ids(conn: &Connection, album_id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT track_id FROM album_tracks WHERE album_id = ?1")?;
    let rows = stmt
        .query_map(params![album_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(super) fn album_updated_at(conn: &Connection, album_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT updated_at FROM albums WHERE id = ?1",
        params![album_id],
        |r| r.get(0),
    )
}

pub(super) fn set_updated_at(
    conn: &Connection,
    album_id: i64,
    updated_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE albums SET updated_at = ?1 WHERE id = ?2",
        params![updated_at, album_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::dto::AlbumFields;

    // Inserts a loose track with the given disc and track number tags; `missing` flags its file gone.
    fn insert_track(
        conn: &Connection,
        path: &str,
        disc: Option<i64>,
        no: Option<i64>,
        missing: bool,
    ) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at,
                                 raw_disc_no, raw_track_no, missing_at)
             VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30, ?2, ?3, ?4)",
            params![path, disc, no, if missing { Some(40) } else { None }],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn fields(title: &str) -> AlbumFields {
        AlbumFields {
            title: Some(title.to_string()),
            album_artist: Some("Artist".to_string()),
            year: Some(2001),
            genre: Some("Rock".to_string()),
        }
    }

    fn new_plan(track_ids: &[i64], title: &str) -> TagAlbumPlan {
        TagAlbumPlan {
            track_ids: track_ids.to_vec(),
            target: TagAlbumTarget::New {
                fields: fields(title),
            },
        }
    }

    fn existing_plan(track_ids: &[i64], album_id: i64) -> TagAlbumPlan {
        TagAlbumPlan {
            track_ids: track_ids.to_vec(),
            target: TagAlbumTarget::Existing { album_id },
        }
    }

    // (album_id, track_id, track_no) for every membership row, ordered for comparison.
    fn memberships(conn: &Connection) -> Vec<(i64, i64, Option<i64>)> {
        let mut stmt = conn
            .prepare(
                "SELECT album_id, track_id, track_no FROM album_tracks ORDER BY album_id, track_id",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    // Every album row as a comparable tuple, including the stamps.
    #[allow(clippy::type_complexity)]
    fn album_rows(
        conn: &Connection,
    ) -> Vec<(
        i64,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        String,
        i64,
        i64,
    )> {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, album_artist, year, genre, kind, created_at, updated_at
                 FROM albums ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    }

    fn edit_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM track_edits", [], |r| r.get(0))
            .unwrap()
    }

    fn stale<T: std::fmt::Debug>(result: Result<T, WriteError>) -> bool {
        matches!(result, Err(WriteError::StaleProposal))
    }

    #[test]
    fn new_album_numbers_each_disc_from_one_and_writes_no_edits() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", Some(1), Some(1), false);
        let b = insert_track(&conn, "/m/a/2.mp3", Some(1), Some(2), false);
        let c = insert_track(&conn, "/m/b/1.mp3", Some(2), Some(1), false);
        let d = insert_track(&conn, "/m/b/2.mp3", Some(2), Some(2), false);
        let e = insert_track(&conn, "/m/b/3.mp3", Some(2), Some(3), false);

        let receipt =
            create_albums_from_tags(&mut conn, &[new_plan(&[a, b, c, d, e], "T")], &[None], 100)
                .unwrap();

        let id = receipt.created[0].id;
        assert_eq!(
            memberships(&conn),
            vec![
                (id, a, Some(1)),
                (id, b, Some(2)),
                (id, c, Some(1)),
                (id, d, Some(2)),
                (id, e, Some(3)),
            ],
        );
        assert_eq!(edit_rows(&conn), 0, "numbering never writes the edit layer");
        let album = db::get_album(&conn, id).unwrap().unwrap();
        assert_eq!(album.kind, "album");
        assert_eq!(album.updated_at, 100);
    }

    #[test]
    fn existing_target_appends_per_disc_without_renumbering() {
        let mut conn = db::open_in_memory().unwrap();
        let one = insert_track(&conn, "/m/x/1.mp3", Some(1), Some(1), false);
        let two = insert_track(&conn, "/m/x/2.mp3", Some(1), Some(2), false);
        let three = insert_track(&conn, "/m/x/3.mp3", Some(2), Some(1), false);
        let album = db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[one, two],
            "album",
            5,
        )
        .unwrap();
        // The disc-2 member sits at position 7 on its disc.
        db::add_tracks_to_album(&mut conn, album.id, &[three]).unwrap();
        conn.execute(
            "UPDATE album_tracks SET track_no = 7 WHERE track_id = ?1",
            params![three],
        )
        .unwrap();
        conn.execute(
            "UPDATE albums SET updated_at = 5 WHERE id = ?1",
            params![album.id],
        )
        .unwrap();

        let d1 = insert_track(&conn, "/m/y/1.mp3", Some(1), Some(3), false);
        let d2 = insert_track(&conn, "/m/y/2.mp3", Some(2), Some(8), false);
        let d3 = insert_track(&conn, "/m/y/3.mp3", Some(3), Some(1), false);
        let receipt = create_albums_from_tags(
            &mut conn,
            &[existing_plan(&[d1, d2, d3], album.id)],
            &[None],
            100,
        )
        .unwrap();

        let rows = memberships(&conn);
        assert!(rows.contains(&(album.id, one, Some(1))));
        assert!(rows.contains(&(album.id, two, Some(2))));
        assert!(rows.contains(&(album.id, three, Some(7))));
        assert!(rows.contains(&(album.id, d1, Some(3))));
        assert!(rows.contains(&(album.id, d2, Some(8))));
        assert!(rows.contains(&(album.id, d3, Some(1))));
        assert_eq!(receipt.extended[0].prev_updated_at, 5);
        assert_eq!(receipt.extended[0].updated_at, 100);
        assert_eq!(
            db::get_album(&conn, album.id).unwrap().unwrap().updated_at,
            100
        );
    }

    #[test]
    fn a_filed_track_in_a_later_plan_rejects_the_whole_batch() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", None, Some(1), false);
        let b = insert_track(&conn, "/m/b/1.mp3", None, Some(1), false);
        let filed = insert_track(&conn, "/m/c/1.mp3", None, Some(1), false);
        db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[filed],
            "album",
            1,
        )
        .unwrap();
        let albums_before = album_rows(&conn);
        let members_before = memberships(&conn);

        let result = create_albums_from_tags(
            &mut conn,
            &[
                new_plan(&[a], "A"),
                new_plan(&[b], "B"),
                new_plan(&[filed], "C"),
            ],
            &[None, None, None],
            100,
        );

        assert!(stale(result));
        assert_eq!(album_rows(&conn), albums_before);
        assert_eq!(memberships(&conn), members_before);
    }

    #[test]
    fn a_track_named_in_two_plans_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", None, Some(1), false);
        let b = insert_track(&conn, "/m/a/2.mp3", None, Some(2), false);

        let result = create_albums_from_tags(
            &mut conn,
            &[new_plan(&[a, b], "A"), new_plan(&[b], "B")],
            &[None, None],
            100,
        );

        assert!(stale(result));
        assert!(album_rows(&conn).is_empty());
    }

    #[test]
    fn an_empty_plan_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", None, Some(1), false);

        let result = create_albums_from_tags(
            &mut conn,
            &[new_plan(&[a], "A"), new_plan(&[], "B")],
            &[None, None],
            100,
        );

        assert!(stale(result));
        assert!(album_rows(&conn).is_empty());
    }

    #[test]
    fn a_new_album_of_only_missing_files_is_rejected_but_a_mixed_one_keeps_its_missing_track() {
        let mut conn = db::open_in_memory().unwrap();
        let gone = insert_track(&conn, "/m/a/1.mp3", None, Some(1), true);
        let result = create_albums_from_tags(&mut conn, &[new_plan(&[gone], "A")], &[None], 100);
        assert!(stale(result));
        assert!(album_rows(&conn).is_empty());

        let here = insert_track(&conn, "/m/a/2.mp3", None, Some(2), false);
        let receipt =
            create_albums_from_tags(&mut conn, &[new_plan(&[gone, here], "A")], &[None], 100)
                .unwrap();
        let id = receipt.created[0].id;
        assert_eq!(
            memberships(&conn),
            vec![(id, gone, Some(1)), (id, here, Some(2))]
        );
    }

    #[test]
    fn a_single_as_existing_target_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let hit = insert_track(&conn, "/m/s/1.mp3", None, Some(1), false);
        let single = db::create_single(&mut conn, hit, 1).unwrap();
        let loose = insert_track(&conn, "/m/a/1.mp3", None, Some(1), false);

        let result = create_albums_from_tags(
            &mut conn,
            &[existing_plan(&[loose], single.id)],
            &[None],
            100,
        );

        assert!(stale(result));
        assert_eq!(db::membership_album(&conn, loose).unwrap(), None);
    }

    #[test]
    fn create_revert_reapply_restores_the_same_ids_rows_and_memberships() {
        let mut conn = db::open_in_memory().unwrap();
        let owner = insert_track(&conn, "/m/x/1.mp3", None, Some(1), false);
        let album = db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[owner],
            "album",
            1,
        )
        .unwrap();
        conn.execute(
            "UPDATE albums SET updated_at = 5 WHERE id = ?1",
            params![album.id],
        )
        .unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", Some(1), Some(1), false);
        let b = insert_track(&conn, "/m/a/2.mp3", Some(2), Some(1), false);
        let c = insert_track(&conn, "/m/c/2.mp3", None, Some(2), false);
        let before_albums = album_rows(&conn);
        let before_members = memberships(&conn);

        let receipt = create_albums_from_tags(
            &mut conn,
            &[new_plan(&[a, b], "A"), existing_plan(&[c], album.id)],
            &[None, None],
            100,
        )
        .unwrap();
        let created_albums = album_rows(&conn);
        let created_members = memberships(&conn);

        revert_albums_from_tags(&mut conn, &receipt).unwrap();
        assert_eq!(album_rows(&conn), before_albums);
        assert_eq!(memberships(&conn), before_members);

        reapply_albums_from_tags(&mut conn, &receipt).unwrap();
        assert_eq!(album_rows(&conn), created_albums);
        assert_eq!(memberships(&conn), created_members);
    }

    #[test]
    fn revert_after_a_member_moved_out_changes_nothing() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", None, Some(1), false);
        let b = insert_track(&conn, "/m/a/2.mp3", None, Some(2), false);
        let receipt =
            create_albums_from_tags(&mut conn, &[new_plan(&[a, b], "A")], &[None], 100).unwrap();
        let elsewhere =
            db::create_album(&mut conn, None, None, None, None, None, &[], "album", 1).unwrap();
        db::add_tracks_to_album(&mut conn, elsewhere.id, &[b]).unwrap();
        let albums_before = album_rows(&conn);
        let members_before = memberships(&conn);

        assert!(stale(revert_albums_from_tags(&mut conn, &receipt)));
        assert_eq!(album_rows(&conn), albums_before);
        assert_eq!(memberships(&conn), members_before);
    }

    #[test]
    fn plans_deserialize_from_the_kind_tagged_wire_shape() {
        let plans: Vec<TagAlbumPlan> = serde_json::from_str(
            r#"[
                {"track_ids": [1], "target": {"kind": "new", "fields":
                    {"title": "T", "album_artist": null, "year": null, "genre": null}}},
                {"track_ids": [2], "target": {"kind": "existing", "album_id": 7}}
            ]"#,
        )
        .unwrap();
        assert!(matches!(plans[0].target, TagAlbumTarget::New { .. }));
        assert!(matches!(
            plans[1].target,
            TagAlbumTarget::Existing { album_id: 7 }
        ));
    }

    #[test]
    fn blank_fields_land_as_null_never_empty_strings() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a/1.mp3", None, Some(1), false);
        let plan = TagAlbumPlan {
            track_ids: vec![a],
            target: TagAlbumTarget::New {
                fields: AlbumFields {
                    title: Some("  Blue  ".to_string()),
                    album_artist: Some("   ".to_string()),
                    year: None,
                    genre: Some(String::new()),
                },
            },
        };

        let receipt = create_albums_from_tags(&mut conn, &[plan], &[None], 100).unwrap();

        let album = db::get_album(&conn, receipt.created[0].id)
            .unwrap()
            .unwrap();
        assert_eq!(album.title.as_deref(), Some("Blue"));
        assert_eq!(album.album_artist, None);
        assert_eq!(album.genre, None);
        let blanks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM albums WHERE title = '' OR album_artist = '' OR genre = ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blanks, 0);
    }
}

/*
 * The rows a restore writes, rebuilt from a point and its track map. Album, playlist, slot and genre
 * ids stay as the point holds them, so album entries and slot ties keep their meaning; track ids become
 * the live ids they matched, and cover ids the live cover with the same content hash, else NULL. When
 * several point tracks matched one live track, that track keeps the membership first by (album id,
 * track number, point id), the edits, cover and visualizer of the lowest point id, the union of their
 * genres, and every playlist slot. An album left with no member is not recreated unless the point held
 * it empty. Pure.
 */

// -- Library Imports --
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::types::Value;

// -- Local Imports --
use super::format::{DataTable, DATA_TABLES};
use super::load::{int, PointData, Rows};
use super::matching::TrackMap;
use crate::db::{ALBUM_KIND, SINGLE_KIND};
use crate::dto::{RestoreSummary, UnmatchedGroup, UnmatchedKind};

/// The rows to insert per captured table, in `DATA_TABLES` order, and what they amount to.
/// `summary.cleared_tracks` is left at zero: it depends on the library, not the point.
pub(super) struct Rebuilt {
    pub tables: Vec<(&'static DataTable, Vec<Vec<Value>>)>,
    pub summary: RestoreSummary,
}

/// Rebuilds every captured table of `point` against the library. `live_covers` maps a content hash to
/// the live cover id.
pub(super) fn rebuild(
    point: &PointData,
    map: &TrackMap,
    live_covers: &HashMap<String, i64>,
) -> Rebuilt {
    let remap = Remap {
        point,
        map,
        live_covers,
    };
    let mut summary = RestoreSummary {
        unmatched_tracks: map.unmatched.len() as i64,
        ..RestoreSummary::default()
    };

    let (members, collapsed) = remap.memberships();
    summary.collapsed = collapsed;
    summary.filed_tracks = members.len() as i64;
    let (albums, not_recreated) = remap.albums(&members);
    summary.albums_not_recreated = not_recreated.len() as i64;
    summary.albums = count_kind(point.table("albums"), &albums, ALBUM_KIND);
    summary.singles = count_kind(point.table("albums"), &albums, SINGLE_KIND);
    let playlists = remap.with_covers(point.table("playlists"));
    summary.playlists = playlists.len() as i64;
    let (slots, dropped) = remap.slots(&not_recreated);
    summary.dropped_entries = dropped;
    let covers: Vec<Vec<Value>> = {
        let rows = point.table("track_covers");
        let cover = rows.col("cover_id");
        remap
            .first_wins(rows)
            .into_iter()
            .filter_map(|mut row| {
                row[cover] = remap.cover(&row[cover]);
                (row[cover] != Value::Null).then_some(row)
            })
            .collect()
    };

    let mut built: HashMap<&str, Vec<Vec<Value>>> = HashMap::from([
        ("albums", albums),
        ("album_tracks", members),
        ("playlists", playlists),
        ("playlist_tracks", slots),
        ("track_edits", remap.first_wins(point.table("track_edits"))),
        ("genres", point.table("genres").rows.clone()),
        ("track_genres", remap.genres()),
        ("track_covers", covers),
        ("track_visualizers", remap.first_wins(point.table("track_visualizers"))),
    ]);
    let tables = DATA_TABLES
        .iter()
        .map(|t| {
            let rows = built
                .remove(t.name)
                .unwrap_or_else(|| panic!("{} is rebuilt", t.name));
            (t, rows)
        })
        .collect();
    summary.unmatched = unmatched_groups(point, map);
    Rebuilt { tables, summary }
}

struct Remap<'a> {
    point: &'a PointData,
    map: &'a TrackMap,
    live_covers: &'a HashMap<String, i64>,
}

impl Remap<'_> {
    fn live(&self, track: &Value) -> Option<i64> {
        int(track).and_then(|id| self.map.matched.get(&id).copied())
    }

    fn cover(&self, cover: &Value) -> Value {
        int(cover)
            .and_then(|id| self.point.covers.get(&id))
            .and_then(|hash| self.live_covers.get(hash))
            .map_or(Value::Null, |&id| Value::Integer(id))
    }

    // Album membership of matched tracks, one per live track, and how many memberships lost out.
    fn memberships(&self) -> (Vec<Vec<Value>>, i64) {
        let rows = self.point.table("album_tracks");
        let (album, track, no) = (rows.col("album_id"), rows.col("track_id"), rows.col("track_no"));
        let mut by_live: BTreeMap<i64, Vec<&Vec<Value>>> = BTreeMap::new();
        for row in &rows.rows {
            if let Some(live) = self.live(&row[track]) {
                by_live.entry(live).or_default().push(row);
            }
        }
        let mut collapsed = 0;
        let mut kept: Vec<Vec<Value>> = by_live
            .into_iter()
            .map(|(live, candidates)| {
                collapsed += candidates.len() as i64 - 1;
                let first = candidates
                    .into_iter()
                    .min_by_key(|r| (int(&r[album]), int(&r[no]), int(&r[track])))
                    .expect("every entry holds a candidate");
                let mut row = first.clone();
                row[track] = Value::Integer(live);
                row
            })
            .collect();
        kept.sort_by_key(|r| (int(&r[album]), int(&r[track])));
        (kept, collapsed)
    }

    // The albums to recreate, and the ids of those that had members and kept none.
    fn albums(&self, members: &[Vec<Value>]) -> (Vec<Vec<Value>>, BTreeSet<i64>) {
        let point_members = self.point.table("album_tracks");
        let member_album = point_members.col("album_id");
        let had: HashSet<i64> = point_members
            .rows
            .iter()
            .filter_map(|r| int(&r[member_album]))
            .collect();
        let kept: HashSet<i64> = members.iter().filter_map(|r| int(&r[member_album])).collect();
        let rows = self.point.table("albums");
        let id = rows.col("id");
        let mut not_recreated = BTreeSet::new();
        let mut albums = Vec::new();
        for row in self.with_covers(rows) {
            let Some(album) = int(&row[id]) else {
                continue;
            };
            if had.contains(&album) && !kept.contains(&album) {
                not_recreated.insert(album);
            } else {
                albums.push(row);
            }
        }
        (albums, not_recreated)
    }

    // Every row of `rows` with its `cover_id` re-found by content hash.
    fn with_covers(&self, rows: &Rows) -> Vec<Vec<Value>> {
        let cover = rows.col("cover_id");
        rows.rows
            .iter()
            .map(|row| {
                let mut row = row.clone();
                row[cover] = self.cover(&row[cover]);
                row
            })
            .collect()
    }

    // Playlist slots: a track slot of a matched track, an album entry of a recreated album. Returns the
    // album entries dropped with their album.
    fn slots(&self, not_recreated: &BTreeSet<i64>) -> (Vec<Vec<Value>>, i64) {
        let rows = self.point.table("playlist_tracks");
        let (track, album) = (rows.col("track_id"), rows.col("album_id"));
        let mut dropped = 0;
        let mut slots = Vec::new();
        for row in &rows.rows {
            if row[track] != Value::Null {
                if let Some(live) = self.live(&row[track]) {
                    let mut row = row.clone();
                    row[track] = Value::Integer(live);
                    slots.push(row);
                }
            } else if int(&row[album]).is_some_and(|a| not_recreated.contains(&a)) {
                dropped += 1;
            } else {
                slots.push(row.clone());
            }
        }
        (slots, dropped)
    }

    // A table keyed on the track: per live track, the row of the lowest point id.
    fn first_wins(&self, rows: &Rows) -> Vec<Vec<Value>> {
        let track = rows.col("track_id");
        let mut by_live: BTreeMap<i64, (i64, &Vec<Value>)> = BTreeMap::new();
        for row in &rows.rows {
            let (Some(point_id), Some(live)) = (int(&row[track]), self.live(&row[track])) else {
                continue;
            };
            let slot = by_live.entry(live).or_insert((point_id, row));
            if point_id < slot.0 {
                *slot = (point_id, row);
            }
        }
        by_live
            .into_iter()
            .map(|(live, (_, row))| {
                let mut row = row.clone();
                row[track] = Value::Integer(live);
                row
            })
            .collect()
    }

    // Genres per live track: one point track's rows as they are, several point tracks' unioned in
    // point id then position order and numbered from 1.
    fn genres(&self) -> Vec<Vec<Value>> {
        let rows = self.point.table("track_genres");
        let (track, genre, position) = (rows.col("track_id"), rows.col("genre_id"), rows.col("position"));
        let mut by_live: BTreeMap<i64, Vec<&Vec<Value>>> = BTreeMap::new();
        for row in &rows.rows {
            if let Some(live) = self.live(&row[track]) {
                by_live.entry(live).or_default().push(row);
            }
        }
        let mut out = Vec::new();
        for (live, mut tagged) in by_live {
            let sources: HashSet<Option<i64>> = tagged.iter().map(|r| int(&r[track])).collect();
            if sources.len() == 1 {
                for row in tagged {
                    let mut row = row.clone();
                    row[track] = Value::Integer(live);
                    out.push(row);
                }
                continue;
            }
            tagged.sort_by_key(|r| (int(&r[track]), int(&r[position]), int(&r[genre])));
            let mut seen = HashSet::new();
            for row in tagged {
                if !seen.insert(int(&row[genre])) {
                    continue;
                }
                let mut row = row.clone();
                row[track] = Value::Integer(live);
                row[position] = Value::Integer(seen.len() as i64);
                out.push(row);
            }
        }
        out
    }
}

fn count_kind(albums: &Rows, rows: &[Vec<Value>], kind: &str) -> i64 {
    let at = albums.col("kind");
    rows.iter()
        .filter(|r| matches!(&r[at], Value::Text(t) if t == kind))
        .count() as i64
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::Text(t) => Some(t.clone()),
        _ => None,
    }
}

// The unmatched tracks' real-case paths per album and single (by track number), per playlist (by
// slot order, each path once), then those in neither.
fn unmatched_groups(point: &PointData, map: &TrackMap) -> Vec<UnmatchedGroup> {
    if map.unmatched.is_empty() {
        return Vec::new();
    }
    let paths: HashMap<i64, &str> = point
        .tracks
        .iter()
        .map(|t| (t.id, t.display.as_str()))
        .collect();
    let path_of = |id: i64| paths.get(&id).map_or_else(String::new, |p| p.to_string());
    let mut placed: HashSet<i64> = HashSet::new();
    let mut groups = Vec::new();

    let members = point.table("album_tracks");
    let (m_album, m_track, m_no) = (members.col("album_id"), members.col("track_id"), members.col("track_no"));
    let albums = point.table("albums");
    let (a_id, a_title, a_kind) = (albums.col("id"), albums.col("title"), albums.col("kind"));
    for album in &albums.rows {
        let id = int(&album[a_id]);
        let mut lost: Vec<(Option<i64>, i64)> = members
            .rows
            .iter()
            .filter(|r| int(&r[m_album]) == id)
            .filter_map(|r| int(&r[m_track]).map(|t| (int(&r[m_no]), t)))
            .filter(|(_, t)| map.unmatched.contains(t))
            .collect();
        if lost.is_empty() {
            continue;
        }
        lost.sort();
        placed.extend(lost.iter().map(|(_, t)| *t));
        let kind = match &album[a_kind] {
            Value::Text(k) if k == SINGLE_KIND => UnmatchedKind::Single,
            _ => UnmatchedKind::Album,
        };
        groups.push(UnmatchedGroup {
            kind,
            id,
            title: text(&album[a_title]),
            paths: lost.into_iter().map(|(_, t)| path_of(t)).collect(),
        });
    }

    let slots = point.table("playlist_tracks");
    let (s_id, s_playlist, s_track, s_position) = (
        slots.col("id"),
        slots.col("playlist_id"),
        slots.col("track_id"),
        slots.col("position"),
    );
    let playlists = point.table("playlists");
    let (p_id, p_name) = (playlists.col("id"), playlists.col("name"));
    for playlist in &playlists.rows {
        let id = int(&playlist[p_id]);
        let mut lost: Vec<(Option<i64>, Option<i64>, i64)> = slots
            .rows
            .iter()
            .filter(|r| int(&r[s_playlist]) == id)
            .filter_map(|r| int(&r[s_track]).map(|t| (int(&r[s_position]), int(&r[s_id]), t)))
            .filter(|(_, _, t)| map.unmatched.contains(t))
            .collect();
        if lost.is_empty() {
            continue;
        }
        lost.sort();
        let mut seen = HashSet::new();
        lost.retain(|(_, _, t)| seen.insert(*t));
        placed.extend(lost.iter().map(|(_, _, t)| *t));
        groups.push(UnmatchedGroup {
            kind: UnmatchedKind::Playlist,
            id,
            title: text(&playlist[p_name]),
            paths: lost.into_iter().map(|(_, _, t)| path_of(t)).collect(),
        });
    }

    let mut rest: Vec<String> = map
        .unmatched
        .iter()
        .filter(|t| !placed.contains(t))
        .map(|&t| path_of(t))
        .collect();
    if !rest.is_empty() {
        rest.sort();
        groups.push(UnmatchedGroup {
            kind: UnmatchedKind::Other,
            id: None,
            title: None,
            paths: rest,
        });
    }
    groups
}

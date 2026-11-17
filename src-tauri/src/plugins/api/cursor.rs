/*
 * Keyset paging for the `library.*` lists. A page is ordered by a sort key, then by a row id that
 * breaks ties, so a row added or removed between two calls never shifts the rows of the next page.
 * The cursor names the last row returned: `v1:<scope>:<sort>:<key>:<id>`. The scope names the list and,
 * for an album or playlist, its id; the key is hex-encoded for a text sort, decimal for a numeric one
 * and empty when the sort is the id itself. It carries no path and is checked against the scope and
 * sort it is used with; anything that does not parse or does not match is `invalid_args`.
 *
 * A playlist's tracks page by a composite key (see `Key::Composite`), so a page can end inside an album
 * entry. Its key is digits only and of one fixed width no integer key reaches, so a cursor made before
 * the composite key existed (an integer key naming a slot) still reads, and continues after that slot.
 */

// -- Library Imports --
use rusqlite::types::Value as SqlValue;
use serde_json::{Map, Value};

// -- Local Imports --
use super::error::ApiError;

pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 200;
const MAX_CURSOR_BYTES: usize = 1024;
const VERSION: &str = "v1";

// The zero-padded widths of a composite key's parts: any non-negative i64 for the position and the
// slot id, and 11 digits for the member key, whose largest value is 99999999999.
const COMPOSITE_WIDTHS: [usize; 3] = [19, 19, 11];
/// The length of a composite key, past the 19 digits of any integer key.
pub const COMPOSITE_DIGITS: usize = 49;

/// How a sort orders its rows: by the id alone, by an integer or text key and then the id, or by a
/// composite key and then the id. A composite sort pages in memory through `follows`, never in SQL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    Id,
    Int,
    Text,
    Composite,
}

/// One sort a list offers: its wire name, the SQL of its key and of its tie-breaking id. Text keys
/// must never be NULL, so the SQL coalesces them.
#[derive(Clone, Copy, Debug)]
pub struct Sort {
    pub name: &'static str,
    pub kind: KeyKind,
    pub key_sql: &'static str,
    pub id_sql: &'static str,
}

/// A row's position in a sort.
#[derive(Clone, Debug, PartialEq)]
pub enum Key {
    None,
    Int(i64),
    Text(String),
    /// A row of a playlist's expanded order: its slot's position, the slot id and the member key, with
    /// the track id as the cursor's id. Never negative.
    Composite([i64; 3]),
}

/// The last row of a page.
#[derive(Clone, Debug, PartialEq)]
pub struct Cursor {
    pub key: Key,
    pub id: i64,
}

/// A page request: the sort, where to start and how many rows.
#[derive(Clone, Debug)]
pub struct PageArgs {
    /// The list the page belongs to; see the file header.
    pub scope: String,
    pub sort: Sort,
    pub after: Option<Cursor>,
    pub limit: usize,
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<String> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

pub fn encode(scope: &str, sort: &Sort, cursor: &Cursor) -> String {
    let key = match &cursor.key {
        Key::None => String::new(),
        Key::Int(n) => n.to_string(),
        Key::Text(text) => hex(text),
        Key::Composite([position, slot, member]) => {
            format!("{position:019}{slot:019}{member:011}")
        }
    };
    format!("{VERSION}:{scope}:{}:{key}:{}", sort.name, cursor.id)
}

/// Reads a composite key: exactly `COMPOSITE_DIGITS` ASCII digits, each part within an i64.
fn composite_key(text: &str) -> Option<Key> {
    if text.len() != COMPOSITE_DIGITS || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut parts = [0i64; 3];
    let mut at = 0;
    for (part, width) in parts.iter_mut().zip(COMPOSITE_WIDTHS) {
        *part = text.get(at..at + width)?.parse().ok()?;
        at += width;
    }
    Some(Key::Composite(parts))
}

/// Reads a cursor made by `encode` for the same scope and sort.
pub fn decode(scope: &str, sort: &Sort, text: &str) -> Result<Cursor, ApiError> {
    let invalid = || ApiError::invalid_args("'cursor' is not a cursor of this list and sort.");
    if text.len() > MAX_CURSOR_BYTES {
        return Err(invalid());
    }
    let parts: Vec<&str> = text.split(':').collect();
    let [version, cursor_scope, name, key, id] = parts.as_slice() else {
        return Err(invalid());
    };
    if *version != VERSION || *cursor_scope != scope || *name != sort.name {
        return Err(invalid());
    }
    let id = id.parse::<i64>().map_err(|_| invalid())?;
    let key = match sort.kind {
        KeyKind::Id if key.is_empty() => Key::None,
        KeyKind::Int => Key::Int(key.parse::<i64>().map_err(|_| invalid())?),
        KeyKind::Text => Key::Text(unhex(key).ok_or_else(invalid)?),
        // Anything but a composite key reads as an integer key whose id is a slot id.
        KeyKind::Composite => composite_key(key)
            .or_else(|| key.parse::<i64>().ok().map(Key::Int))
            .ok_or_else(invalid)?,
        KeyKind::Id => return Err(invalid()),
    };
    Ok(Cursor { key, id })
}

/// Whether `row`, a row of a composite sort, comes after `after`. A composite cursor names one row; an
/// integer cursor names a whole slot by its position and slot id, so every row of that slot is behind it.
pub fn follows(after: Option<&Cursor>, row: &Cursor) -> bool {
    let Key::Composite(place) = &row.key else {
        return false;
    };
    match after.map(|c| (&c.key, c.id)) {
        None => true,
        Some((Key::Composite(last), id)) => (place, row.id) > (last, id),
        Some((Key::Int(position), slot)) => (place[0], place[1]) > (*position, slot),
        Some((Key::None | Key::Text(_), _)) => false,
    }
}

/// Reads `sort`, `cursor` and `limit` for the list named `scope`. `sort` must name one of `sorts`;
/// absent, the first applies.
pub fn page_args(
    args: &Map<String, Value>,
    sorts: &[Sort],
    scope: &str,
) -> Result<PageArgs, ApiError> {
    let sort = match args.get("sort") {
        None | Some(Value::Null) => sorts[0],
        Some(Value::String(name)) => *sorts
            .iter()
            .find(|s| s.name == name)
            .ok_or_else(|| ApiError::invalid_args("'sort' is not a sort this list offers."))?,
        Some(_) => return Err(ApiError::invalid_args("'sort' must be a string.")),
    };
    let after = match args.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(decode(scope, &sort, text)?),
        Some(_) => return Err(ApiError::invalid_args("'cursor' must be a string or null.")),
    };
    let limit = match args.get("limit") {
        None | Some(Value::Null) => DEFAULT_LIMIT,
        Some(value) => match value.as_u64() {
            Some(n) if (1..=MAX_LIMIT as u64).contains(&n) => n as usize,
            _ => {
                return Err(ApiError::invalid_args(
                    "'limit' must be an integer from 1 to 200.",
                ))
            }
        },
    };
    Ok(PageArgs {
        scope: scope.to_string(),
        sort,
        after,
        limit,
    })
}

/// The `WHERE` term that starts a page after `after`, with its parameters; empty on the first page.
pub fn after_clause(sort: &Sort, after: Option<&Cursor>) -> (String, Vec<SqlValue>) {
    let Some(cursor) = after else {
        return (String::new(), Vec::new());
    };
    let (key, id) = (sort.key_sql, sort.id_sql);
    let id_value = SqlValue::Integer(cursor.id);
    match &cursor.key {
        Key::None => (format!(" AND {id} > ?"), vec![id_value]),
        Key::Int(n) => (
            format!(" AND ({key} > ? OR ({key} = ? AND {id} > ?))"),
            vec![SqlValue::Integer(*n), SqlValue::Integer(*n), id_value],
        ),
        Key::Text(text) => (
            format!(" AND ({key} > ? OR ({key} = ? AND {id} > ?))"),
            vec![
                SqlValue::Text(text.clone()),
                SqlValue::Text(text.clone()),
                id_value,
            ],
        ),
        Key::Composite(_) => unreachable!("a composite key pages in memory through follows"),
    }
}

/// The `ORDER BY` and `LIMIT` of a page, one row past `limit` so the caller knows if more follow.
pub fn order_clause(page: &PageArgs) -> String {
    let sort = &page.sort;
    match sort.kind {
        KeyKind::Id => format!(" ORDER BY {} LIMIT {}", sort.id_sql, page.limit + 1),
        _ => format!(
            " ORDER BY {}, {} LIMIT {}",
            sort.key_sql,
            sort.id_sql,
            page.limit + 1
        ),
    }
}

/// The key of a row as read back from the column holding `sort.key_sql`.
pub fn key_from(sort: &Sort, row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Key> {
    Ok(match sort.kind {
        KeyKind::Id => Key::None,
        KeyKind::Int => Key::Int(row.get(index)?),
        KeyKind::Text => Key::Text(row.get(index)?),
        KeyKind::Composite => unreachable!("a composite key pages in memory through follows"),
    })
}

/// Cuts a fetched page to `limit` and builds the cursor of its last row when more rows follow.
pub fn finish_page<T>(page: &PageArgs, mut rows: Vec<(T, Cursor)>) -> (Vec<T>, Option<String>) {
    let more = rows.len() > page.limit;
    rows.truncate(page.limit);
    let next = if more {
        rows.last()
            .map(|(_, cursor)| encode(&page.scope, &page.sort, cursor))
    } else {
        None
    };
    (rows.into_iter().map(|(item, _)| item).collect(), next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use serde_json::json;

    const BY_ID: Sort = Sort {
        name: "id",
        kind: KeyKind::Id,
        key_sql: "",
        id_sql: "t.id",
    };
    const BY_TITLE: Sort = Sort {
        name: "title",
        kind: KeyKind::Text,
        key_sql: "k",
        id_sql: "t.id",
    };
    const BY_POSITION: Sort = Sort {
        name: "position",
        kind: KeyKind::Int,
        key_sql: "p",
        id_sql: "pt.id",
    };

    fn args(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("arguments must be an object"),
        }
    }

    #[test]
    fn a_cursor_round_trips_for_each_key_kind() {
        let cases = [
            (BY_ID, Key::None),
            (BY_POSITION, Key::Int(-3)),
            (BY_TITLE, Key::Text("a:b \u{e9}".into())),
            (BY_TITLE, Key::Text(String::new())),
        ];
        for (sort, key) in cases {
            let cursor = Cursor { key, id: 42 };
            let text = encode("tracks", &sort, &cursor);
            assert!(text.is_ascii() && text.starts_with("v1:tracks:"), "{text}");
            assert_eq!(text.split(':').count(), 5, "{text}");
            assert_eq!(decode("tracks", &sort, &text), Ok(cursor));
        }
        assert_eq!(
            encode(
                "tracks",
                &BY_ID,
                &Cursor {
                    key: Key::None,
                    id: 7
                }
            ),
            "v1:tracks:id::7"
        );
    }

    #[test]
    fn a_tampered_cursor_is_invalid() {
        let good = encode(
            "tracks",
            &BY_TITLE,
            &Cursor {
                key: Key::Text("abc".into()),
                id: 5,
            },
        );
        assert_eq!(good, "v1:tracks:title:616263:5");
        for bad in [
            "",
            "v1",
            "v2:tracks:title:616263:5",
            "v1:albums:title:616263:5",
            "v1:tracks:artist:616263:5",
            "v1:title:616263:5",
            "v1:tracks:title:61626:5",
            "v1:tracks:title:zz:5",
            "v1:tracks:title:+f:5",
            "v1:tracks:title:ff:5",
            "v1:tracks:title:616263:x",
            "v1:tracks:title:616263:5:6",
            "v1:tracks:title:616263:99999999999999999999",
            "v1:tracks:title:616263:",
        ] {
            let error = decode("tracks", &BY_TITLE, bad).unwrap_err();
            assert_eq!(error.code, ApiCode::InvalidArgs, "{bad:?}");
        }
        // A key on an id sort, and a text key on a numeric sort.
        assert!(decode("tracks", &BY_ID, "v1:tracks:id:61:5").is_err());
        assert!(decode("tracks", &BY_POSITION, "v1:tracks:position:abc:5").is_err());
        let long = format!("v1:tracks:title:{}:5", "61".repeat(600));
        assert!(decode("tracks", &BY_TITLE, &long).is_err());
    }

    #[test]
    fn a_cursor_belongs_to_its_scope() {
        let cursor = Cursor {
            key: Key::Int(2),
            id: 9,
        };
        let text = encode("album_tracks.4", &BY_POSITION, &cursor);
        assert_eq!(text, "v1:album_tracks.4:position:2:9");
        assert_eq!(decode("album_tracks.4", &BY_POSITION, &text), Ok(cursor));
        for scope in [
            "album_tracks.5",
            "album_tracks",
            "playlist_tracks.4",
            "tracks",
        ] {
            assert!(decode(scope, &BY_POSITION, &text).is_err(), "{scope}");
        }
    }

    #[test]
    fn page_args_check_each_field() {
        let sorts = [BY_ID, BY_TITLE];
        let page = page_args(&args(json!({})), &sorts, "tracks").unwrap();
        assert_eq!((page.sort.name, page.limit), ("id", DEFAULT_LIMIT));
        assert!(page.after.is_none());
        let page = page_args(
            &args(json!({ "sort": "title", "limit": 200, "cursor": "v1:tracks:title:61:1" })),
            &sorts,
            "tracks",
        )
        .unwrap();
        assert_eq!((page.sort.name, page.limit), ("title", 200));
        assert_eq!(
            page.after,
            Some(Cursor {
                key: Key::Text("a".into()),
                id: 1
            })
        );
        for bad in [
            json!({ "sort": "year" }),
            json!({ "sort": 1 }),
            json!({ "limit": 0 }),
            json!({ "limit": 201 }),
            json!({ "limit": 2.5 }),
            json!({ "limit": "5" }),
            json!({ "cursor": 5 }),
            // A cursor of another sort.
            json!({ "sort": "id", "cursor": "v1:tracks:title:61:1" }),
            // A cursor of another list.
            json!({ "sort": "title", "cursor": "v1:albums:title:61:1" }),
        ] {
            let error = page_args(&args(bad.clone()), &sorts, "tracks").unwrap_err();
            assert_eq!(error.code, ApiCode::InvalidArgs, "{bad}");
        }
    }

    const BY_ENTRY: Sort = Sort {
        name: "position",
        kind: KeyKind::Composite,
        key_sql: "pt.position",
        id_sql: "pt.id",
    };

    fn row(place: [i64; 3], id: i64) -> Cursor {
        Cursor {
            key: Key::Composite(place),
            id,
        }
    }

    #[test]
    fn a_composite_key_is_fixed_width_digits_and_round_trips() {
        let max = 99_999 * 1_000_000 + 999_999;
        for place in [[1, 7, 0], [3, 12, 2_000_004], [i64::MAX, i64::MAX, max]] {
            let cursor = row(place, 41);
            let text = encode("playlist_tracks.2", &BY_ENTRY, &cursor);
            let key = text.split(':').nth(3).unwrap();
            assert_eq!(key.len(), COMPOSITE_DIGITS, "{text}");
            assert!(key.bytes().all(|b| b.is_ascii_digit()), "{text}");
            assert_eq!(decode("playlist_tracks.2", &BY_ENTRY, &text), Ok(cursor));
        }
        assert_eq!(
            encode("playlist_tracks.2", &BY_ENTRY, &row([3, 12, 2_000_004], 41)),
            format!(
                "v1:playlist_tracks.2:position:{}{}{}:41",
                "0000000000000000003", "0000000000000000012", "00002000004"
            )
        );
    }

    #[test]
    fn an_integer_key_on_a_composite_sort_reads_as_a_slot() {
        let old = "v1:playlist_tracks.2:position:3:12";
        assert_eq!(
            decode("playlist_tracks.2", &BY_ENTRY, old),
            Ok(Cursor {
                key: Key::Int(3),
                id: 12
            })
        );
        // A composite key never reads on an integer sort.
        let text = encode("playlist_tracks.2", &BY_ENTRY, &row([3, 12, 0], 5));
        assert!(decode("playlist_tracks.2", &BY_POSITION, &text).is_err());
    }

    #[test]
    fn a_tampered_composite_key_is_invalid() {
        let digits = "1".repeat(COMPOSITE_DIGITS);
        let overflow = format!("{}{}", "9".repeat(19), "0".repeat(30));
        for key in [
            digits[1..].to_string(),
            format!("{digits}1"),
            format!("+{}", &digits[1..]),
            format!("-{}", &digits[1..]),
            format!("{}a", &digits[1..]),
            format!("{}:1", &digits[2..]),
            overflow,
            "99999999999999999999".to_string(),
            "1.5".to_string(),
            String::new(),
        ] {
            let text = format!("v1:playlist_tracks.2:position:{key}:5");
            let error = decode("playlist_tracks.2", &BY_ENTRY, &text).unwrap_err();
            assert_eq!(error.code, ApiCode::InvalidArgs, "{key:?}");
        }
    }

    #[test]
    fn follows_orders_composite_rows_and_skips_a_whole_slot_for_an_integer_cursor() {
        let rows = [
            row([1, 4, 0], 10),
            row([2, 6, 1_000_001], 11),
            row([2, 6, 1_000_002], 12),
            row([2, 9, 0], 10),
            row([3, 5, 0], 13),
        ];
        let after = |cursor: Option<&Cursor>| -> Vec<usize> {
            (0..rows.len())
                .filter(|&i| follows(cursor, &rows[i]))
                .collect()
        };
        assert_eq!(after(None), [0, 1, 2, 3, 4]);
        assert_eq!(after(Some(&rows[1])), [2, 3, 4]);
        assert_eq!(after(Some(&rows[4])), Vec::<usize>::new());
        let slot = |position, id| Cursor {
            key: Key::Int(position),
            id,
        };
        // Slot 6 is the album entry at position 2: its rows are behind a cursor naming it.
        assert_eq!(after(Some(&slot(2, 6))), [3, 4]);
        assert_eq!(after(Some(&slot(1, 4))), [1, 2, 3, 4]);
        assert_eq!(after(Some(&slot(2, 7))), [3, 4]);
        // A row without a composite key never follows.
        assert!(!follows(None, &slot(1, 1)));
    }

    #[test]
    fn a_page_cuts_to_its_limit_and_points_at_its_last_row() {
        let rows: Vec<(i64, Cursor)> = (1..=4)
            .map(|id| (id, Cursor { key: Key::None, id }))
            .collect();
        let page = |limit| PageArgs {
            scope: "tracks".into(),
            sort: BY_ID,
            after: None,
            limit,
        };
        let (items, next) = finish_page(&page(3), rows.clone());
        assert_eq!(items, [1, 2, 3]);
        assert_eq!(next.as_deref(), Some("v1:tracks:id::3"));
        let (items, next) = finish_page(&page(4), rows);
        assert_eq!(items.len(), 4);
        assert_eq!(next, None);
    }
}

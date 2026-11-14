/*
 * Keyset paging for the `library.*` lists. A page is ordered by a sort key, then by a row id that
 * breaks ties, so a row added or removed between two calls never shifts the rows of the next page.
 * The cursor names the last row returned: `v1:<scope>:<sort>:<key>:<id>`. The scope names the list and,
 * for an album or playlist, its id; the key is hex-encoded for a text sort, decimal for a numeric one
 * and empty when the sort is the id itself. It carries no path and is checked against the scope and
 * sort it is used with; anything that does not parse or does not match is `invalid_args`.
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

/// How a sort orders its rows: by the id alone, or by an integer or text key and then the id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    Id,
    Int,
    Text,
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
    };
    format!("{VERSION}:{scope}:{}:{key}:{}", sort.name, cursor.id)
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
        KeyKind::Id => return Err(invalid()),
    };
    Ok(Cursor { key, id })
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

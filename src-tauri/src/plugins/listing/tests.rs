// The listing rule against the fixtures the app's own test reads too, so both sides agree on them.

// -- Library Imports --
use serde_json::Value;

// -- Local Imports --
use super::*;
use crate::plugins::manifest::parse;

const FIXTURES: &str = include_str!("fixtures.json");

fn expected(name: &str) -> Listing {
    match name {
        "catalog" => Listing::Catalog,
        "plugins" => Listing::Plugins,
        other => panic!("unknown listing '{other}'"),
    }
}

#[test]
fn every_fixture_lists_where_it_says() {
    let cases: Vec<Value> = serde_json::from_str(FIXTURES).unwrap();
    assert!(cases.len() >= 10);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let manifest = parse(case["manifest"].to_string().as_bytes())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let want = expected(case["listing"].as_str().unwrap());
        assert_eq!(listing(&manifest), want, "{name}");
    }
}

#[test]
fn listing_serializes_as_snake_case() {
    assert_eq!(serde_json::to_value(Listing::Catalog).unwrap(), "catalog");
    assert_eq!(serde_json::to_value(Listing::Plugins).unwrap(), "plugins");
}

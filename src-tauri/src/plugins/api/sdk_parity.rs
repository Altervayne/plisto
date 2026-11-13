/*
 * Keeps the SDK's type file and the dispatch table in step: every quoted key of `PlistoMethods` in
 * `plisto-sdk.d.ts` must be a method this build answers, and every method must have its key.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

// -- Local Imports --
use super::method_names;

const SDK_TYPES: &str = "../plugin-kit/sdk/plisto-sdk.d.ts";

/// The method keys of `interface PlistoMethods`: one `"name":` per line, up to the line that closes it.
fn declared_methods(text: &str) -> Option<BTreeSet<String>> {
    let mut lines = text.lines();
    lines.find(|line| line.trim() == "export interface PlistoMethods {")?;
    let mut names = BTreeSet::new();
    for line in lines {
        let line = line.trim_start();
        if line.starts_with('}') {
            return Some(names);
        }
        let Some((name, rest)) = line.strip_prefix('"').and_then(|l| l.split_once('"')) else {
            continue;
        };
        let mut chars = name.chars();
        let well_formed = chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.');
        if well_formed && rest.starts_with(':') {
            names.insert(name.to_string());
        }
    }
    None
}

#[test]
fn the_sdk_types_list_exactly_the_dispatch_table() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SDK_TYPES);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "the SDK type file {} must exist for this check ({e})",
            path.display()
        )
    });
    let declared = declared_methods(&text).expect("plisto-sdk.d.ts has no closed PlistoMethods");
    let table: BTreeSet<String> = method_names().into_iter().map(String::from).collect();
    let missing: Vec<_> = table.difference(&declared).collect();
    let unknown: Vec<_> = declared.difference(&table).collect();
    assert!(
        missing.is_empty() && unknown.is_empty(),
        "plisto-sdk.d.ts is out of step with the dispatch table: \
         missing from the file {missing:?}, not in the table {unknown:?}"
    );
}

#[test]
fn keys_are_read_only_inside_the_interface() {
    let text = "\"x.y\": 1;\nexport interface PlistoMethods {\n  \"app.info\": { args: {}; result: A };\n  \
                // \"no.key\": comment\n  \"Bad.key\": {};\n  \"log.write\": {};\n}\n\"after.close\": 2;\n";
    let names = declared_methods(text).unwrap();
    assert_eq!(
        names.into_iter().collect::<Vec<_>>(),
        ["app.info", "log.write"]
    );
    assert_eq!(declared_methods("export interface PlistoMethods {\n"), None);
    assert_eq!(declared_methods("interface Other {\n}\n"), None);
}

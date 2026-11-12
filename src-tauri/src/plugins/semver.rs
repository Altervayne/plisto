/*
 * A minimal semantic version: parse and precedence compare, enough for `version` and `min_plisto`
 * without a dependency. Build metadata is validated and then ignored, as the spec says.
 */

// -- Library Imports --
use std::cmp::Ordering;

pub const MAX_VERSION: usize = 32;

/// A minimal semantic version: `major.minor.patch`, optional `-prerelease`, optional `+build` (ignored).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<String>,
}

fn ident_list_ok(list: &str) -> bool {
    list.split('.')
        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn numeric_id(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0'))
    {
        return None;
    }
    s.parse().ok()
}

impl SemVer {
    pub fn parse(s: &str) -> Option<SemVer> {
        if s.len() > MAX_VERSION {
            return None;
        }
        let s = match s.split_once('+') {
            // A build suffix is ignored, but it must still be well-formed identifiers.
            Some((core, build)) if ident_list_ok(build) => core,
            Some(_) => return None,
            None => s,
        };
        let (core, pre) = match s.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (s, None),
        };
        let mut parts = core.split('.');
        let major = numeric_id(parts.next()?)?;
        let minor = numeric_id(parts.next()?)?;
        let patch = numeric_id(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(p) => {
                let ids: Vec<&str> = p.split('.').collect();
                for id in &ids {
                    let ok = !id.is_empty()
                        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                        && (!id.bytes().all(|b| b.is_ascii_digit()) || numeric_id(id).is_some());
                    if !ok {
                        return None;
                    }
                }
                ids.into_iter().map(String::from).collect()
            }
        };
        Some(SemVer {
            major,
            minor,
            patch,
            pre,
        })
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        let core =
            (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch));
        if core != Ordering::Equal {
            return core;
        }
        // A release outranks any prerelease of the same core.
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            _ => {}
        }
        for (a, b) in self.pre.iter().zip(&other.pre) {
            let ord = match (numeric_id(a), numeric_id(b)) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => a.cmp(b),
            };
            if ord != Ordering::Equal {
                return ord;
            }
        }
        self.pre.len().cmp(&other.pre.len())
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_precedence() {
        let v = |s: &str| SemVer::parse(s).unwrap();
        assert!(v("1.0.0") < v("1.0.1"));
        assert!(v("1.9.0") < v("1.10.0"));
        assert!(v("2.0.0") > v("1.99.99"));
        assert!(v("1.0.0-alpha") < v("1.0.0"));
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        assert!(v("1.0.0-alpha.1") < v("1.0.0-alpha.beta"));
        assert!(v("1.0.0-beta.2") < v("1.0.0-beta.11"));
        assert!(v("1.0.0-1") < v("1.0.0-a"));
        assert_eq!(v("1.0.0+build"), v("1.0.0"));
        assert!(SemVer::parse(env!("CARGO_PKG_VERSION")).is_some());
    }
}

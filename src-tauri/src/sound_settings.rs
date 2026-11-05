/*
 * The `sound` kv blob: EQ, preamp, and levelling mode. Parsing is total: any stored text becomes a valid
 * `SoundSettings`, so the engine never has to reject what the webview wrote. The TS mirror in
 * `src/state/sound/settings.ts` runs the same case table; this side is authoritative.
 */

// -- Library Imports --
use serde_json::{json, Value};

/// The blob version this build reads and writes. Any other value reads as defaults.
pub const VERSION: i64 = 1;

pub const BAND_COUNT: usize = 8;
pub const GAIN_MIN_DB: f64 = -12.0;
pub const GAIN_MAX_DB: f64 = 12.0;
pub const PREAMP_MIN_DB: f64 = -12.0;
pub const PREAMP_MAX_DB: f64 = 6.0;

/// Q of the peaking bands. Never exposed to the user.
pub const PEAK_Q: f64 = 1.0;
/// Slope of the two shelves.
pub const SHELF_SLOPE: f64 = 1.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BandKind {
    LowShelf,
    Peak,
    HighShelf,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Band {
    pub freq_hz: f64,
    pub kind: BandKind,
}

pub const BANDS: [Band; BAND_COUNT] = [
    Band {
        freq_hz: 60.0,
        kind: BandKind::LowShelf,
    },
    Band {
        freq_hz: 150.0,
        kind: BandKind::Peak,
    },
    Band {
        freq_hz: 400.0,
        kind: BandKind::Peak,
    },
    Band {
        freq_hz: 1000.0,
        kind: BandKind::Peak,
    },
    Band {
        freq_hz: 2400.0,
        kind: BandKind::Peak,
    },
    Band {
        freq_hz: 5000.0,
        kind: BandKind::Peak,
    },
    Band {
        freq_hz: 9000.0,
        kind: BandKind::Peak,
    },
    Band {
        freq_hz: 14000.0,
        kind: BandKind::HighShelf,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Levelling {
    Off,
    Track,
}

impl Levelling {
    fn as_str(self) -> &'static str {
        match self {
            Levelling::Off => "off",
            Levelling::Track => "track",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EqSettings {
    pub on: bool,
    pub preset: Option<String>,
    pub gains: [f64; BAND_COUNT],
}

impl Default for EqSettings {
    fn default() -> Self {
        EqSettings {
            on: false,
            preset: None,
            gains: [0.0; BAND_COUNT],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SoundSettings {
    pub eq: EqSettings,
    pub preamp_db: f64,
    pub levelling: Levelling,
}

impl Default for SoundSettings {
    fn default() -> Self {
        SoundSettings {
            eq: EqSettings::default(),
            preamp_db: 0.0,
            levelling: Levelling::Off,
        }
    }
}

impl SoundSettings {
    /// The wire form `parse` reads back.
    pub fn to_json(&self) -> String {
        json!({
            "v": VERSION,
            "eq": { "on": self.eq.on, "preset": self.eq.preset, "gains": self.eq.gains },
            "preamp_db": self.preamp_db,
            "levelling": self.levelling.as_str(),
        })
        .to_string()
    }
}

/// Reads a stored blob. Unparsable text or a `v` other than the current one gives all defaults; with a
/// valid `v`, each field falls back on its own. A gains array of the wrong length or holding a non-finite
/// entry flattens and bypasses the whole EQ, since a half-trusted curve is worse than none.
pub fn parse(raw: &str) -> SoundSettings {
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return SoundSettings::default();
    };
    if root.get("v").and_then(Value::as_i64) != Some(VERSION) {
        return SoundSettings::default();
    }
    SoundSettings {
        eq: parse_eq(root.get("eq")),
        preamp_db: root
            .get("preamp_db")
            .and_then(Value::as_f64)
            .map_or(0.0, |db| db.clamp(PREAMP_MIN_DB, PREAMP_MAX_DB)),
        levelling: match root.get("levelling").and_then(Value::as_str) {
            Some("track") => Levelling::Track,
            _ => Levelling::Off,
        },
    }
}

fn parse_eq(eq: Option<&Value>) -> EqSettings {
    let Some(gains) = eq.and_then(|e| e.get("gains")).and_then(read_gains) else {
        return EqSettings::default();
    };
    EqSettings {
        on: eq
            .and_then(|e| e.get("on"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        preset: eq
            .and_then(|e| e.get("preset"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        gains,
    }
}

fn read_gains(value: &Value) -> Option<[f64; BAND_COUNT]> {
    let list = value.as_array()?;
    if list.len() != BAND_COUNT {
        return None;
    }
    let mut gains = [0.0; BAND_COUNT];
    for (slot, item) in gains.iter_mut().zip(list) {
        *slot = item.as_f64()?.clamp(GAIN_MIN_DB, GAIN_MAX_DB);
    }
    Some(gains)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLAT: [f64; 8] = [0.0; 8];

    struct Case {
        name: &'static str,
        raw: &'static str,
        on: bool,
        preset: Option<&'static str>,
        gains: [f64; 8],
        preamp_db: f64,
        levelling: Levelling,
    }

    // The same table runs in `src/state/sound/settings.test.ts`; keep the two in step.
    fn cases() -> Vec<Case> {
        vec![
            Case {
                name: "full blob",
                raw: r#"{"v":1,"eq":{"on":true,"preset":"rock","gains":[1,2,3,-1,-2,-3,4,5]},"preamp_db":-3,"levelling":"track"}"#,
                on: true,
                preset: Some("rock"),
                gains: [1.0, 2.0, 3.0, -1.0, -2.0, -3.0, 4.0, 5.0],
                preamp_db: -3.0,
                levelling: Levelling::Track,
            },
            Case {
                name: "version mismatch",
                raw: r#"{"v":2,"eq":{"on":true,"preset":"rock","gains":[1,2,3,4,5,6,7,8]},"preamp_db":-3,"levelling":"track"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 0.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "missing version",
                raw: r#"{"eq":{"on":true,"gains":[1,2,3,4,5,6,7,8]},"preamp_db":-3,"levelling":"track"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 0.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "wrong gains length",
                raw: r#"{"v":1,"eq":{"on":true,"preset":"rock","gains":[1,2,3]},"preamp_db":-3,"levelling":"track"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: -3.0,
                levelling: Levelling::Track,
            },
            Case {
                name: "non-finite gain",
                raw: r#"{"v":1,"eq":{"on":true,"preset":"rock","gains":[1,2,null,4,5,6,7,8]},"preamp_db":2,"levelling":"off"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 2.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "gains clamp",
                raw: r#"{"v":1,"eq":{"on":true,"preset":null,"gains":[99,-99,12,-12,0,0,0,0]},"preamp_db":0,"levelling":"off"}"#,
                on: true,
                preset: None,
                gains: [12.0, -12.0, 12.0, -12.0, 0.0, 0.0, 0.0, 0.0],
                preamp_db: 0.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "preamp clamps high",
                raw: r#"{"v":1,"eq":{"on":false,"gains":[0,0,0,0,0,0,0,0]},"preamp_db":40,"levelling":"off"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 6.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "preamp clamps low",
                raw: r#"{"v":1,"eq":{"on":false,"gains":[0,0,0,0,0,0,0,0]},"preamp_db":-40,"levelling":"off"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: -12.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "unknown levelling",
                raw: r#"{"v":1,"eq":{"on":true,"gains":[0,0,0,0,0,0,0,0]},"preamp_db":1,"levelling":"album"}"#,
                on: true,
                preset: None,
                gains: FLAT,
                preamp_db: 1.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "missing fields",
                raw: r#"{"v":1}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 0.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "missing eq keeps the other fields",
                raw: r#"{"v":1,"preamp_db":-2,"levelling":"track"}"#,
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: -2.0,
                levelling: Levelling::Track,
            },
            Case {
                name: "empty string",
                raw: "",
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 0.0,
                levelling: Levelling::Off,
            },
            Case {
                name: "unparsable json",
                raw: "{not json",
                on: false,
                preset: None,
                gains: FLAT,
                preamp_db: 0.0,
                levelling: Levelling::Off,
            },
        ]
    }

    #[test]
    fn parses_the_shared_case_table() {
        for case in cases() {
            let got = parse(case.raw);
            assert_eq!(got.eq.on, case.on, "{}: on", case.name);
            assert_eq!(
                got.eq.preset.as_deref(),
                case.preset,
                "{}: preset",
                case.name
            );
            assert_eq!(got.eq.gains, case.gains, "{}: gains", case.name);
            assert_eq!(got.preamp_db, case.preamp_db, "{}: preamp", case.name);
            assert_eq!(got.levelling, case.levelling, "{}: levelling", case.name);
        }
    }

    #[test]
    fn round_trips_through_the_wire_form() {
        let settings = SoundSettings {
            eq: EqSettings {
                on: true,
                preset: Some("vocal".to_owned()),
                gains: [1.5, 0.0, -2.0, 3.0, 0.5, -1.0, 2.0, 4.0],
            },
            preamp_db: -4.5,
            levelling: Levelling::Track,
        };
        assert_eq!(parse(&settings.to_json()), settings);
    }

    #[test]
    fn default_is_bypassed_flat() {
        let d = SoundSettings::default();
        assert!(!d.eq.on);
        assert_eq!(d.eq.gains, FLAT);
        assert_eq!(d.preamp_db, 0.0);
        assert_eq!(d.levelling, Levelling::Off);
    }
}

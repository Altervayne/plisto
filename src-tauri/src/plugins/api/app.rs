/*
 * `app.info` and `app.methods`. Locale, theme and app mode are resolved from the settings table with
 * the same rules the main window applies, so a plugin sees what the user sees.
 */

// -- Library Imports --
use serde_json::{json, Map, Value};

// -- Local Imports --
use super::events::topic_names;
use super::rate::RateClass;
use super::{method_names, CallCtx, MethodSpec, Need, Outcome, API_VERSION};

pub const SETTING_LOCALE: &str = "locale";
pub const SETTING_THEME: &str = "theme";
pub const SETTING_APP_MODE: &str = "app_mode";
pub const SETTING_PLAYER_ENABLED: &str = "player_enabled";

pub(super) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "app.info",
        need: Need::Ambient,
        class: RateClass::Ambient,
        run: info,
    },
    MethodSpec {
        name: "app.methods",
        need: Need::Ambient,
        class: RateClass::Ambient,
        run: methods,
    },
];

/// A supported locale setting, else English.
pub fn resolve_locale(setting: Option<&str>) -> &'static str {
    match setting {
        Some("fr") => "fr",
        _ => "en",
    }
}

/// An explicit theme setting, else the OS theme.
pub fn resolve_theme(setting: Option<&str>, os_prefers_dark: bool) -> &'static str {
    match setting {
        Some("light") => "light",
        Some("dark") => "dark",
        _ if os_prefers_dark => "dark",
        _ => "light",
    }
}

/// An explicit app mode, else the older player switch: off means organizer only.
pub fn resolve_app_mode(app_mode: Option<&str>, player_enabled: Option<&str>) -> &'static str {
    match app_mode {
        Some("player") => "player",
        Some("organizer") => "organizer",
        Some("both") => "both",
        _ if player_enabled == Some("0") => "organizer",
        _ => "both",
    }
}

fn info(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    let setting = |key: &str| ctx.host.setting(key);
    let granted: Vec<&str> = ctx.serving.granted.iter().map(|c| c.as_str()).collect();
    Outcome::Done(Ok(json!({
        "api_version": API_VERSION,
        "plisto_version": env!("CARGO_PKG_VERSION"),
        "plugin_id": ctx.id,
        "plugin_version": ctx.serving.version,
        "locale": resolve_locale(setting(SETTING_LOCALE).as_deref()),
        "theme": resolve_theme(setting(SETTING_THEME).as_deref(), ctx.host.os_prefers_dark()),
        "app_mode": resolve_app_mode(
            setting(SETTING_APP_MODE).as_deref(),
            setting(SETTING_PLAYER_ENABLED).as_deref(),
        ),
        "tier": ctx.serving.tier,
        "granted": granted,
    })))
}

fn methods(_ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    Outcome::Done(Ok(json!({
        "api_version": API_VERSION,
        "methods": method_names(),
        "topics": topic_names(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::{table, test_ctx, FakeHost};
    use crate::plugins::manifest::Capability;
    use std::path::Path;

    #[test]
    fn locale_falls_back_to_english() {
        for (setting, want) in [
            (Some("en"), "en"),
            (Some("fr"), "fr"),
            (Some("de"), "en"),
            (Some("FR"), "en"),
            (Some(""), "en"),
            (None, "en"),
        ] {
            assert_eq!(resolve_locale(setting), want, "{setting:?}");
        }
    }

    #[test]
    fn theme_follows_the_setting_then_the_os() {
        for (setting, dark, want) in [
            (Some("light"), true, "light"),
            (Some("dark"), false, "dark"),
            (Some("system"), true, "dark"),
            (Some("system"), false, "light"),
            (Some("Dark"), false, "light"),
            (None, true, "dark"),
            (None, false, "light"),
        ] {
            assert_eq!(resolve_theme(setting, dark), want, "{setting:?} {dark}");
        }
    }

    #[test]
    fn app_mode_falls_back_to_the_player_switch() {
        for (mode, player, want) in [
            (Some("player"), Some("0"), "player"),
            (Some("organizer"), None, "organizer"),
            (Some("both"), Some("0"), "both"),
            (Some("weird"), Some("0"), "organizer"),
            (None, Some("0"), "organizer"),
            (None, Some("1"), "both"),
            (None, Some("false"), "both"),
            (None, None, "both"),
        ] {
            assert_eq!(resolve_app_mode(mode, player), want, "{mode:?} {player:?}");
        }
    }

    #[test]
    fn info_has_the_full_shape_with_grants() {
        let host = FakeHost {
            dark: true,
            ..FakeHost::default()
        }
        .with(SETTING_LOCALE, "fr")
        .with(SETTING_PLAYER_ENABLED, "0");
        let mut call = test_ctx(Path::new("unused"), &host);
        call.serving.granted = vec![Capability::Storage, Capability::UiToast];
        assert_eq!(
            info(&call.ctx(), &Map::new()).done().unwrap(),
            json!({
                "api_version": 1,
                "plisto_version": env!("CARGO_PKG_VERSION"),
                "plugin_id": "com.example.demo",
                "plugin_version": "1.0.0",
                "locale": "fr",
                "theme": "dark",
                "app_mode": "organizer",
                "tier": "ui",
                "granted": ["storage", "ui.toast"],
            })
        );
    }

    #[test]
    fn app_methods_equals_the_dispatch_table() {
        let host = FakeHost::default();
        let call = test_ctx(Path::new("unused"), &host);
        let result = methods(&call.ctx(), &Map::new()).done().unwrap();
        assert_eq!(result["api_version"], 1);
        let listed: Vec<String> = serde_json::from_value(result["methods"].clone()).unwrap();

        let mut names: Vec<&str> = table().iter().map(|m| m.name).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "a method name repeats in the table");
        assert_eq!(listed, names);
        assert!(listed.windows(2).all(|w| w[0] < w[1]));
        for name in ["app.info", "app.methods", "log.write"] {
            assert!(listed.iter().any(|n| n == name), "{name}");
        }
    }

    #[test]
    fn app_methods_lists_topics() {
        let host = FakeHost::default();
        let call = test_ctx(Path::new("unused"), &host);
        let result = methods(&call.ctx(), &Map::new()).done().unwrap();
        assert_eq!(
            result["topics"],
            json!([
                "app_mode",
                "library_changed",
                "locale",
                "now_playing",
                "playback_state",
                "queue",
                "theme"
            ])
        );
        // The owner-only stream topic is not one of them.
        assert!(!result["topics"].as_array().unwrap().contains(&json!("stream")));
    }
}

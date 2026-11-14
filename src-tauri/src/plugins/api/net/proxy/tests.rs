// The proxy reading and the reason rewrite against scripted answers and a clock the tests move.

// -- Library Imports --
use std::ffi::OsString;

// -- Local Imports --
use super::super::{
    BLOCKED_ADDRESS, DEV_ONLY, ORIGIN_NOT_LISTED, PROTOCOL, REDIRECT, REDIRECT_NOT_LISTED,
};
use super::*;

fn proxy(answer: Answer) -> (Proxy, Arc<ScriptedSource>, Arc<TestClock>) {
    let source = Arc::new(ScriptedSource::new(answer));
    let clock = Arc::new(TestClock::new());
    (Proxy::new(source.clone(), clock.clone()), source, clock)
}

fn url() -> Url {
    Url::parse("https://a.plisto-fixture.com/x").unwrap()
}

fn network(reason: &'static str) -> ApiError {
    Refusal::network(reason).into()
}

const AUTO_DETECT: UserProxy = UserProxy {
    auto_detect: true,
    auto_config: false,
    proxy: false,
};

const NOTHING: Answer = Answer {
    user: UserProxy {
        auto_detect: false,
        auto_config: false,
        proxy: false,
    },
    machine: false,
    environment: false,
    found: false,
    delay: Duration::ZERO,
    fails: false,
    discovery_fails: false,
    discovery_panics: false,
};

const MANUAL: Answer = Answer {
    user: UserProxy {
        proxy: true,
        ..NOTHING.user
    },
    ..NOTHING
};

const DETECTING: Answer = Answer {
    user: AUTO_DETECT,
    found: true,
    ..NOTHING
};

// ---- Reading ----

#[test]
fn each_source_maps_to_its_kind() {
    let pac = UserProxy {
        auto_config: true,
        ..UserProxy::default()
    };
    let cases = [
        (NOTHING, ProxyKind::None),
        (MANUAL, ProxyKind::Manual),
        (
            Answer {
                user: pac,
                ..NOTHING
            },
            ProxyKind::Pac,
        ),
        (
            Answer {
                machine: true,
                ..NOTHING
            },
            ProxyKind::Manual,
        ),
        (
            Answer {
                environment: true,
                ..NOTHING
            },
            ProxyKind::Manual,
        ),
        (
            Answer {
                user: pac,
                machine: true,
                ..NOTHING
            },
            ProxyKind::Manual,
        ),
    ];
    for (answer, kind) in cases {
        let (proxy, _, _) = proxy(answer);
        assert_eq!(proxy.environment().proxy, kind, "{answer:?}");
    }
}

#[test]
fn auto_detect_alone_reads_none_and_runs_no_discovery() {
    let (proxy, source, _) = proxy(DETECTING);
    assert_eq!(proxy.kind(), ProxyKind::None);
    assert_eq!(source.discoveries(), 0);
}

#[test]
fn a_source_that_errors_reads_none() {
    let (proxy, _, _) = proxy(Answer {
        fails: true,
        ..MANUAL
    });
    assert_eq!(proxy.kind(), ProxyKind::None);
}

#[test]
fn a_read_is_served_from_cache_for_thirty_seconds() {
    let (proxy, source, clock) = proxy(NOTHING);
    assert_eq!(proxy.kind(), ProxyKind::None);
    source.set(MANUAL);
    clock.advance(READ_FOR - Duration::from_secs(1));
    assert_eq!(proxy.kind(), ProxyKind::None);
    assert_eq!(source.reads(), 1);
    clock.advance(Duration::from_secs(1));
    assert_eq!(proxy.kind(), ProxyKind::Manual);
    assert_eq!(source.reads(), 2);
}

#[test]
fn proxy_variables_count_in_any_case_and_only_when_set() {
    let vars = |list: &[(&str, &str)]| -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(n, v)| (OsString::from(n), OsString::from(v)))
            .collect()
    };
    for name in ["HTTPS_PROXY", "http_proxy", "All_Proxy"] {
        assert!(
            names_a_proxy(vars(&[(name, "http://10.0.0.1:3128")])),
            "{name}"
        );
    }
    assert!(!names_a_proxy(vars(&[("HTTPS_PROXY", "  ")])));
    assert!(!names_a_proxy(vars(&[("NO_PROXY", "example.com")])));
    assert!(!names_a_proxy(Vec::new()));
}

#[test]
fn the_kind_serializes_lower_case() {
    let json = serde_json::to_value(NetEnvironment {
        proxy: ProxyKind::Detected,
    })
    .unwrap();
    assert_eq!(json, serde_json::json!({ "proxy": "detected" }));
}

// ---- Rewrite ----

#[tokio::test(flavor = "multi_thread")]
async fn a_transport_failure_behind_a_proxy_becomes_proxy() {
    for reason in [DNS, CONNECT, TLS, CLOSED] {
        let (manual, _, _) = proxy(MANUAL);
        let got = manual.explain(network(reason), &url()).await;
        assert_eq!((got.code, got.reason), (ApiCode::Network, Some(PROXY)));

        let (none, _, _) = proxy(NOTHING);
        let got = none.explain(network(reason), &url()).await;
        assert_eq!(got, network(reason));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn other_errors_are_never_rewritten() {
    let others = [
        network(PROTOCOL),
        network(REDIRECT),
        ApiError::timeout(),
        ApiError::aborted("abort"),
        ApiError::aborted("frame_gone"),
        Refusal::denied(BLOCKED_ADDRESS).into(),
        Refusal::denied(ORIGIN_NOT_LISTED).into(),
        Refusal::denied(REDIRECT_NOT_LISTED).into(),
        Refusal::denied(DEV_ONLY).into(),
        Refusal::response_body().into(),
        Refusal::request_body().into(),
    ];
    let (proxy, source, _) = proxy(Answer {
        user: UserProxy {
            proxy: true,
            ..AUTO_DETECT
        },
        ..DETECTING
    });
    for error in others {
        assert_eq!(proxy.explain(error.clone(), &url()).await, error);
    }
    assert_eq!(source.discoveries(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failure_with_auto_detect_runs_one_discovery_and_keeps_its_answer() {
    let (proxy, source, clock) = proxy(DETECTING);
    let got = proxy.explain(network(CONNECT), &url()).await;
    assert_eq!(got.reason, Some(PROXY));
    assert_eq!(source.discoveries(), 1);
    assert_eq!(proxy.kind(), ProxyKind::Detected);

    let got = proxy.explain(network(DNS), &url()).await;
    assert_eq!(got.reason, Some(PROXY));
    assert_eq!(source.discoveries(), 1);

    clock.advance(DISCOVERY_EVERY);
    assert_eq!(proxy.kind(), ProxyKind::None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_failure_inside_the_window_runs_no_discovery() {
    let (proxy, source, clock) = proxy(Answer {
        found: false,
        ..DETECTING
    });
    assert_eq!(
        proxy.explain(network(CONNECT), &url()).await,
        network(CONNECT)
    );
    clock.advance(DISCOVERY_EVERY - Duration::from_secs(1));
    assert_eq!(
        proxy.explain(network(CONNECT), &url()).await,
        network(CONNECT)
    );
    assert_eq!(source.discoveries(), 1);

    clock.advance(Duration::from_secs(1));
    proxy.explain(network(CONNECT), &url()).await;
    assert_eq!(source.discoveries(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_failures_at_once_start_one_discovery() {
    let (proxy, source, _) = proxy(Answer {
        delay: Duration::from_millis(300),
        ..DETECTING
    });
    let u = url();
    let (first, second) = tokio::join!(
        proxy.explain(network(CONNECT), &u),
        proxy.explain(network(TLS), &u),
    );
    assert_eq!(source.discoveries(), 1);
    // The failure that found the window taken keeps its own reason.
    let reasons = [first.reason, second.reason];
    assert!(reasons.contains(&Some(PROXY)), "{reasons:?}");
    assert!(reasons.contains(&Some(TLS)), "{reasons:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_discovery_that_errors_reads_none() {
    let (proxy, source, _) = proxy(Answer {
        discovery_fails: true,
        ..DETECTING
    });
    assert_eq!(
        proxy.explain(network(CONNECT), &url()).await,
        network(CONNECT)
    );
    assert_eq!(source.discoveries(), 1);
    assert_eq!(proxy.kind(), ProxyKind::None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_user_read_runs_no_discovery() {
    // Auto-detect is unknown when the read fails, so it counts as off.
    let (proxy, source, _) = proxy(Answer {
        fails: true,
        ..DETECTING
    });
    assert_eq!(
        proxy.explain(network(CONNECT), &url()).await,
        network(CONNECT)
    );
    assert_eq!(source.discoveries(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_configured_proxy_needs_no_discovery() {
    let pac = UserProxy {
        auto_config: true,
        ..AUTO_DETECT
    };
    let manual = UserProxy {
        proxy: true,
        ..AUTO_DETECT
    };
    for user in [pac, manual] {
        let (proxy, source, _) = proxy(Answer { user, ..DETECTING });
        let got = proxy.explain(network(CONNECT), &url()).await;
        assert_eq!(got.reason, Some(PROXY));
        assert_eq!(source.discoveries(), 0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn discovery_is_given_the_origin_only() {
    let (proxy, source, _) = proxy(Answer {
        found: false,
        ..DETECTING
    });
    let url = Url::parse("https://a.plisto-fixture.com:8443/v1/items?token=secret#f").unwrap();
    proxy.explain(network(CONNECT), &url).await;
    assert_eq!(source.asked(), ["https://a.plisto-fixture.com:8443/"]);
}

/// Waits on the real clock until a discovery has recorded a proxy.
async fn until_detected(proxy: &Proxy) {
    let started = std::time::Instant::now();
    while proxy.kind() != ProxyKind::Detected {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "never recorded"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_discovery_leaves_the_failure_its_own_reason_and_records_later() {
    let (proxy, source, _) = proxy(Answer {
        delay: DISCOVERY_WAIT + Duration::from_secs(1),
        ..DETECTING
    });
    let started = std::time::Instant::now();
    let got = proxy.explain(network(CONNECT), &url()).await;
    let waited = started.elapsed();
    assert_eq!(got, network(CONNECT));
    assert!(waited >= DISCOVERY_WAIT, "{waited:?}");
    assert!(
        waited < DISCOVERY_WAIT + Duration::from_millis(800),
        "{waited:?}"
    );

    until_detected(&proxy).await;
    let got = proxy.explain(network(CONNECT), &url()).await;
    assert_eq!(got.reason, Some(PROXY));
    assert_eq!(source.discoveries(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_caller_dropped_mid_discovery_still_lets_it_record() {
    let (proxy, source, _) = proxy(Answer {
        delay: Duration::from_millis(400),
        ..DETECTING
    });
    let short = tokio::time::timeout(
        Duration::from_millis(50),
        proxy.explain(network(CONNECT), &url()),
    )
    .await;
    assert!(short.is_err());
    until_detected(&proxy).await;
    assert_eq!(source.discoveries(), 1);
    // Nothing is left holding the cache.
    let got = proxy.explain(network(DNS), &url()).await;
    assert_eq!(got.reason, Some(PROXY));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_discovery_that_panics_reads_none() {
    let (proxy, source, _) = proxy(Answer {
        discovery_panics: true,
        ..DETECTING
    });
    assert_eq!(
        proxy.explain(network(CONNECT), &url()).await,
        network(CONNECT)
    );
    assert_eq!(source.discoveries(), 1);
    assert_eq!(proxy.kind(), ProxyKind::None);
}

// ---- Windows ----

#[tokio::test(flavor = "multi_thread")]
#[ignore = "reads this machine's real proxy settings and may wait on auto-detect"]
async fn the_winhttp_readers_return() {
    let source = WinHttpSource;
    println!("current user: {:?}", source.current_user());
    println!("machine: {:?}", source.machine());
    println!("environment: {}", source.environment());
    let found = tokio::task::spawn_blocking(|| WinHttpSource.discover("https://example.com/"))
        .await
        .unwrap();
    println!("discovery: {found:?}");
    println!("kind: {:?}", Proxy::system().kind());
}

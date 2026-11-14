/*
 * The WebSocket opening handshake as RFC 6455 section 4 states it: the request headers Plisto adds,
 * and the checks on the server's 101 answer. The frame codec does no handshake of its own, so the
 * `Sec-WebSocket-Accept` digest is computed here, with the SHA-1 the protocol names.
 */

// -- Library Imports --
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::header::HeaderMap;
use ring::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use ring::rand::{SecureRandom, SystemRandom};

// -- Local Imports --
use super::super::{Refusal, HANDSHAKE};

pub const MAX_PROTOCOLS: usize = 8;
pub const MAX_PROTOCOL_BYTES: usize = 64;

const ACCEPT_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// RFC 7230 `tchar`.
fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// Refuses more than `MAX_PROTOCOLS`, a protocol that is not a token of at most
/// `MAX_PROTOCOL_BYTES`, and a repeat.
pub fn check_protocols(protocols: &[String]) -> Result<(), Refusal> {
    let bad = Refusal::invalid_args("A socket protocol is not valid.");
    if protocols.len() > MAX_PROTOCOLS {
        return Err(bad);
    }
    for (at, protocol) in protocols.iter().enumerate() {
        if protocol.len() > MAX_PROTOCOL_BYTES
            || !is_token(protocol)
            || protocols[..at].contains(protocol)
        {
            return Err(bad);
        }
    }
    Ok(())
}

/// A fresh `Sec-WebSocket-Key`: 16 bytes from the system random source. `None` when the source
/// fails.
pub fn new_key() -> Option<String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new().fill(&mut bytes).ok()?;
    Some(STANDARD.encode(bytes))
}

/// The `Sec-WebSocket-Accept` a server must answer `key` with.
pub fn accept_for(key: &str) -> String {
    let input = format!("{key}{ACCEPT_GUID}");
    STANDARD.encode(digest(&SHA1_FOR_LEGACY_USE_ONLY, input.as_bytes()))
}

/// Checks a 101 answer to a request sent with `key` and offering `offered`, and returns the protocol
/// the server chose. Every failure is `network` / `handshake`.
pub fn check_answer(
    headers: &HeaderMap,
    key: &str,
    offered: &[String],
) -> Result<Option<String>, Refusal> {
    let refused = Refusal::network(HANDSHAKE);
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let upgrade = text("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let connection = text("connection").is_some_and(|v| {
        v.split(',')
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    });
    let accepted = text("sec-websocket-accept") == Some(accept_for(key).as_str());
    // No extension was offered, so none may be in use.
    if !upgrade || !connection || !accepted || headers.contains_key("sec-websocket-extensions") {
        return Err(refused);
    }
    match headers.get("sec-websocket-protocol") {
        None => Ok(None),
        Some(value) => {
            let chosen = value.to_str().map_err(|_| refused)?;
            if offered.iter().any(|p| p == chosen) {
                Ok(Some(chosen.to_string()))
            } else {
                Err(refused)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn the_accept_value_matches_the_rfc_example() {
        assert_eq!(
            accept_for("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn keys_are_16_bytes_and_differ() {
        let (a, b) = (new_key().unwrap(), new_key().unwrap());
        assert_ne!(a, b);
        assert_eq!(STANDARD.decode(&a).unwrap().len(), 16);
    }

    #[test]
    fn protocols_are_tokens_within_their_limits() {
        let list = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(check_protocols(&[]).is_ok());
        assert!(check_protocols(&list(&["chat", "v2.json"])).is_ok());
        let longest = "p".repeat(MAX_PROTOCOL_BYTES);
        assert!(check_protocols(&list(&[&longest])).is_ok());
        let nine: Vec<String> = (0..9).map(|i| format!("p{i}")).collect();
        for refused in [
            list(&[""]),
            list(&["a b"]),
            list(&["a,b"]),
            list(&["chat", "chat"]),
            list(&[&"p".repeat(MAX_PROTOCOL_BYTES + 1)]),
            nine,
        ] {
            assert!(check_protocols(&refused).is_err(), "{refused:?}");
        }
    }

    fn answer(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn the_answer_must_upgrade_accept_the_key_and_choose_an_offered_protocol() {
        let key = new_key().unwrap();
        let accept = accept_for(&key);
        let offered = vec!["chat".to_string()];
        let good = [
            ("upgrade", "WebSocket"),
            ("connection", "keep-alive, Upgrade"),
            ("sec-websocket-accept", accept.as_str()),
        ];
        assert_eq!(check_answer(&answer(&good), &key, &offered), Ok(None));
        let mut chosen = good.to_vec();
        chosen.push(("sec-websocket-protocol", "chat"));
        assert_eq!(
            check_answer(&answer(&chosen), &key, &offered),
            Ok(Some("chat".into()))
        );

        let wrong_accept = accept_for("other");
        let refused = [
            vec![good[1], good[2]],
            vec![good[0], good[2]],
            vec![good[0], good[1]],
            vec![
                good[0],
                good[1],
                ("sec-websocket-accept", wrong_accept.as_str()),
            ],
            vec![
                good[0],
                good[1],
                good[2],
                ("sec-websocket-protocol", "other"),
            ],
            vec![
                good[0],
                good[1],
                good[2],
                ("sec-websocket-extensions", "deflate"),
            ],
        ];
        for headers in refused {
            let got = check_answer(&answer(&headers), &key, &offered);
            assert_eq!(got, Err(Refusal::network(HANDSHAKE)), "{headers:?}");
        }
    }
}

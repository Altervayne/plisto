/*
 * The guarded resolver. Every name a plugin client connects to is looked up here, every address in
 * the answer is judged by the address guard, and the client receives exactly the addresses that were
 * judged, so nothing resolves the name again between the check and the connect. The client asks
 * again for every new connection, so each redirect hop is checked on its own answer.
 */

// -- Library Imports --
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::pin::Pin;
use std::sync::Arc;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

// -- Local Imports --
use super::address::check_answer_with;
use super::{Refusal, DNS};

pub type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;

/// Turns a host name into addresses without blocking the calling thread.
pub trait Lookup: Send + Sync {
    fn lookup(&self, host: &str) -> LookupFuture;
}

/// The system resolver (getaddrinfo, so the hosts file applies), on a blocking thread.
pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup(&self, host: &str) -> LookupFuture {
        let host = host.to_string();
        Box::pin(async move {
            let answer = tauri::async_runtime::spawn_blocking(move || {
                (host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|addrs| addrs.map(|addr| addr.ip()).collect())
            });
            answer.await.map_err(io::Error::other)?
        })
    }
}

/// The developer loopback lookup: `localhost` is 127.0.0.1 and no other name resolves.
pub struct LocalhostLookup;

impl Lookup for LocalhostLookup {
    fn lookup(&self, host: &str) -> LookupFuture {
        let addrs = if host.eq_ignore_ascii_case("localhost") {
            vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]
        } else {
            Vec::new()
        };
        Box::pin(async move { Ok(addrs) })
    }
}

/// A refusal raised inside the resolver. It travels through the client's error chain so the request
/// ends with the guard's own code and reason.
#[derive(Debug)]
pub struct GuardError(pub Refusal);

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.message)
    }
}

impl Error for GuardError {}

pub struct GuardedResolver {
    lookup: Arc<dyn Lookup>,
    allowed: fn(IpAddr) -> bool,
}

impl GuardedResolver {
    pub fn new(lookup: Arc<dyn Lookup>, allowed: fn(IpAddr) -> bool) -> GuardedResolver {
        GuardedResolver { lookup, allowed }
    }
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let answer = self.lookup.lookup(name.as_str());
        let allowed = self.allowed;
        Box::pin(async move {
            let addrs = answer
                .await
                .map_err(|_| GuardError(Refusal::network(DNS)))?;
            check_answer_with(&addrs, allowed).map_err(GuardError)?;
            // Port 0 is replaced by the URL's port.
            let pinned: Addrs = Box::new(addrs.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(pinned)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::address::{allowed, dev_allowed};
    use super::super::test_server::ScriptedLookup;
    use super::super::{NetCode, BLOCKED_ADDRESS};
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    async fn resolve(
        resolver: &GuardedResolver,
        host: &str,
    ) -> Result<Vec<SocketAddr>, (NetCode, Option<&'static str>)> {
        match resolver.resolve(host.parse().unwrap()).await {
            Ok(addrs) => Ok(addrs.collect()),
            Err(error) => {
                let refusal = error.downcast_ref::<GuardError>().unwrap().0;
                Err((refusal.code, refusal.reason))
            }
        }
    }

    #[tokio::test]
    async fn the_checked_answer_is_exactly_what_the_client_gets() {
        let lookup = Arc::new(ScriptedLookup::default());
        lookup.answer(
            "one.example.com",
            &[&[ip("93.184.215.14"), ip("2606:4700::1111")]],
        );
        let resolver = GuardedResolver::new(lookup.clone(), allowed);
        let addrs = resolve(&resolver, "one.example.com").await.unwrap();
        assert_eq!(
            addrs,
            [
                SocketAddr::new(ip("93.184.215.14"), 0),
                SocketAddr::new(ip("2606:4700::1111"), 0)
            ]
        );
        assert_eq!(lookup.calls(), 1);
    }

    #[tokio::test]
    async fn a_refused_or_empty_answer_gives_nothing_to_connect_to() {
        let lookup = Arc::new(ScriptedLookup::default());
        lookup.answer(
            "mixed.example.com",
            &[&[ip("93.184.215.14"), ip("10.0.0.1")]],
        );
        lookup.answer("private.example.com", &[&[ip("169.254.169.254")]]);
        lookup.answer("empty.example.com", &[&[]]);
        let resolver = GuardedResolver::new(lookup, allowed);
        let blocked = (NetCode::Denied, Some(BLOCKED_ADDRESS));
        let dns = (NetCode::Network, Some(DNS));
        assert_eq!(resolve(&resolver, "mixed.example.com").await, Err(blocked));
        assert_eq!(
            resolve(&resolver, "private.example.com").await,
            Err(blocked)
        );
        assert_eq!(resolve(&resolver, "empty.example.com").await, Err(dns));
        // The scripted lookup fails for a name it was not given.
        assert_eq!(resolve(&resolver, "unknown.example.com").await, Err(dns));
    }

    #[tokio::test]
    async fn the_dev_resolver_reaches_127_0_0_1_only() {
        let resolver = GuardedResolver::new(Arc::new(LocalhostLookup), dev_allowed);
        assert_eq!(
            resolve(&resolver, "localhost").await,
            Ok(vec![SocketAddr::new(ip("127.0.0.1"), 0)])
        );
        assert_eq!(
            resolve(&resolver, "example.com").await,
            Err((NetCode::Network, Some(DNS)))
        );
    }
}

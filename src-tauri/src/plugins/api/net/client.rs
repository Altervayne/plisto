/*
 * The HTTP clients behind plugin requests, one of each per process and shared by every plugin. The
 * public client speaks HTTPS only (HTTP/1.1, system roots), through no proxy, follows no redirect
 * itself, keeps no cookies and asks for no compression; its resolver checks every address before
 * the connection. The developer loopback client is the same over plain HTTP and reaches 127.0.0.1
 * only; it is built the first time a consented dev origin is used.
 */

// -- Library Imports --
use std::net::IpAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::redirect::Policy;
#[cfg(test)]
use reqwest::Certificate;
use reqwest::Client;

// -- Local Imports --
use super::address::{allowed, dev_allowed};
#[cfg(test)]
use super::proxy::{ScriptedSource, SystemClock};
use super::proxy::Proxy;
use super::resolve::{GuardedResolver, LocalhostLookup, Lookup, SystemLookup};
use super::{Refusal, TLS};
use crate::plugins::manifest::OriginKind;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const POOL_IDLE: Duration = Duration::from_secs(30);

pub struct Clients {
    public: OnceLock<Option<Client>>,
    dev: OnceLock<Option<Client>>,
    lookup: Arc<dyn Lookup>,
    allowed: fn(IpAddr) -> bool,
    /// Read only to explain a failure; no client goes through a proxy.
    proxy: Proxy,
    /// Trusted instead of the system store when set.
    #[cfg(test)]
    root: Option<Certificate>,
}

static SHARED: OnceLock<Clients> = OnceLock::new();

impl Clients {
    pub fn shared() -> &'static Clients {
        SHARED.get_or_init(|| Clients {
            public: OnceLock::new(),
            dev: OnceLock::new(),
            lookup: Arc::new(SystemLookup),
            allowed,
            proxy: Proxy::system(),
            #[cfg(test)]
            root: None,
        })
    }

    /// Clients that trust only `root` and resolve through `lookup` under the `allowed` policy. They
    /// see no proxy unless `with_proxy` sets one.
    #[cfg(test)]
    pub fn for_tests(
        lookup: Arc<dyn Lookup>,
        allowed: fn(IpAddr) -> bool,
        root: Certificate,
    ) -> Clients {
        Clients {
            public: OnceLock::new(),
            dev: OnceLock::new(),
            lookup,
            allowed,
            proxy: Proxy::new(Arc::new(ScriptedSource::default()), Arc::new(SystemClock)),
            root: Some(root),
        }
    }

    #[cfg(test)]
    pub fn with_proxy(self, proxy: Proxy) -> Clients {
        Clients { proxy, ..self }
    }

    /// The proxy state that names a transport failure `proxy`.
    pub fn proxy(&self) -> &Proxy {
        &self.proxy
    }

    /// The client for a URL of this kind. A client that cannot be built (its TLS setup failed) refuses
    /// every request with `network` / `tls`.
    pub fn get(&self, kind: OriginKind) -> Result<&Client, Refusal> {
        let client = match kind {
            OriginKind::Public => self.public.get_or_init(|| {
                let resolver = GuardedResolver::new(self.lookup.clone(), self.allowed);
                self.build(resolver, true)
            }),
            OriginKind::DevLoopback => self.dev.get_or_init(|| {
                let resolver = GuardedResolver::new(Arc::new(LocalhostLookup), dev_allowed);
                self.build(resolver, false)
            }),
        };
        client.as_ref().ok_or(Refusal::network(TLS))
    }

    fn build(&self, resolver: GuardedResolver, https_only: bool) -> Option<Client> {
        // The updater installs the same provider; whichever builds first installs it.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let builder = Client::builder()
            .tls_backend_rustls()
            .https_only(https_only)
            .no_proxy()
            .redirect(Policy::none())
            .referer(false)
            .dns_resolver(resolver)
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(POOL_IDLE)
            .http1_only();
        #[cfg(test)]
        let builder = match &self.root {
            Some(root) => builder.tls_certs_only([root.clone()]),
            None => builder,
        };
        builder.build().ok()
    }
}

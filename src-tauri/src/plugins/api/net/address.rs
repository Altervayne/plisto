/*
 * The address guard: whether a resolved address may be connected to on a plugin's behalf. IPv4 is
 * allowed outside a table of refused ranges; IPv6 only inside 2000::/3 and outside its own table.
 * IPv4 carried inside IPv6 (mapped, NAT64, 6to4) is judged by the IPv4 rules.
 */

// -- Library Imports --
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

// -- Local Imports --
use super::{Refusal, BLOCKED_ADDRESS, DNS};

/// Refused IPv4 ranges as (network, prefix length).
const REFUSED_V4: [(Ipv4Addr, u32); 16] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),          // "this network"
    (Ipv4Addr::new(10, 0, 0, 0), 8),         // private
    (Ipv4Addr::new(100, 64, 0, 0), 10), // shared address space (CGNAT), holds 100.100.100.200 metadata
    (Ipv4Addr::new(127, 0, 0, 0), 8),   // loopback
    (Ipv4Addr::new(169, 254, 0, 0), 16), // link-local, holds 169.254.169.254 metadata
    (Ipv4Addr::new(172, 16, 0, 0), 12), // private
    (Ipv4Addr::new(192, 0, 0, 0), 24),  // IETF protocol assignments
    (Ipv4Addr::new(192, 0, 2, 0), 24),  // documentation TEST-NET-1
    (Ipv4Addr::new(192, 88, 99, 0), 24), // deprecated 6to4 relay anycast
    (Ipv4Addr::new(192, 168, 0, 0), 16), // private
    (Ipv4Addr::new(198, 18, 0, 0), 15), // benchmarking
    (Ipv4Addr::new(198, 51, 100, 0), 24), // documentation TEST-NET-2
    (Ipv4Addr::new(203, 0, 113, 0), 24), // documentation TEST-NET-3
    (Ipv4Addr::new(224, 0, 0, 0), 4),   // multicast
    (Ipv4Addr::new(240, 0, 0, 0), 4),   // reserved
    (Ipv4Addr::new(255, 255, 255, 255), 32), // limited broadcast
];

/// Refused IPv6 ranges as (network, prefix length). The rows outside 2000::/3 are refused by that
/// rule anyway; they are listed so the table names every non-public range.
const REFUSED_V6: [(Ipv6Addr, u32); 13] = [
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0), 128), // unspecified
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1), 128), // loopback
    (Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64), // discard-only
    (Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48), // local-use NAT64
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23), // IETF protocol assignments: benchmarking, ORCHID, others
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 32), // Teredo
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32), // documentation
    (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20), // documentation
    (Ipv6Addr::new(0x5f00, 0, 0, 0, 0, 0, 0, 0), 16), // segment routing SIDs
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),  // unique local, holds fd00:ec2::254 metadata
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10), // link-local
    (Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10), // deprecated site-local
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),  // multicast
];

const GLOBAL_UNICAST: (Ipv6Addr, u32) = (Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3);
const MAPPED: (Ipv6Addr, u32) = (Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0, 0), 96);
const NAT64: (Ipv6Addr, u32) = (Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96);
const SIX_TO_FOUR: (Ipv6Addr, u32) = (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16);

fn in_v4(ip: u32, (net, len): (Ipv4Addr, u32)) -> bool {
    let mask = u32::MAX.checked_shl(32 - len).unwrap_or(0);
    ip & mask == u32::from(net)
}

fn in_v6(ip: u128, (net, len): (Ipv6Addr, u32)) -> bool {
    let mask = u128::MAX.checked_shl(128 - len).unwrap_or(0);
    ip & mask == u128::from(net)
}

fn allowed_v4(ip: Ipv4Addr) -> bool {
    let bits = u32::from(ip);
    !REFUSED_V4.iter().any(|&range| in_v4(bits, range))
}

fn allowed_v6(ip: Ipv6Addr) -> bool {
    let bits = u128::from(ip);
    if in_v6(bits, MAPPED) || in_v6(bits, NAT64) {
        return allowed_v4(Ipv4Addr::from(bits as u32));
    }
    if REFUSED_V6.iter().any(|&range| in_v6(bits, range)) {
        return false;
    }
    // 6to4 carries its IPv4 in bits 16 to 47.
    if in_v6(bits, SIX_TO_FOUR) {
        return allowed_v4(Ipv4Addr::from((bits >> 80) as u32));
    }
    in_v6(bits, GLOBAL_UNICAST)
}

/// Whether an address is public unicast and may be connected to.
pub fn allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => allowed_v4(v4),
        IpAddr::V6(v6) => allowed_v6(v6),
    }
}

/// Judges one resolver answer. A single refused address refuses the whole answer, so a name cannot
/// mix a public address with a private one and let the connection pick.
pub fn check_answer(addrs: &[IpAddr]) -> Result<(), Refusal> {
    check_answer_with(addrs, allowed)
}

/// `check_answer` under another address policy, such as the developer loopback one.
pub fn check_answer_with(addrs: &[IpAddr], allowed: fn(IpAddr) -> bool) -> Result<(), Refusal> {
    if addrs.is_empty() {
        return Err(Refusal::network(DNS));
    }
    if addrs.iter().all(|&ip| allowed(ip)) {
        Ok(())
    } else {
        Err(Refusal::denied(BLOCKED_ADDRESS))
    }
}

/// The developer loopback path connects to 127.0.0.1 and nothing else.
pub fn dev_allowed(ip: IpAddr) -> bool {
    ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
}

#[cfg(test)]
mod tests {
    use super::super::NetCode;
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse()
            .unwrap_or_else(|_| panic!("bad test address {text}"))
    }

    // A refused range: its first and last address, and each neighbor with whether it is allowed.
    // A neighbor that falls in another refused range is expected refused.
    struct Edge {
        first: &'static str,
        last: &'static str,
        below: Option<(&'static str, bool)>,
        above: Option<(&'static str, bool)>,
    }

    fn assert_edges(edges: &[Edge]) {
        for edge in edges {
            assert!(!allowed(ip(edge.first)), "{} should be refused", edge.first);
            assert!(!allowed(ip(edge.last)), "{} should be refused", edge.last);
            for (addr, ok) in edge.below.iter().chain(edge.above.iter()) {
                assert_eq!(allowed(ip(addr)), *ok, "{addr} next to {}", edge.first);
            }
        }
    }

    #[test]
    fn every_refused_ipv4_range_holds_at_its_edges() {
        assert_edges(&[
            Edge {
                first: "0.0.0.0",
                last: "0.255.255.255",
                below: None,
                above: Some(("1.0.0.0", true)),
            },
            Edge {
                first: "10.0.0.0",
                last: "10.255.255.255",
                below: Some(("9.255.255.255", true)),
                above: Some(("11.0.0.0", true)),
            },
            Edge {
                first: "100.64.0.0",
                last: "100.127.255.255",
                below: Some(("100.63.255.255", true)),
                above: Some(("100.128.0.0", true)),
            },
            Edge {
                first: "127.0.0.0",
                last: "127.255.255.255",
                below: Some(("126.255.255.255", true)),
                above: Some(("128.0.0.0", true)),
            },
            Edge {
                first: "169.254.0.0",
                last: "169.254.255.255",
                below: Some(("169.253.255.255", true)),
                above: Some(("169.255.0.0", true)),
            },
            Edge {
                first: "172.16.0.0",
                last: "172.31.255.255",
                below: Some(("172.15.255.255", true)),
                above: Some(("172.32.0.0", true)),
            },
            Edge {
                first: "192.0.0.0",
                last: "192.0.0.255",
                below: Some(("191.255.255.255", true)),
                above: Some(("192.0.1.0", true)),
            },
            Edge {
                first: "192.0.2.0",
                last: "192.0.2.255",
                below: Some(("192.0.1.255", true)),
                above: Some(("192.0.3.0", true)),
            },
            Edge {
                first: "192.88.99.0",
                last: "192.88.99.255",
                below: Some(("192.88.98.255", true)),
                above: Some(("192.88.100.0", true)),
            },
            Edge {
                first: "192.168.0.0",
                last: "192.168.255.255",
                below: Some(("192.167.255.255", true)),
                above: Some(("192.169.0.0", true)),
            },
            Edge {
                first: "198.18.0.0",
                last: "198.19.255.255",
                below: Some(("198.17.255.255", true)),
                above: Some(("198.20.0.0", true)),
            },
            Edge {
                first: "198.51.100.0",
                last: "198.51.100.255",
                below: Some(("198.51.99.255", true)),
                above: Some(("198.51.101.0", true)),
            },
            Edge {
                first: "203.0.113.0",
                last: "203.0.113.255",
                below: Some(("203.0.112.255", true)),
                above: Some(("203.0.114.0", true)),
            },
            Edge {
                first: "224.0.0.0",
                last: "239.255.255.255",
                below: Some(("223.255.255.255", true)),
                above: Some(("240.0.0.0", false)),
            },
            Edge {
                first: "240.0.0.0",
                last: "255.255.255.255",
                below: Some(("239.255.255.255", false)),
                above: None,
            },
            Edge {
                first: "255.255.255.255",
                last: "255.255.255.255",
                below: Some(("255.255.255.254", false)),
                above: None,
            },
        ]);
    }

    #[test]
    fn every_refused_ipv6_range_holds_at_its_edges() {
        assert_edges(&[
            Edge {
                first: "::",
                last: "::",
                below: None,
                above: Some(("::1", false)),
            },
            Edge {
                first: "::1",
                last: "::1",
                below: Some(("::", false)),
                above: Some(("::2", false)),
            },
            Edge {
                first: "100::",
                last: "100::ffff:ffff:ffff:ffff",
                below: Some(("ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false)),
                above: Some(("100:0:0:1::", false)),
            },
            Edge {
                first: "64:ff9b:1::",
                last: "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
                below: Some(("64:ff9b:0:ffff:ffff:ffff:ffff:ffff", false)),
                above: Some(("64:ff9b:2::", false)),
            },
            Edge {
                first: "2001::",
                last: "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true)),
                above: Some(("2001:200::", true)),
            },
            Edge {
                first: "2001::",
                last: "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true)),
                above: Some(("2001:1::", false)),
            },
            Edge {
                first: "2001:db8::",
                last: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", true)),
                above: Some(("2001:db9::", true)),
            },
            Edge {
                first: "3fff::",
                last: "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true)),
                above: Some(("3fff:1000::", true)),
            },
            Edge {
                first: "5f00::",
                last: "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false)),
                above: Some(("5f01::", false)),
            },
            Edge {
                first: "fc00::",
                last: "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false)),
                above: Some(("fe00::", false)),
            },
            Edge {
                first: "fe80::",
                last: "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false)),
                above: Some(("fec0::", false)),
            },
            Edge {
                first: "fec0::",
                last: "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false)),
                above: Some(("ff00::", false)),
            },
            Edge {
                first: "ff00::",
                last: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
                below: Some(("feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false)),
                above: None,
            },
        ]);
    }

    #[test]
    fn ipv6_is_allowed_only_inside_2000_slash_3() {
        let cases = [
            ("1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false),
            ("2000::", true),
            ("2606:4700:4700::1111", true),
            ("2a00:1450:4007:80f::200e", true),
            ("3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("4000::", false),
            ("::0.0.0.1", false),
            ("::8.8.8.8", false),
        ];
        for (addr, ok) in cases {
            assert_eq!(allowed(ip(addr)), ok, "{addr}");
        }
    }

    #[test]
    fn public_ipv4_is_allowed() {
        for addr in ["1.1.1.1", "8.8.8.8", "93.184.215.14", "223.255.255.255"] {
            assert!(allowed(ip(addr)), "{addr}");
        }
    }

    #[test]
    fn embedded_ipv4_is_judged_by_the_ipv4_rules() {
        let cases = [
            ("::ffff:192.168.1.1", false),
            ("::ffff:127.0.0.1", false),
            ("::ffff:169.254.169.254", false),
            ("::ffff:0.0.0.0", false),
            ("::ffff:8.8.8.8", true),
            ("64:ff9b::192.168.1.1", false),
            ("64:ff9b::10.0.0.1", false),
            ("64:ff9b::100.100.100.200", false),
            ("64:ff9b::8.8.8.8", true),
            // One bit past each /96 is plain IPv6 outside 2000::/3.
            ("::1:ffff:8.8.8.8", false),
            ("64:ff9b::1:808:808", false),
        ];
        for (addr, ok) in cases {
            assert_eq!(allowed(ip(addr)), ok, "{addr}");
        }
    }

    #[test]
    fn six_to_four_follows_its_embedded_ipv4() {
        let cases = [
            ("2002::", false),                                  // 0.0.0.0
            ("2002:c0a8:101::", false),                         // 192.168.1.1
            ("2002:7f00:1::", false),                           // 127.0.0.1
            ("2002:a9fe:a9fe::1", false),                       // 169.254.169.254
            ("2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false), // 255.255.255.255
            ("2002:808:808::", true),                           // 8.8.8.8
            ("2002:101:101:1:2:3:4:5", true),                   // 1.1.1.1
            ("2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true),
            ("2003::", true),
        ];
        for (addr, ok) in cases {
            assert_eq!(allowed(ip(addr)), ok, "{addr}");
        }
    }

    #[test]
    fn metadata_addresses_are_refused() {
        for addr in ["169.254.169.254", "100.100.100.200", "fd00:ec2::254"] {
            assert!(!allowed(ip(addr)), "{addr}");
        }
    }

    #[test]
    fn a_mixed_answer_is_refused_whole() {
        let answer = [ip("8.8.8.8"), ip("2606:4700:4700::1111"), ip("10.0.0.1")];
        assert_eq!(
            check_answer(&answer).unwrap_err().reason,
            Some(BLOCKED_ADDRESS)
        );
        assert_eq!(check_answer(&answer).unwrap_err().code, NetCode::Denied);
        let answer = [ip("::1"), ip("1.1.1.1")];
        assert_eq!(
            check_answer(&answer).unwrap_err().reason,
            Some(BLOCKED_ADDRESS)
        );
    }

    #[test]
    fn a_public_answer_passes() {
        assert_eq!(
            check_answer(&[ip("8.8.8.8"), ip("2606:4700:4700::1111")]),
            Ok(())
        );
    }

    #[test]
    fn an_empty_answer_is_a_dns_failure() {
        let refusal = check_answer(&[]).unwrap_err();
        assert_eq!(refusal.code, NetCode::Network);
        assert_eq!(refusal.reason, Some(DNS));
    }

    #[test]
    fn the_dev_path_allows_only_127_0_0_1() {
        assert!(dev_allowed(ip("127.0.0.1")));
        for addr in [
            "127.0.0.2",
            "::1",
            "::ffff:127.0.0.1",
            "0.0.0.0",
            "8.8.8.8",
            "10.0.0.1",
        ] {
            assert!(!dev_allowed(ip(addr)), "{addr}");
        }
    }
}

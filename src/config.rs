/** config.rs — process configuration, the shared logger, and small string constants. See ARCHITECTURE.md. */
use std::sync::OnceLock;

pub const SIDECAR_VERSION: &str = "1.1.1"; // x-release-please-version

/// Every setting here comes from an `ISA_`-prefixed variable, for the reason given in ARCHITECTURE.md
/// ("Why ISA_"). Parsing is strict and fails loudly at boot: a typo'd boolean must never fail
/// open, and a bad cadence must never become a zero-length interval.
/// An address peers are told to dial: `host:port`, the host an IPv4 literal or a hostname.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdvertiseAddr {
    pub host: String,
    pub port: u16,
}

#[derive(Clone)]
pub struct Config {
    pub immich_url: String,
    pub api_key: String,
    pub name: String,
    pub port: u16,
    pub p2p_port: u16,
    pub data_dir: String,
    pub sync_poll_ms: u64,
    pub comment_poll_ms: u64,
    pub mirror_album_template: String,
    pub cache_max_mb: u64,
    pub max_body_kb: u64,
    pub link_join_requires_password: bool,
    pub bot_quota_mb: u64,
    pub trace_sync: bool,
    pub publish_user_directory: bool,
    pub relay: bool,
    pub advertise_addr: Option<AdvertiseAddr>,
    pub reconcile_debug: bool,
    pub test_hooks: bool,
}

/// The API key is a secret: a struct that holds one must not print it just because somebody
/// wrote `{cfg:?}`. Everything else stays inspectable.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("immich_url", &self.immich_url)
            .field("api_key", &"[REDACTED]")
            .field("name", &self.name)
            .field("port", &self.port)
            .field("p2p_port", &self.p2p_port)
            .field("data_dir", &self.data_dir)
            .field("sync_poll_ms", &self.sync_poll_ms)
            .field("comment_poll_ms", &self.comment_poll_ms)
            .field("mirror_album_template", &self.mirror_album_template)
            .field("cache_max_mb", &self.cache_max_mb)
            .field("max_body_kb", &self.max_body_kb)
            .field(
                "link_join_requires_password",
                &self.link_join_requires_password,
            )
            .field("bot_quota_mb", &self.bot_quota_mb)
            .field("trace_sync", &self.trace_sync)
            .field("publish_user_directory", &self.publish_user_directory)
            .field("relay", &self.relay)
            .field(
                "advertise_addr",
                &self
                    .advertise_addr
                    .as_ref()
                    .map(|a| format!("{}:{}", a.host, a.port)),
            )
            .field("reconcile_debug", &self.reconcile_debug)
            .field("test_hooks", &self.test_hooks)
            .finish()
    }
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ConfigError {}

fn env_bool(name: &str, dflt: bool) -> Result<bool, ConfigError> {
    let raw = match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => raw,
        _ => return Ok(dflt),
    };
    match raw.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(ConfigError(format!(
            "{name}={raw} is not a boolean — use true/false (or 1/0, yes/no, on/off)"
        ))),
    }
}

fn env_int(name: &str, dflt: u64, min: u64) -> Result<u64, ConfigError> {
    let raw = match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => raw,
        _ => return Ok(dflt),
    };
    match raw.trim().parse::<u64>() {
        Ok(n) if n >= min => Ok(n),
        _ => Err(ConfigError(format!(
            "{name}={raw} is not a whole number >= {min}"
        ))),
    }
}

/// A port, in range. `env_int` alone is not enough: `ISA_PORT=70000` would wrap to 4464 on the cast
/// to `u16` and bind a port nobody asked for, so the bound is checked while the error can still name
/// the variable. `0` stays legal for `ISA_P2P_PORT`, where it means "pick a random one".
fn env_port(name: &str, dflt: u16, min: u16) -> Result<u16, ConfigError> {
    parse_port(name, env_int(name, dflt as u64, min as u64)?)
}

fn parse_port(name: &str, raw: u64) -> Result<u16, ConfigError> {
    u16::try_from(raw)
        .map_err(|_| ConfigError(format!("{name}={raw} is not a port (highest is 65535)")))
}

fn env_str(name: &str, dflt: &str) -> String {
    match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => raw,
        _ => dflt.to_string(),
    }
}

/// Strict `host:port` for `ISA_ADVERTISE_ADDR`. IPv6 is refused because the transport binds
/// `0.0.0.0:ISA_P2P_PORT` — a peer sent to an IPv6 address would find nothing listening there.
/// The host may be a hostname: `advertised_addresses` resolves it when a link is minted, so a
/// dynamic address stays current without a restart.
pub fn parse_advertise_addr(raw: &str) -> Option<AdvertiseAddr> {
    let (host, port) = raw.trim().rsplit_once(':')?;
    if host.is_empty() || host.contains(':') || host.starts_with('[') {
        return None;
    }
    if !host.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
    {
        return None;
    }
    let port = port.parse::<u16>().ok()?;
    (port >= 1).then_some(AdvertiseAddr {
        host: host.to_string(),
        port,
    })
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        // Read and check this first: the process cannot run without it, so proving it here once
        // makes `api_key` a plain String everywhere instead of an Option.
        let api_key = std::env::var("ISA_IMMICH_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| ConfigError("ISA_IMMICH_API_KEY required".into()))?;

        Ok(Config {
            immich_url: env_str("ISA_IMMICH_URL", "http://immich-server:2283"),
            api_key,
            name: env_str("ISA_HOUSEHOLD_NAME", "Unnamed household"),
            port: env_port("ISA_PORT", 8300, 1)?,
            // STABLE by default rather than random: a peer remembers where it last reached us, so a
            // random port makes that memory wrong across a restart. 0 restores a random port.
            p2p_port: env_port("ISA_P2P_PORT", 8300, 0)?,
            data_dir: env_str("ISA_DATA_DIR", "/data"),
            sync_poll_ms: env_int("ISA_SYNC_POLL_MS", 20000, 1000)?,
            comment_poll_ms: env_int("ISA_COMMENT_POLL_MS", 5000, 500)?,
            mirror_album_template: env_str("ISA_MIRROR_ALBUM_TEMPLATE", "{name}"),
            cache_max_mb: env_int("ISA_CACHE_MAX_MB", 512, 0)?,
            max_body_kb: env_int("ISA_MAX_BODY_KB", 1024, 1)?,
            link_join_requires_password: env_bool("ISA_LINK_JOIN_REQUIRES_PASSWORD", false)?,
            bot_quota_mb: env_int("ISA_BOT_QUOTA_MB", 0, 0)?,
            trace_sync: env_bool("ISA_TRACE_SYNC", false)?,
            publish_user_directory: env_bool("ISA_PUBLISH_USER_DIRECTORY", true)?,
            // Strictly parsed BECAUSE this is the privacy setting: a typo must halt, never fail open.
            relay: env_bool("ISA_RELAY", true)?,
            // The address peers should dial when the ones this container can see for itself are
            // not the ones they can reach — a forwarded UDP port, or a LAN/VPN address. Read by
            // `advertised_addresses` and carried by pairing tickets and share-page tokens.
            advertise_addr: match std::env::var("ISA_ADVERTISE_ADDR") {
                Ok(raw) if !raw.is_empty() => {
                    Some(parse_advertise_addr(&raw).ok_or_else(|| {
                        ConfigError(format!(
                            "{raw} is not <host>:<port> (an IPv4 address or a hostname)"
                        ))
                    })?)
                }
                _ => None,
            },
            reconcile_debug: env_bool("ISA_RECONCILE_DEBUG", false)?,
            test_hooks: env_bool("ISA_TEST_HOOKS", false)?,
        })
    }
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// Install the process-wide config. Called once from `main` before anything reads `cfg()`.
pub fn install(config: Config) {
    let _ = CONFIG.set(config);
}

/// The process-wide configuration. Panics if read before `install` — a wiring bug, not a
/// configuration error, so it should be impossible rather than handled.
pub fn cfg() -> &'static Config {
    CONFIG.get().expect("config::install must run before cfg()")
}

/// Write one timestamped line. The `log!` macro is the interface — this is named for what it does
/// to the world so it cannot be confused with the macro at an import site.
pub fn write_log_line(args: std::fmt::Arguments<'_>) {
    println!("{} {}", iso_now(), one_line(&args.to_string()));
}

/// Newlines are collapsed so text that arrived from a peer cannot forge a second log entry. Mirrors
/// `oneLine` in config.ts.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut after_newline = false;
    for ch in text.chars() {
        if matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !after_newline {
                out.push(' ');
                after_newline = true;
            }
        } else {
            out.push(ch);
            after_newline = false;
        }
    }
    out
}

/// `log!` mirrors config.ts's `log(...)`: a timestamp, then the message.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::config::write_log_line(format_args!($($arg)*)) };
}

/// Per-stage sync trace, gated by ISA_TRACE_SYNC. Off by default because it is a line per await;
/// it exists because the failure mode it diagnoses is a SILENT wait.
#[macro_export]
macro_rules! trace {
    ($($arg:tt)*) => {
        if $crate::config::cfg().trace_sync { $crate::config::write_log_line(format_args!($($arg)*)) }
    };
}

/// The head of an id for a log line — one width everywhere, cut on a CHAR boundary so a log line
/// cannot panic on a multi-byte id.
pub fn short_id(id: &str) -> &str {
    const SHORT_ID_CHARS: usize = 8;
    match id.char_indices().nth(SHORT_ID_CHARS) {
        Some((byte_index, _)) => &id[..byte_index],
        None => id,
    }
}

/// RFC3339 UTC with milliseconds, matching the timestamp shape the e2e suite parses.
pub fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (y, mo, d, h, mi, s) = civil_from_unix(secs as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Days-from-civil inverse (Howard Hinnant's algorithm) — no chrono dependency for one timestamp.
fn civil_from_unix(unix: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = unix.div_euclid(86_400);
    let rem = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

pub const UTILITY_SUFFIX: &str = " (via shared albums)";

/// Email domain for the bot users this addon creates. `.internal` is ICANN-reserved for
/// private-use networks, so these addresses never resolve and never receive mail — while still
/// reading as deliberate to a human who sees one in Immich's People list.
pub const UTILITY_EMAIL_DOMAIN: &str = "immich-shared-albums.internal";

/// Domains earlier versions used for bot accounts. Still recognised so a bot made by an older
/// version stays classified as a bot. Never used for NEW bots.
pub const LEGACY_UTILITY_DOMAINS: [&str; 2] = ["immich-shared-albums.invalid", "sidecar.local"];

/// Is this one of our bot users? The single source of truth — never inline the check. The leading
/// `@` is required, so a subdomain lookalike is not a match.
pub fn is_utility_email(email: Option<&str>) -> bool {
    let Some((_, domain)) = email.and_then(|e| e.rsplit_once('@')) else {
        return false;
    };
    // Allocation-free: this filters every user in every directory poll.
    domain == UTILITY_EMAIL_DOMAIN || LEGACY_UTILITY_DOMAINS.contains(&domain)
}

/// One local account per remote person, doing both jobs: it owns their mirrored photos, and it is
/// what a human picks in Immich's album picker to share with them. `person-` is keyed on the
/// person's user id on THEIR OWN server, so the same human resolves to the same local account
/// whether we meet them through a directory or a relayed photo. Never keyed by display name.
pub mod bot_prefix {
    /// One remote person, keyed by their user id on their home server.
    pub const PERSON: &str = "person-";
    /// This household's own bot: the account that speaks for the addon.
    pub const HOUSE: &str = "house-";
}

/// Display names, by what the user is actually doing when they read them.
pub mod marker_name {
    /// An invite marker is a DESTINATION you pick in Immich's album picker, so it names the person
    /// and the server the album is going to.
    pub fn person(person_name: &str, peer_name: &str) -> String {
        let peer = peer_name.to_lowercase();
        let suffix = if peer.ends_with("server") || peer.ends_with("servers") {
            ""
        } else {
            " server"
        };
        format!("{person_name} (via {peer_name}{suffix})")
    }
}

/// Recover a person's real name from whatever decoration a local account carries.
///
/// Accounts are named for what they are locally — "(via The Smiths server)" for someone on a
/// linked server — but the name that goes ON THE WIRE must be the person's own. Greedy on
/// purpose: it cuts at the FIRST "(via ", so a decoration that accumulated one layer per relay
/// hop ("Nan (via B server) (via shared albums)") collapses back to the person in one pass.
/// Callers must gate on the account being a BOT — a human genuinely named with a trailing
/// "(via …)" must travel as written.
pub fn person_name(name: Option<&str>) -> String {
    let Some(name) = name else {
        return String::new();
    };
    let trimmed = name.trim_end();
    // `\(via ` needs no leading whitespace to match, so "Bob(via X)" strips too.
    let without_decoration = if trimmed.ends_with(')') {
        match trimmed.find("(via ") {
            Some(idx) => &trimmed[..idx],
            None => trimmed,
        }
    } else {
        trimmed
    };
    without_decoration.trim().to_string()
}

/// The URL prefix this addon owns on the Immich origin. Both peers must agree on this — a member's
/// share page probes the ORIGIN's prefix, so it could never be per-install configuration.
pub const ROUTE_PREFIX: &str = "/immich-shared-albums";

/// A config for tests. `cfg` is a BOOT singleton — installed once, never mutated — so every test
/// module shares ONE, rather than each installing its own and racing for the OnceLock. That race
/// was real: whichever module ran first decided the data dir, and a test asserting on 0700
/// permissions then failed because another module's config had won.
#[cfg(test)]
pub fn install_test_config() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        install(Config {
            immich_url: "http://127.0.0.1:1".into(),
            api_key: "test".into(),
            name: "Test household".into(),
            port: 8300,
            p2p_port: 8300,
            data_dir: "/tmp/isa-test-data".into(),
            sync_poll_ms: 20000,
            comment_poll_ms: 5000,
            mirror_album_template: "{name}".into(),
            cache_max_mb: 0,
            max_body_kb: 1024,
            link_join_requires_password: false,
            bot_quota_mb: 0,
            trace_sync: false,
            publish_user_directory: true,
            relay: true,
            advertise_addr: None,
            reconcile_debug: false,
            test_hooks: false,
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_cannot_forge_a_second_log_line() {
        let forged = "album \"x\"\nforged: identity rotated";
        assert_eq!(one_line(forged), "album \"x\" forged: identity rotated");
        assert_eq!(one_line("two\r\n\r\nbreaks"), "two breaks");
        assert_eq!(one_line("nothing to collapse"), "nothing to collapse");
    }

    #[test]
    fn a_port_out_of_range_is_refused_rather_than_wrapped() {
        assert_eq!(parse_port("ISA_PORT", 8300).unwrap(), 8300);
        assert_eq!(parse_port("ISA_PORT", 65535).unwrap(), 65535);
        assert_eq!(
            parse_port("ISA_P2P_PORT", 0).unwrap(),
            0,
            "0 means a random port"
        );
        let over = parse_port("ISA_PORT", 70000).unwrap_err();
        assert_eq!(over.0, "ISA_PORT=70000 is not a port (highest is 65535)");
    }

    #[test]
    fn utility_email_matches_current_and_legacy_domains() {
        assert!(is_utility_email(Some(
            "person-abc@immich-shared-albums.internal"
        )));
        assert!(is_utility_email(Some("x@immich-shared-albums.invalid")));
        assert!(is_utility_email(Some("x@sidecar.local")));
    }

    #[test]
    fn utility_email_rejects_subdomain_lookalikes_and_humans() {
        assert!(!is_utility_email(Some(
            "x@evil.immich-shared-albums.internal"
        )));
        assert!(!is_utility_email(Some("nan@example.com")));
        assert!(!is_utility_email(None));
    }

    #[test]
    fn bot_prefixes_are_disjoint() {
        // The invariant the whole bot namespace rests on: no prefix may begin another.
        assert!(!bot_prefix::PERSON.starts_with(bot_prefix::HOUSE));
        assert!(!bot_prefix::HOUSE.starts_with(bot_prefix::PERSON));
    }

    #[test]
    fn person_name_strips_one_decoration_per_call_from_the_left() {
        assert_eq!(person_name(Some("Nan (via B server)")), "Nan");
        // The doubled form a relay hop produces: cut at the FIRST "(via ", so it collapses in one pass.
        assert_eq!(
            person_name(Some("Nan (via B server) (via shared albums)")),
            "Nan"
        );
        assert_eq!(person_name(Some("  Bob  ")), "Bob");
        assert_eq!(person_name(None), "");
    }

    #[test]
    fn person_name_leaves_a_human_untouched() {
        assert_eq!(person_name(Some("Ada Lovelace")), "Ada Lovelace");
        assert_eq!(person_name(Some("Ada (Lovelace)")), "Ada (Lovelace)");
    }

    #[test]
    fn short_id_cuts_to_one_width_on_a_char_boundary() {
        assert_eq!(short_id("0123456789abcdef"), "01234567");
        assert_eq!(short_id("short"), "short", "a shorter id is itself");
        // The cut is on a CHAR boundary, so a log line cannot panic on a multi-byte id.
        let multibyte = "ßßßßßßßßßß";
        assert_eq!(short_id(multibyte).chars().count(), 8);
    }

    #[test]
    fn marker_name_does_not_stack_server_twice() {
        assert_eq!(
            marker_name::person("Bob", "Bob's server"),
            "Bob (via Bob's server)"
        );
        assert_eq!(
            marker_name::person("Nan", "The Smiths"),
            "Nan (via The Smiths server)"
        );
    }

    #[test]
    fn an_advertise_address_parses_as_ipv4_or_hostname_with_its_port() {
        assert_eq!(
            parse_advertise_addr("203.0.113.9:8300"),
            Some(AdvertiseAddr {
                host: "203.0.113.9".into(),
                port: 8300
            })
        );
        assert_eq!(
            parse_advertise_addr("home.example.com:9000"),
            Some(AdvertiseAddr {
                host: "home.example.com".into(),
                port: 9000
            })
        );
        // A paste arrives with padding around it.
        assert_eq!(
            parse_advertise_addr("  Home.Example.COM:9000 "),
            Some(AdvertiseAddr {
                host: "Home.Example.COM".into(),
                port: 9000
            })
        );
    }

    #[test]
    fn an_advertise_address_without_a_usable_port_is_refused_so_boot_can_halt_on_it() {
        for raw in [
            "",
            "example.com",
            "example.com:",
            "example.com:0",
            "example.com:65536",
            "example.com:not-a-port",
            ":8300",
        ] {
            assert_eq!(parse_advertise_addr(raw), None, "accepted {raw:?}");
        }
    }

    #[test]
    fn an_ipv6_advertise_address_is_refused_because_the_transport_binds_ipv4() {
        assert_eq!(parse_advertise_addr("[2001:db8::1]:8300"), None);
        assert_eq!(parse_advertise_addr("2001:db8::1:8300"), None);
    }

    #[test]
    fn an_advertise_host_is_a_hostname_not_arbitrary_text() {
        // A shell metacharacter must never reach a compose comment, a log line, or getaddrinfo.
        for raw in ["$(rm -rf /):8300", "a b:8300", "host;ls:8300"] {
            assert_eq!(parse_advertise_addr(raw), None, "accepted {raw:?}");
        }
    }
}

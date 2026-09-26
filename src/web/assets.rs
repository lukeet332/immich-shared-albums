/** web/assets.rs — serves the committed dist/ artifacts and fills their %%TOKENS%%, escaped. See ARCHITECTURE.md. */
use crate::config::{cfg, ROUTE_PREFIX};

/// The committed build output, embedded at compile time so the shipped binary needs no asset
/// directory (a scratch image has none). `include_str!` registers each file as a build
/// dependency, so editing a page rebuilds the binary.
macro_rules! dist {
    ($($name:literal),* $(,)?) => {
        pub static DIST: &[(&str, &str)] = &[$(($name, include_str!(concat!("../../src/web/dist/", $name)))),*];
    };
}

dist!(
    "panel.js",
    "accept.js",
    "share.js",
    "me.js",
    "root.js",
    "panel.css",
    "accept.css",
    "share.css",
    "me.css",
    "root.css",
    "sign-in.css",
);

static PANEL_HTML: &str = include_str!("../../src/web/dist/panel.html");
static ACCEPT_HTML: &str = include_str!("../../src/web/dist/accept.html");
static SHARE_HTML: &str = include_str!("../../src/web/dist/share.html");
static ME_HTML: &str = include_str!("../../src/web/dist/me.html");
static ROOT_HTML: &str = include_str!("../../src/web/dist/root.html");
static SIGN_IN_HTML: &str = include_str!("../../src/web/dist/sign-in.html");

pub fn dist_asset(name: &str) -> Option<&'static str> {
    DIST.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

/// Escape for interpolation into HTML text or an attribute. Every token below goes through this —
/// a household name is operator-supplied and a display name is attacker-supplied.
pub fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&#38;"),
            '<' => out.push_str("&#60;"),
            '>' => out.push_str("&#62;"),
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// The route prefix is FIXED (see ROUTE_PREFIX: a member's share page probes the origin's prefix,
/// so it could never vary per install) — dist hardcodes it and is served verbatim.
pub fn panel_page() -> String {
    PANEL_HTML.replace("%%HOUSEHOLD%%", &escape_html(&cfg().name))
}

pub fn accept_page() -> String {
    ACCEPT_HTML.replace("%%HOUSEHOLD%%", &escape_html(&cfg().name))
}

pub fn me_page() -> String {
    ME_HTML.replace("%%HOUSEHOLD%%", &escape_html(&cfg().name))
}

pub fn root_page() -> String {
    ROOT_HTML.replace("%%HOUSEHOLD%%", &escape_html(&cfg().name))
}

pub fn sign_in_page(what: &str) -> String {
    SIGN_IN_HTML
        .replace("%%HOUSEHOLD%%", &escape_html(&cfg().name))
        .replace("%%WHAT%%", &escape_html(what))
}

pub fn share_page(endpoint_token: &str, album_name: Option<&str>, cover: Option<&str>) -> String {
    SHARE_HTML
        .replace("%%ENDPOINT%%", &escape_html(endpoint_token))
        .replace(
            "%%ALBUM%%",
            &escape_html(album_name.unwrap_or("Shared album")),
        )
        .replace("%%COVER%%", &escape_html(cover.unwrap_or("")))
}

/// The asset URL for a dist file, as the prerendered HTML expects it.
pub fn asset_path(name: &str) -> String {
    format!("{ROUTE_PREFIX}/assets/{name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_html_covers_every_dangerous_character() {
        assert_eq!(escape_html("<script>"), "&#60;script&#62;");
        assert_eq!(escape_html("a & b"), "a &#38; b");
        assert_eq!(escape_html("\"x\" 'y'"), "&#34;x&#34; &#39;y&#39;");
        assert_eq!(escape_html("plain"), "plain");
    }

    #[test]
    fn every_dist_entry_is_non_empty() {
        // A missing dist file would include_str! an empty file silently if the path were wrong.
        for (name, content) in DIST {
            assert!(!content.is_empty(), "{name} is empty");
        }
    }

    #[test]
    fn dist_lookup_finds_js_and_css_and_rejects_unknown() {
        assert!(dist_asset("panel.js").is_some());
        assert!(dist_asset("sign-in.css").is_some());
        assert!(dist_asset("nope.js").is_none());
    }

    #[test]
    fn tokens_are_replaced_by_escaped_values() {
        install_test_config();
        let page = sign_in_page("<b>");
        assert!(!page.contains("%%WHAT%%"));
        assert!(page.contains("&#60;b&#62;"));
    }

    fn install_test_config() {
        crate::config::install_test_config();
    }
}

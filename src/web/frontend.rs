/** web/frontend.rs — every human-facing surface this addon serves, in one table. See ARCHITECTURE.md. */
use crate::web::assets;

/// Who may see a surface. `Admin` is the panel, because it is the only surface that acts on the
/// server rather than describing it; the rest are public on purpose — the accept page has to be
/// reachable by someone who has not signed in yet, and the two scripts are code, not data.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    Public,
    SignedIn,
    Admin,
}

/// What a surface returns. Pages are rendered per request, so CFG and state changes are picked up
/// without a restart; a committed asset is served verbatim.
pub enum Body {
    Page(fn() -> String),
    Asset(&'static str),
}

pub struct Surface {
    pub content_type: &'static str,
    pub body: Body,
    pub access: Access,
    /// What the sign-in page should say the caller was trying to do.
    pub action: &'static str,
}

const HTML: &str = "text/html";
const JS: &str = "application/javascript";
const CSS: &str = "text/css";

/// The route prefix this build serves, written out so it can be matched as a literal. It MUST stay
/// equal to `ROUTE_PREFIX` — `every_surface_path_is_under_the_route_prefix` is what makes that
/// enforceable rather than remembered.
pub const ROOT: &str = "/immich-shared-albums";
pub const ROOT_SLASH: &str = "/immich-shared-albums/";
pub const ADMIN: &str = "/immich-shared-albums/admin";
pub const ME: &str = "/immich-shared-albums/me";
pub const ME_SLASH: &str = "/immich-shared-albums/me/";
pub const ACCEPT: &str = "/immich-shared-albums/accept";
pub const ASSET_PREFIX: &str = "/immich-shared-albums/assets/";

/// Every path this table routes. The enforcement test below walks this list.
pub const SURFACE_PATHS: [&str; 7] = [ROOT, ROOT_SLASH, ADMIN, ME, ME_SLASH, ACCEPT, ASSET_PREFIX];

/// Exact-path lookup, no pattern matching. Anything needing patterns, streaming or bodies stays in
/// server.rs, which is also where the ordering rules that cannot move are documented.
pub fn surface_for(path: &str) -> Option<Surface> {
    let page = |body: fn() -> String, content_type: &'static str, access, action| {
        Some(Surface {
            content_type,
            body: Body::Page(body),
            access,
            action,
        })
    };

    match path {
        // The root is the one URL to remember, so it cannot be gated on admin: an ordinary user
        // typing it would meet a sign-in page. It asks who is calling and either offers the two
        // panels (admin) or opens the personal one directly.
        ROOT | ROOT_SLASH => page(
            assets::root_page,
            HTML,
            Access::SignedIn,
            "open your shared albums",
        ),
        // The admin panel keeps its own path now that the root is the chooser.
        ADMIN => page(
            assets::panel_page,
            HTML,
            Access::Admin,
            "manage shared albums",
        ),
        ME | ME_SLASH => page(
            assets::me_page,
            HTML,
            Access::SignedIn,
            "see your shared albums",
        ),
        ACCEPT => page(assets::accept_page, HTML, Access::Public, ""),
        _ => asset_surface(path),
    }
}

fn asset_surface(path: &str) -> Option<Surface> {
    let name = path.strip_prefix(ASSET_PREFIX)?;
    // Look the asset up by NAME against the embedded table, so a traversal can never name a file.
    let content = assets::dist_asset(name)?;
    let content_type = if name.ends_with(".js") { JS } else { CSS };
    Some(Surface {
        content_type,
        body: Body::Asset(content),
        access: Access::Public,
        action: "",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ROUTE_PREFIX;

    #[test]
    fn every_surface_path_is_under_the_route_prefix() {
        // The single-source-of-truth check: ROUTE_PREFIX is fixed (a member's share page probes the
        // ORIGIN's prefix), so a literal here that drifts from it would serve nothing.
        for path in SURFACE_PATHS {
            assert!(
                path.starts_with(ROUTE_PREFIX),
                "{path} is not under {ROUTE_PREFIX}"
            );
        }
    }

    #[test]
    fn asset_prefix_ends_with_a_separator_so_strip_prefix_cannot_over_match() {
        assert!(ASSET_PREFIX.ends_with('/'));
    }

    #[test]
    fn root_is_signed_in_and_panel_is_admin() {
        assert_eq!(surface_for(ROOT).unwrap().access, Access::SignedIn);
        assert_eq!(surface_for(ROOT_SLASH).unwrap().access, Access::SignedIn);
        assert_eq!(surface_for(ADMIN).unwrap().access, Access::Admin);
        assert_eq!(surface_for(ME).unwrap().access, Access::SignedIn);
        assert_eq!(surface_for(ME_SLASH).unwrap().access, Access::SignedIn);
    }

    #[test]
    fn accept_is_public_because_that_is_its_job() {
        assert_eq!(surface_for(ACCEPT).unwrap().access, Access::Public);
    }

    #[test]
    fn assets_are_public_and_typed_by_extension() {
        let js = surface_for("/immich-shared-albums/assets/panel.js").unwrap();
        assert_eq!(js.content_type, "application/javascript");
        let css = surface_for("/immich-shared-albums/assets/panel.css").unwrap();
        assert_eq!(css.content_type, "text/css");
    }

    #[test]
    fn an_unknown_asset_is_not_found_rather_than_read_from_disk() {
        assert!(surface_for("/immich-shared-albums/assets/../../../etc/passwd").is_none());
        assert!(surface_for("/immich-shared-albums/assets/nope.js").is_none());
        assert!(surface_for("/nope").is_none());
    }
}

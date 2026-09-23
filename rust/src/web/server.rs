/** web/server.rs — the router: a thin dispatch table mapping each path to a handler. See PORT.md. */
use crate::config::{cfg, ROUTE_PREFIX};
use crate::p2p::pair::{pending_pairings, revoke_pairing};
use crate::p2p::transport::transport;
use crate::p2p::unlink::{linked_peers, local_household, shared_albums};
use crate::settings::{Settings, TTL_MAX_MINUTES, TTL_MINUTES_MIN};
use crate::state::state;
use crate::web::auth::{caller_identity, sign_in_required};
use crate::web::frontend::{surface_for, Access, Body};
use crate::web::{assets, frontend, interceptor, passthrough, query};
use axum::body::Body as HttpBody;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use futures_lite::StreamExt;
use serde_json::{json, Value};

/// The whole HTTP surface. ORDER IS LOAD-BEARING and is documented in PORT.md; each step's
/// position is justified there. Steps that are not ported yet are marked and fail closed.
pub async fn serve(req: Request) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let headers = req.headers().clone();

    // 0. A protocol upgrade is not a request/response exchange at all: it has to be piped at the
    //    socket level, before anything here tries to read or answer it. Immich's live web updates are
    //    a websocket, so without this the web app silently loses them.
    if crate::web::upgrade::is_upgrade(&headers) {
        return crate::web::upgrade::proxy_upgrade(req).await;
    }

    // 1. Human-facing surfaces — pages and scripts — come from ONE table, so "what exists and who
    //    may see it" is answerable by reading web/frontend.rs rather than tracing this file.
    //    Served before the body cap because none of them has a body to read.
    if let Some(surface) = surface_for(&path) {
        // Fail closed. The caller's OWN Immich credential decides, never a header we trust.
        let caller = match surface.access {
            Access::Public => None,
            _ => caller_identity(&headers).await,
        };
        match surface.access {
            Access::Admin if caller.as_ref().map(|c| c.is_admin) != Some(true) => {
                let status = if caller.is_some() {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::UNAUTHORIZED
                };
                return html(
                    status,
                    assets::sign_in_page(action_or_default(surface.action)),
                );
            }
            Access::SignedIn if caller.is_none() => {
                return html(
                    StatusCode::UNAUTHORIZED,
                    assets::sign_in_page(action_or_default(surface.action)),
                );
            }
            _ => {}
        }
        let body = match surface.body {
            Body::Page(render) => render(),
            Body::Asset(content) => content.to_string(),
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, surface.content_type)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(HttpBody::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    // 2. The share shell: the native share page framed under the join card. `?native=1` is the
    //    passthrough escape hatch — what the iframe loads, and where dismissing the card navigates.
    if let Some(key) = share_key_from_path(&path) {
        if method == Method::GET {
            let native = query_has(&uri, "native");
            if native {
                // Hand Immich the BARE path. Its share route matches the exact path, so ANY query
                // string answers 404 with the bare app shell: the album still boots client-side,
                // which is why it hides, but the server-rendered metadata (og:title, the photo
                // count) is gone and the address the dismiss link leaves behind is a 404 — so the
                // link a recipient then copies previews as nothing. Only OUR marker is removed;
                // any other parameter is not ours to drop.
                let rest = stripped_query(&uri, "native");
                let target = if rest.is_empty() {
                    path.clone()
                } else {
                    format!("{path}?{rest}")
                };
                if let Ok(parsed) = target.parse::<Uri>() {
                    return passthrough::proxy_to_immich(
                        method,
                        &parsed,
                        &headers,
                        req.into_body(),
                    )
                    .await;
                }
            } else if Settings::read(&state().store).share_link_join {
                return share_document(&key).await;
            }
        }
    }

    // 3. The app's OWN asset URLs (/api/assets/:id/{thumbnail,original,video/playback}) for a
    //    PROXY asset: the local row is only a stub, so the true pixels are streamed live from the
    //    owner. Served before the passthrough so a shared tile shows the real photo.
    //    Declining (`None`) is the fail-open direction and covers more than failure: no ledger row,
    //    a stored-FULL copy that holds its own bytes, an owner that cannot be reached. Immich then
    //    answers with the stub, which is what a page needs to survive a peer being down.
    if method == Method::GET {
        let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
        if let Some(response) = interceptor::serve(
            state(),
            crate::immich::client::shared(),
            &path,
            uri.query(),
            &headers,
            range,
        )
        .await
        {
            return response;
        }
    }

    // 4. Everything that is not a sidecar route -> transparent proxy to Immich. Streams both
    //    ways: a photo upload must never be buffered here. This comes BEFORE the body cap, because
    //    passthrough traffic is not ours to size.
    if !path.starts_with(ROUTE_PREFIX) {
        let response =
            passthrough::proxy_to_immich(method.clone(), &uri, &headers, req.into_body()).await;
        // AFTER the response, not before: an album mutation is only a change once Immich has made
        // it, and reading on the way in races the very write that prompted the read. Fire-and-forget
        // and fail-open — nothing about a proxied request may depend on this.
        note_traffic(&path, &method, &headers);
        return response;
    }

    // 5. The sidecar's own routes cap the body before reading it — BEFORE authorising, which is
    //    the whole reason this is here rather than in each handler. A handler that checks a session
    //    first answers 401 to an oversized request and the 413 never happens; the TypeScript caps
    //    centrally for exactly that reason. The cap is also the router's job because it is a
    //    property of the SIDECAR's routes, not of any one of them.
    //
    //    `content-length` is the fast path: refuse without reading a byte more. Everything else is
    //    caught mid-stream by the handler that reads it (`read_json_body`).
    if let Some(declared) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
    {
        let limit = (cfg().max_body_kb * 1024) as usize;
        if declared > limit {
            // DRAINED, not dropped. Destroying the request resets the connection and the caller
            // sees a network error instead of the 413 this is here to deliver. Discarding the
            // chunks keeps memory O(1), which is the entire point of refusing early. Cutting the
            // upload off at the wire is the reverse proxy's job — see deploy/Caddyfile.snippet.
            let body = req.into_body();
            tokio::spawn(async move {
                let mut stream = body.into_data_stream();
                while let Some(Ok(_)) = stream.next().await {}
            });
            return json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": format!("request body exceeds {}KB", cfg().max_body_kb) }),
            );
        }
    }

    // 6. The sidecar's own JSON routes. Route before reading a body, then authorise.
    match (method.clone(), path.as_str()) {
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/peers") => return peers(&headers).await,
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/settings") => {
            return settings_get(&headers).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/settings") => {
            return settings_post(&headers, req).await
        }
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/pairings") => {
            return pairings_list(&headers).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/pairings") => {
            return pairing_mint(&headers).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/pairings/revoke") => {
            return pairing_revoke(&headers, req).await
        }
        // A joined album is removed by the ONLY credential that acts on the server as a whole: an
        // admin's. A member's mirror is not theirs to delete, and the purge below deletes accounts'
        // assets, so this is an admin route rather than one scoped to the caller.
        // Does joining this link leave the caller with a SECOND album of a name they already own?
        // Asked BEFORE joining, because a plain join would create the duplicate this feature exists
        // to remove, and the person would have to reunite the two afterwards.
        //
        // It deliberately does NOT redeem the link to find out: redeeming pins the caller as a peer
        // on the ORIGIN and writes an owner mapping there, so a preview that redeemed would enrol a
        // household on someone else's server merely because a page opened. The album's NAME is all
        // this needs, and it arrives from the share page the person just came from.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/join/preview") => {
            return join_preview(&headers, req).await
        }
        // Joining is for the SIGNED-IN person: the invite is redeemed by someone, and the album
        // lands in their library. A body may name another user only for an admin acting for them.
        // The caller's OWN albums, read as THEM: Immich answers what they may see, so a mapping
        // whose album is missing from that list is never leaked.
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/me/albums") => {
            return my_albums(&headers).await
        }
        // Offer the caller's own albums to one linked peer, so that peer can look for the other half
        // of a split album. Only the CALLER can be recorded as owner.
        // Possible reunions: albums on a linked server that look like the other half of one of
        // the caller's own. Read as THEM, so the server that owns the albums answers what they own.
        // Severing a link is admin-owned, like the link itself: it is not something expressed by
        // removing a bot from an album.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/unlink") => {
            return unlink(&headers, req).await
        }
        // The panel's Invite: one membership, for one account, on the caller's OWN album and their
        // own credential — the one sharing action AGENTS.md allows outside Immich's UI, because the
        // reunion cannot start without it and the panel is where the pair is shown.
        // Un-reunify: undo the ADOPTION, not the share. The album and its own photos stay and the
        // share returns to an ordinary mirror, so the origin is NOT told to stop and keeps offering
        // the invitation, which the member's own invite poll turns back into a mirror.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/me/unreunite") => {
            return unreunite(&headers, req).await
        }
        // Reunite: move a share onto an album the caller already owns, instead of keeping two.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/me/reunite") => {
            return reunite(&headers, req).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/me/invite") => {
            return invite_to_reunite(&headers, req).await
        }
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/me/matches") => {
            return my_matches(&headers).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/me/albums/publish") => {
            return publish_my_albums(&headers, req).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/join") => {
            return join(&headers, req).await
        }
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/leave") => {
            return leave(&headers, req).await
        }
        // Rig-only progress read, so a test can wait for convergence without speaking the peer
        // protocol. Gated the way every hook must be: absent unless ISA_TEST_HOOKS is set, and
        // admin-only even then.
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/sync/status") => {
            return sync_status_route(&headers, &uri).await
        }
        // Rig-only: pretend Immich has not measured a photo yet, which is the window between an
        // upload and its metadata job. Gated like every hook: absent unless ISA_TEST_HOOKS is set.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/test/hide-dimensions") => {
            return hide_dimensions(&headers, req).await
        }
        // Rig-only: emit a panel hint on demand, so a browser test can prove an open page reacts to
        // one without a reload. It answers how many panels are listening, which is also how a
        // subscription torn down early reads as 0 rather than as a page that quietly stops updating.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/test/emit") => {
            return test_emit(&headers, req).await
        }
        // Rig-only: hold every background sweep, so a lane can prove a change arrived by push rather
        // than by the next tick. Gated like every hook: absent unless ISA_TEST_HOOKS is set.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/test/pause-sweeps") => {
            return pause_sweeps(&headers, req).await
        }
        // Rig-only: forget every session, so the next request looks like the first one. The quiet
        // period that opens a session is fifteen minutes, which no test can wait out.
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/test/new-session") => {
            return new_session(&headers).await
        }
        // The panels' live channel: one open response per open panel, carrying hints only. Signed in,
        // like every panel route — the caller's own data is what they will re-read.
        (Method::GET, p) if p == format!("{ROUTE_PREFIX}/events") => return events(&headers).await,
        (Method::POST, p) if p == format!("{ROUTE_PREFIX}/pair") => {
            return pairing_redeem(&headers, req).await
        }
        _ => {}
    }

    // 8. The health probe names the protocol, so a join card can diagnose version skew.
    if path == format!("{ROUTE_PREFIX}/health") {
        return json_response(
            StatusCode::OK,
            json!({ "ok": true, "protocol": crate::protocol::PROTOCOL_VERSION }),
        )
        .with_header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    }

    // 9.
    json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }))
}

/// One row per linked server, with what the link is currently carrying. Admin-only: server links
/// are admin-owned objects, not something a per-user surface scopes to the caller.
async fn peers(headers: &HeaderMap) -> Response {
    let Some(caller) = caller_identity(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("see connected servers"),
        );
    };
    if !caller.is_admin {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "only an admin can see connected servers" }),
        );
    }
    let state = state();
    json_response(
        StatusCode::OK,
        json!({
            "household": local_household(),
            "peers": linked_peers(state),
            "albums": shared_albums(state),
        }),
    )
}

async fn settings_get(headers: &HeaderMap) -> Response {
    let Some(caller) = caller_identity(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("change settings"),
        );
    };
    if !caller.is_admin {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "only an admin can change settings" }),
        );
    }
    json_response(StatusCode::OK, settings_json())
}

async fn settings_post(headers: &HeaderMap, req: Request) -> Response {
    let Some(caller) = caller_identity(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("change settings"),
        );
    };
    if !caller.is_admin {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "only an admin can change settings" }),
        );
    }
    let limit = (cfg().max_body_kb * 1024) as usize;
    let body = match axum::body::to_bytes(req.into_body(), limit).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": format!("request body exceeds {}KB", cfg().max_body_kb) }),
            )
        }
    };
    let asked: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(e) => return json_response(StatusCode::BAD_REQUEST, json!({ "error": e.to_string() })),
    };

    let current = Settings::read(&state().store);
    let ttl = asked
        .get("pairingTtlMinutes")
        .and_then(|v| v.as_i64())
        .unwrap_or(current.pairing_ttl_minutes);
    if !Settings::ttl_is_valid(ttl) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "error": format!(
                    "pairing links must be valid for {} minutes to {} hours",
                    TTL_MINUTES_MIN,
                    TTL_MAX_MINUTES / 60
                )
            }),
        );
    }
    let wanted = Settings {
        // `!== false`: an absent field means ON, not off.
        share_link_join: asked
            .get("shareLinkJoin")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        pairing_ttl_minutes: ttl,
        store_shared_assets_locally: asked
            .get("storeSharedAssetsLocally")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    };
    if let Err(e) = wanted.write(&state().store) {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": e.to_string() }),
        );
    }
    json_response(StatusCode::OK, settings_json())
}

/// Read a JSON body under `ISA_MAX_BODY_KB`, answering the same 413 the TypeScript does.
async fn read_json_body(req: Request) -> Result<Value, Response> {
    let limit = (cfg().max_body_kb * 1024) as usize;
    let bytes = axum::body::to_bytes(req.into_body(), limit)
        .await
        .map_err(|_| {
            json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": format!("request body exceeds {}KB", cfg().max_body_kb) }),
            )
        })?;
    serde_json::from_slice(&bytes)
        .map_err(|e| json_response(StatusCode::BAD_REQUEST, json!({ "error": e.to_string() })))
}

/// The settings row as the panel reads it. ONE shape, used by both the GET and the POST's reply, so
/// a write can never answer with a different body than the read that follows it.
fn settings_json() -> Value {
    let current = Settings::read(&state().store);
    json!({
        "shareLinkJoin": current.share_link_join,
        "pairingTtlMinutes": current.pairing_ttl_minutes,
        "storeSharedAssetsLocally": current.store_shared_assets_locally,
    })
}

/// `GET /pairings` — pending codes, METADATA ONLY. The ticket itself is shown once, at mint time:
/// a list that could re-show it would make an already-shown code re-usable by anyone who can read
/// the admin panel.
async fn pairings_list(headers: &HeaderMap) -> Response {
    if let Some(response) = require_admin(headers, "manage server links").await {
        return response;
    }
    json_response(
        StatusCode::OK,
        json!({ "pairings": pending_pairings(&state().store) }),
    )
}

/// `POST /pairings` — mint a one-use link. It carries this server's endpoint, so it can only be
/// made while the transport is up: a link that cannot be dialled is a link that lies.
async fn pairing_mint(headers: &HeaderMap) -> Response {
    if let Some(response) = require_admin(headers, "manage server links").await {
        return response;
    }
    let Some(transport) = transport() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "the peer transport is not running" }),
        );
    };
    match crate::p2p::pair::mint_pairing(transport, &state().store) {
        Ok((link, expires_at)) => json_response(
            StatusCode::OK,
            json!({ "link": link, "expiresAt": expires_at }),
        ),
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// `POST /pairings/revoke` — withdraw a code that has not been used. Revoking one that is already
/// gone is a success, not an error: the caller wanted it unusable and it is.
async fn pairing_revoke(headers: &HeaderMap, req: Request) -> Response {
    if let Some(response) = require_admin(headers, "manage server links").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let id = body
        .get("id")
        .or_else(|| body.get("code"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "id is required" }),
        );
    }
    revoke_pairing(&state().store, id);
    json_response(StatusCode::OK, json!({ "ok": true }))
}

/// `POST /pair` — paste a link another server gave us. The standalone way to link two servers: no
/// album is involved, and pairing conveys no access to any photo.
async fn pairing_redeem(headers: &HeaderMap, req: Request) -> Response {
    if let Some(response) = require_admin(headers, "link a server").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let link = body
        .get("link")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if link.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "link is required" }),
        );
    }
    let Some(transport) = transport() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "the peer transport is not running" }),
        );
    };
    match crate::p2p::pair::redeem_pairing(transport.clone(), link).await {
        Ok(value) => {
            // A link whose albums are not offered yet is a link nothing can be matched against, so
            // every panel that is open is told the set of shares just moved.
            crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Shares);
            // The person who just linked is the only person whose credential is in hand at this
            // moment. Read the ADMIN account's own albums — it IS a person here — and tell the new
            // peer to look, so a fresh link has something to match against before anyone opens a
            // panel. Deliberately unawaited: linking must not wait on an album read.
            let owned_state = state().clone();
            tokio::spawn(async move {
                crate::sync::index_freshness::offer_admin_albums(&owned_state).await;
            });
            json_response(StatusCode::OK, value)
        }
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// `POST /leave` — give up a joined album: purge the stubs it created, then take the mirror with it.
async fn leave(headers: &HeaderMap, req: Request) -> Response {
    if let Some(response) = require_admin(headers, "leave a shared album").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mapping_id = body
        .get("mappingId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if mapping_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "mappingId is required" }),
        );
    }
    // `notify_origin: true` — this is a person LEAVING, so the origin retires its owner mapping and
    // stops offering. Un-reunifying is the case that passes false, and it is not this route.
    match crate::sync::leave::leave_album(
        state(),
        crate::immich::client::shared(),
        mapping_id,
        true,
    )
    .await
    {
        Ok(outcome) => json_response(
            StatusCode::OK,
            json!({
                "left": outcome.left,
                "purged": outcome.purged,
                "refused": outcome.refused,
                "failed": outcome.failed,
            }),
        ),
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// The gate every server-level route passes: signed in AND an admin. `None` means "carry on".
///
/// Admin, because these act on the server rather than on the caller's own photos — linking and
/// unlinking households, and deleting other accounts' assets. A signed-in non-admin gets 403 rather
/// than 401: they are not going to fix it by signing in again.
async fn require_admin(headers: &HeaderMap, what: &str) -> Option<Response> {
    let Some(caller) = caller_identity(headers).await else {
        return Some(json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required(what),
        ));
    };
    if !caller.is_admin {
        return Some(json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": format!("only an admin can {what}") }),
        ));
    }
    None
}

/// `GET /me/albums` — the caller's shared albums, as IMMICH says they may see them.
async fn my_albums(headers: &HeaderMap) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("see your albums"),
        );
    };
    let client = crate::immich::client::shared();
    let Some(visible) = crate::immich::access::visible_album_ids(client, &signed_in.creds).await
    else {
        // A REFUSED read is not an empty library, and saying "you own nothing" would be a lie the
        // panel has no way to correct.
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "could not read your albums" }),
        );
    };
    // ONE guard for both halves. `collections()` hands back a non-reentrant `std::sync::MutexGuard`,
    // so looking a peer up with a SECOND call while the first is alive deadlocks the thread against
    // its own lock — and the guard is held for the whole expression, so every other task that
    // touches state blocks behind it and the sidecar stops answering entirely. Both lookups want the
    // same snapshot anyway.
    let collections = state().collections();
    let albums: Vec<Value> = collections
        .mappings
        .iter()
        .filter(|m| !m.dead && visible.contains(&m.album_id))
        .map(|m| {
            let peer = collections
                .peers
                .iter()
                .find(|p| p.pub_key == m.peer)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "a linked server".to_string());
            let mut entry = json!({
                "name": m.album_name,
                "role": if m.role == crate::store::Role::Owner { "owner" } else { "member" },
                "via": m.via,
                "peer": peer,
                "mappingId": m.id,
            });
            if m.reunified == Some(true) {
                entry["reunified"] = json!(true);
                // WHO did the adopting. The Un-reunite route undoes an ADOPTION, so a share the
                // PEER reunited (this household only invited) must not offer the button: it would
                // answer 404 on a click, and the undo for an invitation is Immich's own
                // album-sharing settings, not this route.
                entry["adoptedByUs"] = json!(m.adopted == Some(true));
            }
            entry
        })
        .collect();
    json_response(
        StatusCode::OK,
        json!({
            "albums": albums,
            "household": crate::p2p::unlink::local_household().get("name").cloned().unwrap_or(Value::Null),
            "isAdmin": signed_in.caller.is_admin,
        }),
    )
}

/// `POST /unlink` — sever a link and everything it brought with it.
async fn unlink(headers: &HeaderMap, req: Request) -> Response {
    if let Some(response) = require_admin(headers, "unlink a server").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let pub_key = body.get("pub").and_then(|v| v.as_str()).unwrap_or_default();
    if pub_key.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the server to unlink" }),
        );
    }
    match crate::p2p::unlink::unlink_peer(state(), crate::immich::client::shared(), pub_key).await {
        Ok(outcome) => json_response(
            StatusCode::OK,
            json!({
                "household": outcome.household,
                "mirrorsRemoved": outcome.mirrors_removed,
                "sharesRevoked": outcome.shares_revoked,
                "markersRemoved": outcome.markers_removed,
            }),
        ),
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// `POST /me/unreunite` — undo the adoption, not the share.
///
/// The album and its own photos stay; the peer's stubs go; the share returns to an ordinary mirror.
/// The origin is deliberately NOT told to stop, so it keeps offering the invitation and the member's
/// own invite poll turns it back into a mirror.
async fn unreunite(headers: &HeaderMap, req: Request) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("un-reunite an album"),
        );
    };
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(mapping_id) = body.get("mappingId").and_then(|v| v.as_str()) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the share to un-reunite" }),
        );
    };
    // ONLY AN ADOPTION, and only its album's owner. Membership is not authority here: on a mapping
    // that is not an adoption `leave_album` DELETES the album, so an un-reunify that accepted one
    // would be a leave button wearing the wrong label.
    let mapping = state()
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == mapping_id && !m.dead && m.adopted == Some(true))
        .cloned();
    let Some(mapping) = mapping else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "no such reunified share", "code": "unknown_mapping" }),
        );
    };
    let client = crate::immich::client::shared();
    let Some(visible) = crate::immich::access::visible_album_ids(client, &signed_in.creds).await
    else {
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "could not read your albums" }),
        );
    };
    if !visible.contains(&mapping.album_id) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "that share is not yours" }),
        );
    }
    // Ownership is the fact that matters, and it comes from Immich rather than from a claim.
    let caller_owns_it = client
        .get_album(
            &mapping.album_id,
            &crate::immich::client::Auth::Creds(&signed_in.creds),
        )
        .await
        .ok()
        .flatten()
        .and_then(|album| {
            album
                .get("albumUsers")
                .and_then(|v| v.as_array())
                .map(|users| {
                    users.iter().any(|au| {
                        au.pointer("/user/id").and_then(|v| v.as_str())
                            == Some(signed_in.caller.id.as_str())
                            && au.get("role").and_then(|v| v.as_str()) == Some("owner")
                    })
                })
        })
        .unwrap_or(false);
    if !caller_owns_it {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "only the album's owner can un-reunite it" }),
        );
    }

    let album_id = mapping.album_id.clone();
    let album_name = mapping.album_name.clone();
    // Purge the peer's stubs FIRST, while our accounts still hold the memberships they were granted,
    // then take those accounts off — only the owner can, and the caller IS the owner here.
    let outcome = match crate::sync::leave::leave_album(state(), client, mapping_id, false).await {
        Ok(outcome) => outcome,
        Err(e) => return json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    };
    // The trail's withdrawal line, written HERE: `leave_album` has already purged the peer's stubs, so
    // the line describes the finished state, and `strip_album_bots` is about to take our accounts off
    // the album — after which the bot could not comment on it at all.
    let peer_name = state()
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == mapping.peer)
        .map(|p| p.name.clone());
    crate::sync::audit::audit_line(
        state(),
        client,
        mapping_id,
        &album_id,
        "unreunited",
        &format!(
            "Un-reunited with \"{}\" — their photos are out of this album. It is still shared: reunite the two again any time from your shared-albums page.",
            peer_name.as_deref().unwrap_or("a linked server")
        ),
    )
    .await;
    // Reported, never swallowed: the owner's credential is gone the moment this request ends, so an
    // account we failed to remove keeps reading a private album and NOTHING can retry it.
    crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Shares);
    let (stripped, strip_failed) =
        crate::sync::album_grant::strip_album_bots(state(), client, &album_id, &signed_in.creds)
            .await;
    if !strip_failed.is_empty() {
        crate::log!(
            "un-reunify left {} of our account(s) on \"{album_name}\" — they still read it; remove them in Immich",
            strip_failed.len()
        );
    }
    let mut response = json!({
        "left": outcome.left,
        "purged": outcome.purged,
        "refused": outcome.refused,
        "failed": outcome.failed,
        "stripped": stripped,
    });
    if !strip_failed.is_empty() {
        response["stripFailed"] = json!(strip_failed);
    }
    json_response(StatusCode::OK, response)
}

/// `POST /me/reunite` — put the caller's own album in place of a share's mirror.
async fn reunite(headers: &HeaderMap, req: Request) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("reunite an album"),
        );
    };
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let (Some(mapping_id), Some(album_name)) = (
        body.get("mappingId").and_then(|v| v.as_str()),
        body.get("albumName").and_then(|v| v.as_str()),
    ) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the share and the album to reunite it with" }),
        );
    };
    let mapping = state()
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == mapping_id && !m.dead)
        .cloned();
    let Some(mapping) = mapping else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "no such share", "code": "unknown_mapping" }),
        );
    };
    // Only shares this caller is IN: the mapping is looked up, then the album it points at is read
    // as the caller, so a mapping they cannot see is one they cannot name.
    let Some(visible) =
        crate::immich::access::visible_album_ids(crate::immich::client::shared(), &signed_in.creds)
            .await
    else {
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "could not read your albums" }),
        );
    };
    if !visible.contains(&mapping.album_id) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "that share is not yours" }),
        );
    }
    // The panel names the ALBUM by name; which local album that is gets resolved from the caller's
    // own list inside the operation, so no id crosses the wire or is taken on trust.
    match crate::sync::mirror::unify_own_album(
        state(),
        crate::immich::client::shared(),
        &mapping,
        album_name,
        &signed_in.creds,
        &signed_in.caller.id,
    )
    .await
    {
        Ok((album, seeded)) => {
            json_response(StatusCode::OK, json!({ "album": album, "seeded": seeded }))
        }
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// `POST /me/invite` — share the caller's album with the person who owns the other half.
async fn invite_to_reunite(headers: &HeaderMap, req: Request) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("invite someone to reunite an album"),
        );
    };
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let (Some(peer_pub), Some(album_name), Some(owner_user_id)) = (
        body.get("peer").and_then(|v| v.as_str()),
        body.get("albumName").and_then(|v| v.as_str()),
        body.get("ownerUserId").and_then(|v| v.as_str()),
    ) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the linked server, the album, and whose half it is" }),
        );
    };
    let Some(peer) = state()
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == peer_pub)
        .cloned()
    else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "no such linked server", "code": "unknown_peer" }),
        );
    };
    // Both the album and the person are RE-DERIVED inside: the album from the caller's own Immich
    // list, the person from the index the peer itself published. The body names them; it does not
    // establish either.
    match crate::sync::album_index::invite_peer_to_reunite(
        state(),
        crate::immich::client::shared(),
        &signed_in.creds,
        &signed_in.caller.id,
        &peer,
        album_name,
        owner_user_id,
    )
    .await
    {
        Ok((album, invited)) => {
            crate::log!(
                "{} invited \"{invited}\" to reunite \"{album}\"",
                signed_in.caller.name
            );
            json_response(
                StatusCode::OK,
                json!({ "album": album, "invited": invited }),
            )
        }
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// `GET /me/matches` — the pairings this person could reunite.
async fn my_matches(headers: &HeaderMap) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("see possible reunions"),
        );
    };
    match crate::sync::album_index::my_matches(
        state(),
        crate::immich::client::shared(),
        &signed_in.creds,
        &signed_in.caller.id,
    )
    .await
    {
        Some(matches) => json_response(StatusCode::OK, json!({ "matches": matches })),
        // A refused read is not "no reunions": saying so would be a lie the panel cannot correct.
        None => json_response(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "could not read your albums" }),
        ),
    }
}

/// `POST /me/albums/publish` — offer the caller's own albums to one linked peer for matching.
async fn publish_my_albums(headers: &HeaderMap, req: Request) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("offer your albums for reunification"),
        );
    };
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let peer_pub = body
        .get("peer")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("peerPub").and_then(|v| v.as_str()))
        .unwrap_or_default();
    if peer_pub.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the linked server to offer albums to" }),
        );
    }
    let Some(peer) = state()
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == peer_pub)
        .map(|p| (p.pub_key.clone(), p.name.clone()))
    else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "no such linked server", "code": "unknown_peer" }),
        );
    };
    let Some(published) = crate::sync::album_index::publish_owned_albums(
        state(),
        crate::immich::client::shared(),
        &signed_in.creds,
        &signed_in.caller.id,
        &peer.0,
    )
    .await
    else {
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "could not read your albums" }),
        );
    };
    crate::log!(
        "{} offered {} owned album(s) to \"{}\" for matching",
        signed_in.caller.name,
        published.len(),
        peer.1
    );
    json_response(StatusCode::OK, json!({ "published": published.len() }))
}

/// `POST /join/preview` — would joining this link duplicate an album the caller already has?
async fn join_preview(headers: &HeaderMap, req: Request) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("check this album against your own"),
        );
    };
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(album_name) = body.get("albumName").and_then(|v| v.as_str()) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the album the link is for" }),
        );
    };
    // The SAME function the join itself re-derives with, so a preview can never offer a marriage the
    // adoption would refuse. The caller's own album list is read on THEIR credential, because only
    // Immich can say which albums are theirs.
    let Some(caller_albums) = crate::immich::access::read_caller_albums(
        crate::immich::client::shared(),
        &signed_in.creds,
    )
    .await
    else {
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "could not read your albums" }),
        );
    };
    let reunion = crate::sync::adoption::find_adoptable_album(
        album_name,
        &caller_albums,
        &signed_in.caller.id,
    );
    let mut answer = json!({ "albumName": album_name });
    if let Some(reunion) = reunion {
        answer["reunion"] = json!({ "albumId": reunion.album_id, "name": reunion.name });
    }
    json_response(StatusCode::OK, answer)
}

/// `POST /join` — redeem a share invite and mirror the album it names.
async fn join(headers: &HeaderMap, req: Request) -> Response {
    let Some(signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("join a shared album"),
        );
    };
    let caller = signed_in.caller;
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };

    // The account being joined is the signed-in one. Naming someone else is an admin acting on
    // their behalf, and is refused otherwise rather than silently ignored.
    let named = body
        .get("forUserId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let for_user_id = if named.is_empty() {
        caller.id.clone()
    } else {
        named.to_string()
    };
    if for_user_id != caller.id && !caller.is_admin {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "you can only join an album for your own account" }),
        );
    }

    let invite_json = body.get("invite").cloned().unwrap_or(Value::Null);
    let key = invite_json
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let token = invite_json
        .get("endpointToken")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let Some(endpoint) = decode_endpoint_token(token) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "that does not look like a share invite" }),
        );
    };
    let invite = crate::p2p::join::Invite {
        endpoint_pub: endpoint.0,
        endpoint_relay: endpoint.1,
        endpoint_addrs: endpoint.2,
        key: key.to_string(),
    };
    let password = body.get("password").and_then(|v| v.as_str());

    let redeemed = match crate::p2p::join::redeem_invite(state(), &invite, password).await {
        Ok(redeemed) => redeemed,
        Err(refused) => {
            // A password prompt is a 401 the panel turns into a FIELD; everything else is a 400
            // it turns into an error. Collapsing them would show a message where a field belongs.
            let status = if refused.password_required {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::BAD_REQUEST
            };
            let mut body = json!({ "error": refused.message });
            if refused.password_required {
                body["passwordRequired"] = json!(true);
            }
            return json_response(status, body);
        }
    };

    let Some(peer) = state()
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == redeemed.household_public_key)
        .cloned()
    else {
        // `redeem_invite` pins the peer before returning, so this is unreachable rather than a
        // runtime possibility — and saying so beats a silent None two calls later.
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "the link was recorded but the peer is missing — retry" }),
        );
    };

    let request = crate::sync::mirror::MirrorRequest {
        peer: &peer,
        album_id: &redeemed.album_id,
        album_name: &redeemed.album_name,
        permissions: &redeemed.permissions,
        album_owner_name: redeemed.owner_display_name.clone(),
        album_owner_id: redeemed.owner_user_id.clone(),
        remote_mapping_id: redeemed.remote_mapping_id.clone(),
        for_user_ids: Some(vec![for_user_id]),
        reunified: redeemed.reunified,
        via: "link",
    };
    match crate::sync::mirror::ensure_mirror(state(), crate::immich::client::shared(), &request)
        .await
    {
        Ok(mirrored) => {
            let photos = redeemed.manifest_len;
            if mirrored.created {
                crate::log!(
                    "joined \"{}\" from \"{}\" ({photos} photos)",
                    redeemed.album_name,
                    redeemed.household_name
                );
            } else {
                crate::log!(
                    "re-join: \"{}\" already mirrored from \"{}\"",
                    mirrored.mapping.album_name,
                    redeemed.household_name
                );
            }
            // Fill the mirror in the background, exactly as `fillMirrorInBackground` does: reconcile
            // THIS mapping, never `start_watch_loop`, which spawns an unconditional loop and would
            // add a new one per join.
            //
            // Not awaited: a large album or a video transcode must not hold the accept page. The
            // loops retry, so a failure here costs freshness, not correctness.
            if mirrored.created {
                let owned_state = state().clone();
                let mapping = mirrored.mapping.clone();
                let joined_peer = peer.clone();
                tokio::spawn(async move {
                    if let Err(e) = crate::sync::engine::reconcile_mapping(
                        &owned_state,
                        crate::immich::client::shared(),
                        &mapping,
                        &joined_peer,
                        false,
                    )
                    .await
                    {
                        crate::log!("post-join sync error: {e} — the loops will retry");
                    }
                });
            }
            json_response(
                StatusCode::OK,
                json!({
                    "album": mirrored.mapping.album_name,
                    "albumId": mirrored.mapping.album_id,
                    "photos": photos,
                    "from": redeemed.household_name,
                    "permissions": redeemed.permissions,
                    "mappingId": mirrored.mapping.id,
                    "created": mirrored.created,
                }),
            )
        }
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

/// `{pub, relay?, addrs?}` from the invite's base64url token. `None` when it is not one.
fn decode_endpoint_token(token: &str) -> Option<(String, Option<String>, Option<Vec<String>>)> {
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    let public_key = value
        .get("pub")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if public_key.is_empty() {
        return None;
    }
    Some((
        public_key.to_string(),
        value
            .get("relay")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        value.get("addrs").and_then(|v| v.as_array()).map(|addrs| {
            addrs
                .iter()
                .filter_map(|a| a.as_str().map(str::to_string))
                .collect()
        }),
    ))
}

/// `POST /test/hide-dimensions` — rig-only. Hide or reveal one photo's dimensions.
///
/// Exists because the interesting case is a RACE: a photo uploaded moments before a push cycle has
/// no dimensions yet, and mirroring it then produces a square stub at the peer that never corrects
/// itself. A rig cannot reliably win that race by timing, so it is reproduced deliberately.
async fn hide_dimensions(headers: &HeaderMap, req: Request) -> Response {
    if !cfg().test_hooks {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    if let Some(response) = require_admin(headers, "hide dimensions").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let (Some(asset_id), Some(hidden)) = (
        body.get("assetId").and_then(|v| v.as_str()),
        body.get("hidden").and_then(|v| v.as_bool()),
    ) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name the asset and whether to hide its dimensions" }),
        );
    };
    crate::immich::unmeasured::hide_as_unmeasured(asset_id, hidden);
    crate::log!(
        "rig: dimensions for {} {}",
        &asset_id[..asset_id.len().min(8)],
        if hidden { "hidden" } else { "visible again" }
    );
    json_response(
        StatusCode::OK,
        json!({ "assetId": asset_id, "hidden": hidden }),
    )
}

/// `GET /sync/status` — how far a mapping has got, plus the loop counters.
///
/// The `hints` field the TypeScript returns is deliberately ABSENT rather than zero: it counts
/// panel hints emitted by `/events`, which is not ported, and a hard-coded 0 would read as "no hints
/// were needed" instead of "nothing is counting them". The e2e suite does not read it.
async fn sync_status_route(headers: &HeaderMap, uri: &Uri) -> Response {
    if !cfg().test_hooks {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    let Some(caller) = caller_identity(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("read sync status"),
        );
    };
    if !caller.is_admin {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "only an admin can read sync status" }),
        );
    }
    // The names are the WIRE contract, not a description: the suite reads `ticks.watcher` to tell a
    // nudge from a sweep, and an invented key reads as `undefined` — which compares false and looks
    // exactly like the sidecar never having looked.
    let (watcher, invites, comments) = crate::sync::status::loop_ticks();
    let (album, index, invitations) = crate::sync::status::nudges_received();
    let counters = json!({
        "ticks": { "watcher": watcher, "invites": invites, "comments": comments },
        "nudges": { "album": album, "index": index, "invitations": invitations },
        "hints": crate::web::panel_events::hints_emitted(),
    });
    let album_id = query::param(uri.query(), "albumId");
    let Some(album_id) = album_id else {
        // No album asked for: the counters alone, which is what a test needs to tell a nudge from a
        // sweep before any mapping exists.
        return json_response(StatusCode::OK, counters);
    };
    let mapping = state()
        .collections()
        .mappings
        .iter()
        .find(|m| m.album_id == album_id)
        .cloned();
    let Some(mapping) = mapping else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "no mapping for that album" }),
        );
    };
    let cycles = crate::sync::status::watcher_cycles(&mapping.id);
    // No album argument, exactly as the TypeScript route calls it: without `updatedAt` the settled
    // test falls back to "a version was recorded at all".
    let status = crate::sync::status::sync_status(&mapping, None, cycles);
    let mut merged = serde_json::to_value(&status).unwrap_or_else(|_| json!({}));
    if let (Some(object), Some(extra)) = (merged.as_object_mut(), counters.as_object()) {
        for (key, value) in extra {
            object.insert(key.clone(), value.clone());
        }
    }
    json_response(StatusCode::OK, merged)
}

/// `POST /test/new-session` — rig-only: forget every session seen, so the next request is a first one.
async fn new_session(headers: &HeaderMap) -> Response {
    if !cfg().test_hooks {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    if let Some(response) = require_admin(headers, "forget sessions").await {
        return response;
    }
    crate::sync::index_freshness::forget_visits();
    json_response(StatusCode::OK, json!({ "ok": true }))
}

/// `GET /events` — the panels' live channel: one open response per open panel, carrying hints only.
///
/// The panels fetch once when they mount, so a row whose state changed on the server could only be
/// seen by reloading. This is the missing half of the nudge: peers already tell US instantly, and
/// this tells the BROWSER.
async fn events(headers: &HeaderMap) -> Response {
    let Some(_signed_in) = crate::web::auth::caller_signed_in(headers).await else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            sign_in_required("follow your albums"),
        );
    };
    // The subscription lives IN the stream, so the socket closing (axum drops the body) is what
    // unsubscribes it. One cleanup, and it cannot be forgotten on an early return.
    let subscription = crate::web::panel_events::subscribe();
    let stream = futures_lite::stream::unfold(subscription, |mut subscription| async move {
        let event = subscription.next().await?;
        let data = json!({ "type": event.as_str() }).to_string();
        let item =
            Ok::<_, std::convert::Infallible>(axum::response::sse::Event::default().data(data));
        Some((item, subscription))
    });
    let response = axum::response::sse::Sse::new(stream)
        // A heartbeat, so an idle intermediary does not close a quiet panel.
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_millis(25_000))
                .text("keep-alive"),
        )
        .into_response();
    let mut response = response;
    // Proxies that buffer would hold every hint until the connection closed, which is the bug this
    // header exists to prevent (Caddy and nginx both honour it).
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

/// `POST /test/emit` — rig-only: emit a panel hint on demand, and say how many panels are listening.
async fn test_emit(headers: &HeaderMap, req: Request) -> Response {
    if !cfg().test_hooks {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    if let Some(response) = require_admin(headers, "emit an event").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(event) = body
        .get("type")
        .and_then(|v| v.as_str())
        .and_then(crate::web::panel_events::PanelEvent::parse)
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "type must be invitations, index or shares" }),
        );
    };
    crate::web::panel_events::emit(event);
    json_response(
        StatusCode::OK,
        json!({ "ok": true, "panels": crate::web::panel_events::panel_count() }),
    )
}

/// `POST /test/pause-sweeps` — rig-only: hold every background sweep, or release them.
async fn pause_sweeps(headers: &HeaderMap, req: Request) -> Response {
    if !cfg().test_hooks {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    if let Some(response) = require_admin(headers, "hold the sweeps").await {
        return response;
    }
    let body = match read_json_body(req).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(paused) = body.get("paused").and_then(|v| v.as_bool()) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "paused must be true or false" }),
        );
    };
    crate::sync::sweeps::set_sweeps_paused(paused);
    // A hold stops the NEXT tick, not the one already running: acknowledged before that cycle
    // finished, it would let a lane claim "no sweep delivered this" while one still could. Bounded,
    // so a slow cycle answers `idle: false` rather than hanging the request.
    let idle = if paused {
        crate::sync::sweeps::when_sweeps_idle(30_000).await
    } else {
        crate::sync::sweeps::sweeps_are_idle()
    };
    crate::log!(
        "rig: background sweeps {}{}",
        if paused { "held" } else { "released" },
        if idle {
            ""
        } else {
            " (a cycle is still running)"
        }
    );
    json_response(
        StatusCode::OK,
        json!({ "paused": crate::sync::sweeps::sweeps_are_paused(), "idle": idle }),
    )
}

/// What a proxied request tells the background work, acted on after the answer is on its way.
///
/// A comment written in the app is pushed NOW, so a person does not wait out the comment loop's
/// cadence for their own message to arrive. The rest is album-index freshness, which is what lets an
/// album someone just made reach the other household without them opening our panel.
fn note_traffic(path: &str, method: &Method, headers: &HeaderMap) {
    let Some(trigger) = crate::sync::traffic_triggers::traffic_trigger_for(method.as_str(), path)
    else {
        return;
    };
    if trigger == crate::sync::traffic_triggers::TrafficTrigger::Comment {
        let owned_state = state().clone();
        tokio::spawn(async move {
            crate::sync::comments::sync_comments_once(
                &owned_state,
                crate::immich::client::shared(),
            )
            .await;
        });
        return;
    }
    // An asset metadata edit: tell every album the photo is offered to, so a caption the origin
    // just fixed reaches its joiners in seconds instead of never (no album row moves on such an
    // edit, so the version handshake cannot see it). The asset id is the path's last segment.
    if trigger == crate::sync::traffic_triggers::TrafficTrigger::AssetMeta {
        let asset_id = path.rsplit('/').next().unwrap_or_default().to_string();
        let targets: Vec<(crate::p2p::frame::RequestHeader, crate::store::Peer)> = {
            let collections = state().collections();
            state()
                .store
                .offered_mappings_for(&asset_id)
                .unwrap_or_default()
                .iter()
                .filter_map(|mid| {
                    collections
                        .mappings
                        .iter()
                        .find(|m| m.id == *mid && m.role == crate::store::Role::Owner && !m.dead)
                })
                .filter_map(|m| {
                    collections
                        .peers
                        .iter()
                        .find(|p| p.pub_key == m.peer)
                        .cloned()
                        .map(|peer| {
                            (
                                crate::p2p::frame::RequestHeader {
                                    path: format!("/albums/{}/nudge", m.album_id),
                                    ..Default::default()
                                },
                                peer,
                            )
                        })
                })
                .collect()
        };
        if !targets.is_empty() {
            let transport = crate::p2p::transport::transport();
            if let Some(transport) = transport {
                for (header, peer) in targets {
                    let transport = transport.clone();
                    tokio::spawn(async move {
                        let _ = transport.round_trip(&peer, &header, None).await;
                    });
                }
            }
        }
        return;
    }
    let Some(creds) = crate::immich::access::creds_from_headers(headers) else {
        return;
    };
    crate::sync::index_freshness::note_index_traffic(state(), trigger, creds);
}

/// The key in Immich's own `/share/<key>` path, which this sidecar fronts. Exactly one segment:
/// anything further is a different route, and an empty key is not a share link.
fn share_key_from_path(path: &str) -> Option<String> {
    let key = path.strip_prefix("/share/")?;
    if key.is_empty() || key.contains('/') {
        return None;
    }
    Some(key.to_string())
}

fn query_has(uri: &Uri, name: &str) -> bool {
    uri.query()
        .map(|q| {
            q.split('&')
                .any(|pair| pair.split('=').next() == Some(name))
        })
        .unwrap_or(false)
}

/// The query string with one parameter removed, everything else kept in order.
fn stripped_query(uri: &Uri, drop_name: &str) -> String {
    uri.query()
        .map(|q| {
            q.split('&')
                .filter(|pair| pair.split('=').next() != Some(drop_name))
                .collect::<Vec<_>>()
                .join("&")
        })
        .unwrap_or_default()
}

/// The join document: the native album in a same-origin iframe, with our card over it.
///
/// The endpoint token is how a visitor's sidecar learns where to dial — the address travels in the
/// page the visitor already has, so no registry learns a server exists.
async fn share_document(key: &str) -> Response {
    let Some(transport) = crate::p2p::transport::transport() else {
        // The token cannot be minted without a bound endpoint, and a card that cannot dial is a
        // card that lies. Say so rather than serving a join that can never complete.
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "the peer transport is not running" }),
        );
    };
    let meta = crate::immich::client::public_share_link_meta(key).await;
    let token = endpoint_token(transport);
    let cover = meta
        .as_ref()
        .and_then(|m| m.cover_asset_id.as_ref())
        .map(|id| format!("/api/assets/{id}/thumbnail?key={}", query::urlencode(key)));
    let page = assets::share_page(
        &token,
        meta.as_ref().and_then(|m| m.album_name.as_deref()),
        cover.as_deref(),
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(HttpBody::from(page))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `{pub, relay?, addrs}` as base64url — the shape `join()` parses and hard-checks against the
/// identity the origin answers with. Absent members are OMITTED, as `JSON.stringify` does.
fn endpoint_token(transport: &crate::p2p::transport::Transport) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("pub".into(), json!(transport.public_key()));
    if let Some(relay) = transport.relay_url() {
        obj.insert("relay".into(), json!(relay));
    }
    let addrs = transport.direct_addresses();
    if !addrs.is_empty() {
        obj.insert("addrs".into(), json!(addrs));
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::Value::Object(obj).to_string())
}

/// Percent-encode a share key for a query string. The key is already URL-safe, but it is a value
/// from the path and is encoded rather than trusted.
fn action_or_default(action: &str) -> &str {
    if action.is_empty() {
        "use this page"
    } else {
        action
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(HttpBody::from(value.to_string()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn html(status: StatusCode, body: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html")
        .body(HttpBody::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

trait WithHeader {
    fn with_header(self, name: header::HeaderName, value: &'static str) -> Response;
}

impl WithHeader for Response {
    fn with_header(mut self, name: header::HeaderName, value: &'static str) -> Response {
        if let Ok(value) = axum::http::HeaderValue::from_str(value) {
            self.headers_mut().insert(name, value);
        }
        self
    }
}

/// Re-exported so `main.rs` and tests agree on what the surface table is.
pub use frontend::surface_for as surface_for_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_defaults_only_when_empty() {
        assert_eq!(action_or_default(""), "use this page");
        assert_eq!(
            action_or_default("join a shared album"),
            "join a shared album"
        );
    }
}

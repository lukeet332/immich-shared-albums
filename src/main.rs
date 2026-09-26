/** main.rs — entry / composition root. Starts the server, then the loops. See ARCHITECTURE.md. */
use immich_shared_albums::config::{cfg, Config};
use immich_shared_albums::{config, log, p2p, state, web};

use axum::Router;

#[tokio::main]
async fn main() {
    let loaded = match Config::from_env() {
        Ok(loaded) => loaded,
        // Fail loudly at boot rather than limping on with a default: a typo'd boolean must never
        // fail open, and ISA_RELAY is a privacy setting.
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let port = loaded.port;
    config::install(loaded);

    let booted = match state::State::boot() {
        Ok(booted) => booted,
        Err(e) => {
            eprintln!("cannot open {}: {e}", cfg().data_dir);
            std::process::exit(1);
        }
    };
    let identity = booted.keys();
    state::install(booted.clone());

    crate::log!(
        "immich-shared-albums v{} on :{}",
        config::SIDECAR_VERSION,
        port
    );
    crate::log!(
        "identity {}",
        &identity.public[..identity.public.len().min(10)]
    );

    // The transport binds BEFORE the HTTP server, because the share page mints an endpoint token
    // per request and a token it cannot mint is a join card that lies. A failure here is fatal
    // rather than degraded: a sidecar that serves pages but cannot reach a peer looks healthy and
    // syncs nothing, which is the worst of both.
    let transport = match p2p::transport::Transport::start(p2p::routes::handler()).await {
        Ok(transport) => transport,
        Err(e) => {
            eprintln!("cannot start the peer transport: {e}");
            std::process::exit(1);
        }
    };
    crate::log!("peer transport listening on udp/{}", cfg().p2p_port);
    p2p::transport::install(transport);

    // What each linked peer can do, refreshed now and deliberately unawaited: nothing the sidecar
    // does depends on the answer, and a peer that is down must not hold up the listener.
    let hello_state = booted.clone();
    tokio::spawn(async move {
        immich_shared_albums::p2p::protocol::hello_peers(&hello_state).await;
    });

    // The loops start AFTER the transport and the server: the watcher dials peers, so a loop that
    // ran first would find no endpoint, and the share page mints a token per request.
    immich_shared_albums::sync::engine::start_watch_loop(booted.clone());
    // The comment lane runs on its own fast cadence: the activity COUNT is one indexed query, so a
    // seconds-level tick stays cheap and the full fetch only runs when the conversation moved.
    immich_shared_albums::sync::comments::start_comment_loop(booted.clone());
    immich_shared_albums::sync::directory::start_directory_loop(booted.clone());

    // Both are diagnostics or cosmetics, both are best-effort, and neither may hold up the listener:
    // the admin-key probe says what an operator has to fix, and the domain rename heals accounts a
    // previous version left on a legacy address.
    tokio::spawn(async move {
        immich_shared_albums::immich::admin_key::verify_admin_key_at_boot(
            immich_shared_albums::immich::client::shared(),
        )
        .await;
    });
    tokio::spawn(async move {
        immich_shared_albums::immich::migrate_domain::migrate_utility_domain(
            immich_shared_albums::immich::client::shared(),
        )
        .await;
    });

    let app = Router::new().fallback(web::server::serve);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
    crate::log!("stopped");
}

/// Docker sends SIGTERM; without a handler the process is SIGKILLed after the runtime's whole
/// grace period. Rust installs no handler by default, so this is the equivalent of shutdown.ts.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    crate::log!("signal received, shutting down");
}

// compat_probe.rs — what the Rust store actually sees in a state.db someone else wrote.
//
//   ISA_COMPAT_DB=/path/to/data-dir cargo run --example compat_probe
//
// Prints the schema version, whether the raw `identity` ROW is readable, whether it PARSES into the
// Identity struct, and what the loaded collections contain. A row that reads but does not parse is
// the failure that matters: `ensure_identity` then mints a new key and orphans every existing link.
use immich_shared_albums::store::Store;

fn main() {
    let dir = std::env::var("ISA_COMPAT_DB").expect("ISA_COMPAT_DB must name a data directory");
    let store = Store::open(&dir).expect("open the store");
    println!("user_version: {:?}", store.user_version());
    println!(
        "kv(identity) readable: {:?}",
        store.kv("identity").map(|v| v.is_some())
    );
    let raw = store.kv("identity").ok().flatten();
    if let Some(v) = &raw {
        println!(
            "identity row: v={} alg={} keys={:?}",
            v.get("v").and_then(|x| x.as_i64()).unwrap_or(-1),
            v.get("alg").and_then(|x| x.as_str()).unwrap_or("?"),
            v.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        );
    }
    let state = store.state.lock().unwrap();
    match &state.identity {
        Some(id) => println!(
            "parsed identity: pub={} priv_len={} createdAt={}",
            &id.public[..id.public.len().min(12)],
            id.private.len(),
            id.created_at
        ),
        None => println!("parsed identity: NONE — a boot here would MINT A NEW KEY"),
    }
    println!(
        "loaded: peers={} mappings={} contributors={}",
        state.peers.len(),
        state.mappings.len(),
        state.contributors.len()
    );
}

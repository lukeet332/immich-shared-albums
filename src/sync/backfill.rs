//! sync/backfill.rs — when the admin turns on "store shared assets locally", upgrade the mirrors we
//! already hold as stubs into full local copies. See ARCHITECTURE.md.
//!
//! Runs inside the reconcile pass (under its per-mapping mutex), a bounded number per cycle so a big
//! album drains over several ticks, and stops on its own once no stub rows remain.

use crate::immich::client::Client;
use crate::immich::refs::AssetRef;
use crate::state::State;
use crate::store::{Mapping, Peer};

/// How many stubs one cycle upgrades. A big album drains over several ticks rather than holding the
/// reconcile — and a person's panel — open for minutes.
const MAX_PER_CYCLE: usize = 20;

/// Are there mirrored stubs not yet upgraded to full copies?
///
/// Gates the reconcile's manifest pull, so the backfill still runs when the album's version has not
/// changed: switching the setting on changes nothing at the origin.
pub fn has_stub_rows(state: &State, mapping_id: &str) -> bool {
    state
        .store
        .seen_for_mapping(mapping_id)
        .unwrap_or_default()
        .iter()
        .any(|row| row.origin_asset.is_some() && !row.stored_full)
}

pub async fn backfill_full_copies(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    manifest: &[AssetRef],
) {
    let stubs: std::collections::HashMap<String, String> = state
        .store
        .seen_for_mapping(&mapping.id)
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.origin_asset.is_some() && !row.stored_full)
        .map(|row| (row.checksum, row.local_asset))
        .collect();
    if stubs.is_empty() {
        return;
    }
    let mut done = 0usize;
    for reference in manifest {
        if done >= MAX_PER_CYCLE {
            break;
        }
        let Some(stub_asset_id) = stubs.get(&reference.checksum) else {
            continue;
        };
        match crate::immich::materialise::upgrade_stub_to_full(
            state,
            client,
            mapping,
            peer,
            reference,
            stub_asset_id,
        )
        .await
        {
            Ok(true) => {
                done += 1;
                crate::log!(
                    "backfilled a full local copy into \"{}\"",
                    mapping.album_name
                );
            }
            Ok(false) => {}
            Err(e) => crate::log!(
                "backfill failed ({}): {e}",
                crate::config::short_id(&reference.checksum)
            ),
        }
    }
}

# The accounts this addon creates

`contributors.ts` provisions the local Immich accounts that stand in for people on other servers.
They are the addon's largest footprint inside someone else's instance, and its most sensitive
artefacts — each holds an API key in `state.db`.

## One account per remote person, doing two jobs

An account both **owns that person's mirrored photos** (so attribution survives) and **is what a
human picks** in Immich's album picker to share with them.

Immich forces that overlap. An album owner adding an asset owned by a **non-member** is refused
with `no_permission`, so an account must be a member of any album where it owns content. It follows
that album membership alone cannot mean "a human invited them" — see [`../sync/invites.md`](../sync/)
for the two records that carry that distinction instead.

## Why `ensureContributor` reads before it writes

The order in that function is a security property, not defensiveness:

1. **read the album's current members**
2. if the account is **already** a member, do nothing and record nothing — someone else put them
   there, and that someone is a human whose intent must not be overwritten
3. otherwise **record** the membership as ours, *then* add it

Recording after the add would leave, on any crash between the two, a membership with no record —
which reads as human intent and shares the album with a server nobody offered it to. This way the
same crash leaves a record with no membership, which merely ignores a real invitation until the
human re-adds.

`mayAdd: false` is the other half: on an **invitation** album an invited person who is not a member
has been *revoked*, so we must not put them back. Filling that gap was the sidecar overruling the
human, and was the source of a revoke-versus-arriving-content race.

If the album cannot be read at all, treat it as "not a member" and go through the record-then-add
path anyway. Skipping is safe against over-sharing but stops attribution working on any album the
admin cannot read, which on a multi-user origin is most of them.

## Scoped keys, and no retained password

`ACCOUNT_PERMISSIONS` is the exact list this addon exercises — own the stubs, curate the mirror
album, mirror comments, carry an avatar — rather than `all`. These are non-admin accounts, so an
`all` key was never admin-equivalent, but it still granted every action that user could take on a
credential sitting in `state.db`.

The password exists **only** to mint that key, and is rolled to a value nobody keeps afterwards.
The gain is modest but real: a scoped key deliberately lacks `apiKey.create`, so it can do its
listed actions and no more, whereas a password logs in interactively and can mint an unrestricted
key for that account. Keeping it is pure downside rather than a trade-off. The e2e asserts no
password survives provisioning.

Instances with password login disabled (OAuth-only) need a brief toggle to mint the key at all;
that is restored afterwards, and a failure to restore it is logged loudly.

## Names

A directory placement owns the display name — it is the only caller that knows which server to
name. An attribution ref arriving later must not rename the account back to the generic suffix, or
the two would overwrite each other every poll. See [`../config.md`](../config.md) for the naming
scheme itself.

## Provisioning quirks worth knowing

- **A partially provisioned account is resumed, not recreated.** The password is persisted only
  while provisioning is incomplete, so a retry can finish the job; once the key is minted it is
  rolled and dropped.
- **An admin password reset must also clear `shouldChangePassword`**, or the programmatic login
  used to mint the key is refused.
- **Instances with password login disabled** (OAuth-only) need it toggled on briefly to mint a key
  at all. It is restored afterwards, and a failure to restore is logged loudly.
- **A freshly minted key can 500 on its first writes** on a cold instance, so the first album write
  retries with backoff rather than treating it as fatal.
- **Accounts are keyed by the person's id on their own server** wherever a ref or directory carries
  it, so the mirror owner and the directory entry are the same human rather than two picker entries.

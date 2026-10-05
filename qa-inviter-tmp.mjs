// QA: the INVITER (not the adopter) ends the reunion. Both albums must return to their own photos.
const A = 'http://100.72.183.72:9301';
const B = 'http://100.72.183.72:9302';
const NAME = 'Portugal 2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (base) =>
  (await (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@e2e.local', password: 'e2e-admin-pass-1' }),
  })).json()).accessToken;
const tA = await login(A);
const tB = await login(B);
const hdr = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const panel = async (base, t, path, body) =>
  await (await fetch(`${base}/immich-shared-albums${path}`, {
    method: body ? 'POST' : 'GET',
    headers: hdr(t),
    body: body ? JSON.stringify(body) : undefined,
  })).json();
const albums = async (base, t) => await (await fetch(`${base}/api/albums`, { headers: hdr(t) })).json();
const detail = async (base, t, id) => await (await fetch(`${base}/api/albums/${id}`, { headers: hdr(t) })).json();
const isMirrorOwner = (email) => String(email || '').endsWith('@immich-shared-albums.internal');
const show = async (label, base, t) => {
  const out = [];
  for (const a of ((await albums(base, t)) || []).filter((x) => x.albumName === NAME)) {
    const d = await detail(base, t, a.id);
    const human = (d.albumUsers || []).some((u) => u.role === 'owner' && !isMirrorOwner(u.user?.email));
    const foreign = (d.assets?.items || []).filter((x) => isMirrorOwner(x.ownerId)).length;
    out.push(`${a.id.slice(0, 8)} assets=${d.assetCount} ${human ? '(a person owns it)' : '(stand-in mirror)'}`);
  }
  console.log(`  ${label}: ${out.join(' | ')}`);
};

// Fresh pairing, then the reunion.
for (const [base, t] of [[A, tA], [B, tB]]) {
  for (const p of ((await panel(base, t, '/peers')).peers || [])) {
    await panel(base, t, '/unlink', { pub: p.pub });
  }
}
const { link } = await panel(A, tA, '/pairings', {});
await panel(B, tB, '/pair', { link });
await sleep(5000);

console.log('=== BEFORE the reunion');
await show('A (INVITER)', A, tA);
await show('B (adopter)', B, tB);

const matchA = (await panel(A, tA, '/me/matches')).matches.find((m) => m.mine.name === NAME);
console.log('  A invites:', JSON.stringify(await panel(A, tA, '/me/invite', {
  peer: matchA.peer, albumName: NAME, ownerUserId: matchA.theirs.ownerUserId,
})));
await sleep(8000);
const matchB = (await panel(B, tB, '/me/matches')).matches.find((m) => m.step.kind === 'accept');
console.log('  B accepts:', JSON.stringify(await panel(B, tB, '/me/reunite', {
  mappingId: matchB.mappingId, albumName: NAME,
})));
await sleep(14000);

console.log('=== AFTER the reunion (the union, both ways)');
await show('A (INVITER)', A, tA);
await show('B (adopter)', B, tB);

// The inviter's own row, which is what the panel's button uses.
const inviterRow = ((await panel(A, tA, '/me/albums')).albums || [])
  .find((a) => a.name === NAME && a.reunified === true);
console.log('  A /me/albums row:', JSON.stringify(inviterRow && {
  reunified: inviterRow.reunified, adoptedByUs: inviterRow.adoptedByUs, mappingId: String(inviterRow.mappingId).slice(0, 8),
}));
if (!inviterRow) {
  console.log('  !! the inviter is offered no Un-reunite row — the feature is not reachable');
  process.exit(1);
}

const t0 = Date.now();
console.log('  A un-reunites:', JSON.stringify(await panel(A, tA, '/me/unreunite', { mappingId: inviterRow.mappingId })));
let mirrorMs = null;
for (let i = 0; i < 120; i++) {
  await sleep(250);
  let found = false;
  for (const a of ((await albums(B, tB)) || []).filter((x) => x.albumName === NAME)) {
    const d = await detail(B, tB, a.id);
    if ((d.albumUsers || []).some((u) => u.role === 'owner' && isMirrorOwner(u.user?.email))) found = true;
  }
  if (found) { mirrorMs = Date.now() - t0; break; }
}
console.log(`  the adopter's mirror is back after ${mirrorMs ?? '>30000'}ms`);
await sleep(8000);

console.log('=== AFTER the inviter undid it (both should be their own 3)');
await show('A (INVITER)', A, tA);
await show('B (adopter)', B, tB);
console.log('  A still claims reunified?',
  JSON.stringify(((await panel(A, tA, '/me/albums')).albums || []).filter((a) => a.name === NAME).map((a) => a.reunified === true)));

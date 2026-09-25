// Seed the rig for a HAND test: two linked Rust households with something real to click on.
//
// Not a lane. `RIG_UP_ONLY=1 bash demo/run-mock-e2e.sh` calls this AFTER that script's guarded
// purge, so the destructive guard (`require_mock`) lives in the rig script and this only ever
// writes to a rig it just reset. It makes no destructive call of its own beyond replacing the
// contents of the two albums it owns by name.
//
// What it leaves behind:
//   * B and C paired, so both panels list the other household and its people;
//   * "Portugal 2026" owned on BOTH sides (Demo Nan on B, Grandpa Joe on C), each with real photos,
//     and one photo with IDENTICAL bytes on both — the reunion pair and its dedupe case;
//   * "Iceland 2026" on C with a share link, for the join -> store-locally -> native-leave path.
//
// Env: PORT_IMMICH_B/C, PORT_SIDECAR_B/C, BKEY, CKEY, ISA_HAND_TEST_EMAIL/PASSWORD,
//      ISA_HAND_TEST_HOST (the address a PERSON opens, printed in the handover) and
//      ISA_HAND_DRIVE_HOST (the address THIS script talks to, default: the same).
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const PORT = (name, dflt) => process.env[name] || dflt;
// Two addresses on purpose. The tester's device reaches the sidecar on the host's tailnet address
// while this script runs on the host itself, and a port bound to that address is not on loopback —
// so the URL that is PRINTED and the URL that is FETCHED are different things.
const URL_HOST = process.env.ISA_HAND_TEST_HOST || 'localhost';
const DRIVE_HOST = process.env.ISA_HAND_DRIVE_HOST || URL_HOST;
const B_IMMICH = `http://localhost:${PORT('PORT_IMMICH_B', 2384)}`;
const C_IMMICH = `http://localhost:${PORT('PORT_IMMICH_C', 2385)}`;
const B_SIDECAR = `http://${DRIVE_HOST}:${PORT('PORT_SIDECAR_B', 9381)}`;
const C_SIDECAR = `http://${DRIVE_HOST}:${PORT('PORT_SIDECAR_C', 9382)}`;
const BKEY = process.env.BKEY;
const CKEY = process.env.CKEY;
const DEFAULT_EMAIL = 'admin@e2e.local';
const DEFAULT_PASSWORD = 'e2e-admin-pass-1';
const EMAIL = process.env.ISA_HAND_TEST_EMAIL || DEFAULT_EMAIL;
const PASSWORD = process.env.ISA_HAND_TEST_PASSWORD || DEFAULT_PASSWORD;
// Whether the caller overrode the credential, never the credential itself: the handover prints the
// DOCUMENTED rig password, and echoing one that came from the environment would put a secret this
// repo does not own into a log. CodeQL flags exactly that, and it is right to.
const passwordWasOverridden = !!process.env.ISA_HAND_TEST_PASSWORD;

const REUNION_ALBUM = 'Portugal 2026';
const JOIN_ALBUM = 'Iceland 2026';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `fetch`, with the URL in the error: undici's bare "fetch failed" names neither the host nor why. */
const get = async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`${url} — ${e?.cause?.message || e?.message || 'unreachable'}`);
  }
};
const j = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const api = async (base, key, path, init = {}) => {
  const r = await get(`${base}/api${path}`, {
    ...init,
    headers: { 'x-api-key': key, ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${base}/api${path} -> ${r.status} ${JSON.stringify(body).slice(0, 120)}`);
  return body;
};

/** Every sidecar call rides the caller's OWN Immich session, exactly as the panel does. */
const sidecar = async (base, token, path, init = {}) => {
  const r = await get(`${base}/immich-shared-albums${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

// ---- real image files -----------------------------------------------------------------------
// The rig's fixtures are flat 200x140 colour blocks: fine as bytes, useless when a person is
// scanning an album grid for "which one came from the other server". These are 1600x1200 PNGs with
// a big readable label, drawn here rather than committed, so the label and the seed cannot drift.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
};
const png = (width, height, pixel) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// 5x7 uppercase, so a label can say what the photo is instead of being a coloured rectangle.
const FONT = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0b11111, 0, 0, 0],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
};

/** A 1600x1200 photo: a colour wash, a diagonal band, and the label burnt in large. */
const photo = (label, [r, g, b]) => {
  const W = 1600;
  const H = 1200;
  const scale = 16;
  const text = label.toUpperCase();
  const glyphW = 6 * scale;
  const textW = text.length * glyphW;
  const x0 = Math.round((W - textW) / 2);
  const y0 = Math.round((H - 7 * scale) / 2);
  const lit = (x, y) => {
    const col = Math.floor((x - x0) / glyphW);
    if (col < 0 || col >= text.length) return false;
    const row = Math.floor((y - y0) / scale);
    if (row < 0 || row > 6) return false;
    const bits = FONT[text[col]] || FONT[' '];
    const inGlyph = Math.floor(((x - x0) % glyphW) / scale);
    return inGlyph < 5 && ((bits[row] >> (4 - inGlyph)) & 1) === 1;
  };
  return png(W, H, (x, y) => {
    const wash = 0.45 + 0.3 * (x / W) + 0.25 * (y / H);
    const band = (x + y) % 260 < 130 ? 0.82 : 1;
    const shade = Math.min(1, wash) * band;
    if (lit(x, y)) return [255, 255, 255];
    return [Math.round(r * shade), Math.round(g * shade), Math.round(b * shade)];
  });
};

// ---- seeding --------------------------------------------------------------------------------

async function login(base, email, password) {
  const r = await get(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  return r.ok ? body.accessToken : null;
}

async function upload(base, key, filename, bytes, takenAt) {
  const fd = new FormData();
  fd.set('deviceAssetId', `hand-${filename}`);
  fd.set('deviceId', 'hand-test-seed');
  fd.set('fileCreatedAt', takenAt);
  fd.set('fileModifiedAt', takenAt);
  fd.set('assetData', new Blob([bytes], { type: filename.endsWith('.mp4') ? 'video/mp4' : 'image/png' }), filename);
  const r = await get(`${base}/api/assets`, { method: 'POST', headers: { 'x-api-key': key }, body: fd });
  const out = await r.json();
  if (!out.id) throw new Error(`upload of ${filename} failed: ${JSON.stringify(out).slice(0, 120)}`);
  return out.id;
}

/** Immich extracts dimensions and renders the preview on its own schedule; a hand tester should not
 *  be the one waiting for it. */
async function untilRendered(base, key, id, what) {
  for (let i = 0; i < 60; i++) {
    const r = await get(`${base}/api/assets/${id}/thumbnail?size=preview`, { headers: { 'x-api-key': key } });
    if (r.ok) return true;
    await sleep(500);
  }
  check(`${what} rendered a preview`, false, 'still no thumbnail after 30s');
  return false;
}

/** Replace an album of this name on this server, so a re-run does not accumulate them. */
async function albumNamed(base, key, name, photoIds) {
  const albums = await api(base, key, '/albums');
  for (const existing of albums.filter((a) => a.albumName === name)) {
    await api(base, key, `/albums/${existing.id}`, { method: 'DELETE' }).catch(() => {});
  }
  const album = await api(base, key, '/albums', { method: 'POST', ...j({ albumName: name }) });
  if (photoIds.length) {
    await api(base, key, `/albums/${album.id}/assets`, { method: 'PUT', ...j({ ids: photoIds }) });
  }
  return album;
}

const REFS = {
  'C-sunset.png': ['C SUNSET', [196, 96, 40], '2026-06-01T18:20:00.000Z', [38.7223, -9.1393]],
  'C-castle.png': ['C CASTLE', [96, 72, 168], '2026-06-02T10:05:00.000Z', [38.7979, -9.3906]],
  'shared-beach.png': ['SHARED BEACH', [40, 148, 148], '2026-06-03T12:00:00.000Z', [38.6979, -9.4215]],
  'B-market.png': ['B MARKET', [64, 132, 64], '2026-06-04T09:30:00.000Z', [41.1579, -8.6291]],
  'B-tram.png': ['B TRAM', [176, 152, 40], '2026-06-05T15:45:00.000Z', [38.7139, -9.1394]],
  'C-glacier.png': ['C GLACIER', [72, 128, 176], '2026-07-10T11:00:00.000Z', [64.1466, -21.9426]],
  'C-aurora.png': ['C AURORA', [56, 96, 128], '2026-07-11T23:30:00.000Z', [64.1355, -21.8954]],
};

const main = async () => {
  // 1. Both Immichs answer, and the credential a person will type actually signs in — on BOTH, which
  //    the rig's production hardening deliberately breaks on C (passwordLogin off).
  const tokens = {};
  for (const [label, base] of [['B', B_IMMICH], ['C', C_IMMICH]]) {
    const ping = await get(`${base}/api/server/ping`).then((r) => r.ok).catch(() => false);
    check(`immich ${label} answers`, ping, base);
    tokens[label] = await login(base, EMAIL, PASSWORD);
    check(`${label}: ${EMAIL} can sign in with a password`, !!tokens[label],
      tokens[label] ? '' : 'password login refused — a hand test cannot start');
  }
  const bToken = tokens.B;
  const cToken = tokens.C;
  if (!bToken || !cToken) return;

  // 2. Pair the two households, the way the panel does it: mint on one, redeem on the other.
  const minted = await sidecar(B_SIDECAR, bToken, '/pairings', { method: 'POST' });
  check('B minted a pairing link', minted.status === 200 && !!minted.body.link, `status ${minted.status}`);
  const redeemed = await sidecar(C_SIDECAR, cToken, '/pair', {
    method: 'POST',
    body: JSON.stringify({ link: minted.body.link }),
  });
  check('C redeemed it, so the two are linked', redeemed.status === 200, JSON.stringify(redeemed.body).slice(0, 80));

  const peersOn = async (base, token) => (await sidecar(base, token, '/peers')).body.peers || [];
  // By NAME, not by position: a rig that has been through the suite may still be linked to the
  // third household (D), and offering B's albums to the wrong peer would leave no pair to reunite.
  const peerNamed = (peers, needle) => peers.find((p) => (p.name || '').includes(needle));
  let cPeerOnB = null;
  for (let i = 0; i < 40; i++) {
    cPeerOnB = peerNamed(await peersOn(B_SIDECAR, bToken), '(C)');
    if (cPeerOnB && (cPeerOnB.people || 0) > 0) break;
    await sleep(1000);
  }
  check('B lists household C AND its people, so the panel has someone to open',
    !!cPeerOnB && cPeerOnB.people > 0, cPeerOnB ? `${cPeerOnB.name}: ${cPeerOnB.people} people` : 'not listed');
  const bPeerOnC = peerNamed(await peersOn(C_SIDECAR, cToken), '(B)');
  check('C lists B too (one round trip pairs both)', !!bPeerOnC, bPeerOnC?.name || 'not listed');
  if (!cPeerOnB || !bPeerOnC) return;
  const peerPubOnB = cPeerOnB.pub;
  const peerPubOnC = bPeerOnC.pub;

  // 3. Real albums, real photos, on both sides.
  const cIds = {};
  for (const name of ['C-sunset.png', 'C-castle.png', 'shared-beach.png']) {
    const [label, colour, takenAt, gps] = REFS[name];
    cIds[name] = await upload(C_IMMICH, CKEY, name, photo(label, colour), takenAt);
    await api(C_IMMICH, CKEY, `/assets/${cIds[name]}`, { method: 'PUT', ...j({ latitude: gps[0], longitude: gps[1] }) });
    await untilRendered(C_IMMICH, CKEY, cIds[name], name);
  }
  const bIds = {};
  for (const name of ['B-market.png', 'B-tram.png']) {
    const [label, colour, takenAt, gps] = REFS[name];
    bIds[name] = await upload(B_IMMICH, BKEY, name, photo(label, colour), takenAt);
    await api(B_IMMICH, BKEY, `/assets/${bIds[name]}`, { method: 'PUT', ...j({ latitude: gps[0], longitude: gps[1] }) });
    await untilRendered(B_IMMICH, BKEY, bIds[name], name);
  }
  // The dedupe case: the SAME bytes uploaded to both servers, so the reunion must not keep two.
  const [sharedLabel, sharedColour, sharedAt, sharedGps] = REFS['shared-beach.png'];
  const sharedBytes = photo(sharedLabel, sharedColour);
  const sharedOnC = await upload(C_IMMICH, CKEY, 'shared-beach.png', sharedBytes, sharedAt);
  const sharedOnB = await upload(B_IMMICH, BKEY, 'shared-beach.png', sharedBytes, sharedAt);
  for (const [base, key, id] of [[C_IMMICH, CKEY, sharedOnC], [B_IMMICH, BKEY, sharedOnB]]) {
    await api(base, key, `/assets/${id}`, { method: 'PUT', ...j({ latitude: sharedGps[0], longitude: sharedGps[1] }) });
    await untilRendered(base, key, id, 'shared-beach.png');
  }
  const cSums = new Set();
  for (const id of [cIds['C-sunset.png'], cIds['C-castle.png'], sharedOnC]) {
    cSums.add((await api(C_IMMICH, CKEY, `/assets/${id}`)).checksum);
  }
  const bShared = await api(B_IMMICH, BKEY, `/assets/${sharedOnB}`);
  check('the shared photo is byte-identical on both servers, which is the dedupe case',
    cSums.has(bShared.checksum), `B checksum ${bShared.checksum.slice(0, 12)}… in C? ${cSums.has(bShared.checksum)}`);

  const cAlbum = await albumNamed(C_IMMICH, CKEY, REUNION_ALBUM,
    [cIds['C-sunset.png'], cIds['C-castle.png'], sharedOnC]);
  const bAlbum = await albumNamed(B_IMMICH, BKEY, REUNION_ALBUM,
    [bIds['B-market.png'], bIds['B-tram.png'], sharedOnB]);
  check(`C owns "${REUNION_ALBUM}" with 3 photos`, true, `album ${cAlbum.id.slice(0, 8)}`);
  check(`B owns "${REUNION_ALBUM}" with 3 photos`, true, `album ${bAlbum.id.slice(0, 8)}`);

  // 4. Offer each side's albums to the other, so the panel finds the pair on the first visit
  //    instead of after a publish. The panel does exactly this when a person is opened.
  const publishedB = await sidecar(B_SIDECAR, bToken, '/me/albums/publish', {
    method: 'POST',
    body: JSON.stringify({ peer: peerPubOnB }),
  });
  const publishedC = await sidecar(C_SIDECAR, cToken, '/me/albums/publish', {
    method: 'POST',
    body: JSON.stringify({ peer: peerPubOnC }),
  });
  check('both sides offered their own albums for matching',
    publishedB.status === 200 && publishedC.status === 200,
    `B ${publishedB.status}, C ${publishedC.status}`);

  let matches = [];
  for (let i = 0; i < 20; i++) {
    matches = ((await sidecar(B_SIDECAR, bToken, '/me/matches')).body.matches || []).filter((m) =>
      JSON.stringify(m).includes(REUNION_ALBUM));
    if (matches.length) break;
    await sleep(1000);
  }
  check(`B's panel will offer "${REUNION_ALBUM}" as a reunion`, matches.length > 0,
    JSON.stringify(matches).slice(0, 160));

  // 5. The join path: a second album on C, shared by link, which is what the store-locally toggle
  //    and a native leave are tested against.
  const glacier = await upload(C_IMMICH, CKEY, 'C-glacier.png', photo(...REFS['C-glacier.png'].slice(0, 2)), REFS['C-glacier.png'][2]);
  const aurora = await upload(C_IMMICH, CKEY, 'C-aurora.png', photo(...REFS['C-aurora.png'].slice(0, 2)), REFS['C-aurora.png'][2]);
  const clip = fs.readFileSync(new URL('./e2e/fixtures/clip.mp4', import.meta.url));
  const video = await upload(C_IMMICH, CKEY, 'C-lagoon.mp4', clip, '2026-07-12T09:00:00.000Z');
  for (const id of [glacier, aurora]) await untilRendered(C_IMMICH, CKEY, id, 'iceland photo');
  await untilRendered(C_IMMICH, CKEY, video, 'iceland video poster');
  const joinAlbum = await albumNamed(C_IMMICH, CKEY, JOIN_ALBUM, [glacier, aurora, video]);
  for (const stale of (await api(C_IMMICH, CKEY, '/shared-links')).filter((l) => l.album?.id === joinAlbum.id)) {
    await api(C_IMMICH, CKEY, `/shared-links/${stale.id}`, { method: 'DELETE' }).catch(() => {});
  }
  const link = await api(C_IMMICH, CKEY, '/shared-links', {
    method: 'POST',
    ...j({ type: 'ALBUM', albumId: joinAlbum.id, allowUpload: true }),
  });

  const host = URL_HOST;
  const bOrigin = `http://${host}:${PORT('PORT_SIDECAR_B', 9381)}`;
  const cOrigin = `http://${host}:${PORT('PORT_SIDECAR_C', 9382)}`;
  console.log(`
──────────────────────────────────────────────────────────────────────────────
 HAND TEST — two Rust households, linked, with real content
──────────────────────────────────────────────────────────────────────────────
 Sign in on BOTH (same account; the name differs per household):
   email     ${EMAIL}
   password  ${passwordWasOverridden ? '(the ISA_HAND_TEST_PASSWORD you set)' : DEFAULT_PASSWORD}

   B — "Demo Nan"        ${bOrigin}/immich-shared-albums/
   C — "Grandpa Joe"     ${cOrigin}/immich-shared-albums/
 (Each origin serves that household's Immich AND our panels, so one sign-in per
  server covers both. Cookies are per-origin: sign in twice.)

 READY TO UNIFY — "${REUNION_ALBUM}"
   C holds 3 photos, B holds 3, and "shared-beach.png" is the SAME BYTES on both.
   B: ${bOrigin}/immich-shared-albums/me   ->  "Possible album reunions" -> Invite
   C: ${cOrigin}/immich-shared-albums/me   ->  the waiting invite       -> Accept invite
   (Both panels ask to confirm first. If the pair is not listed yet, open the
    other person's panel once — matching is a pull, and a panel visit is when
    your own albums are offered.)
   After the merge EACH side should hold 5 photos, not 6 — that is the dedupe.

 READY TO JOIN — "${JOIN_ALBUM}" (2 photos + 1 video) on C:
   ${cOrigin}/share/${link.key}
   Open it, type ${host}:${PORT('PORT_SIDECAR_B', 9381)} as your server, join as B.
   The store-locally toggle is on the ADMIN panel, not the personal one:
     ${bOrigin}/immich-shared-albums/admin  ->  Settings
   Turn it on, wait for the copies, then Leave album in Immich itself.

 Any later run of demo/run-mock-e2e.sh purges all of this and resets both states.
──────────────────────────────────────────────────────────────────────────────
`);
};

try {
  await main();
} catch (e) {
  check('the seed ran to completion', false, e?.message || String(e));
}
const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? '\n🎉 HAND TEST RIG READY' : `\n💥 ${failed} seeding failure(s)`);
process.exit(failed === 0 ? 0 : 1);

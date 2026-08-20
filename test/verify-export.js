// Regression test for the bundle src/designer.js writes — the .zip the hosted generator is handed.
//
// Nothing downstream of `buildBundleFiles` had a check. The zip writer, the CRC table it stamps entries
// with, the reader that takes a design back in, and the base64 the editable layers round-trip through are
// all hand-rolled, and all of them fail the same quiet way: the file is produced, the download works, and
// the service rejects it — or worse, accepts it and generates a world from corrupt bytes.
//
// So the checks here are structural and independent:
//   * the CRC is checked against the value the CRC-32 standard publishes for its own test vector, not
//     against another run of the same table
//   * the zip is parsed by a SEPARATE minimal reader written in this file, walking the end-of-central-
//     directory record and the central directory the way a real unzip does — `unzipStore` only reads local
//     headers, so a round trip through it alone would not notice a wrong central directory at all
//   * base64 is exercised across the 0x8000-byte chunk boundary its encoder splits on
//   * a design round-trips through the same encode/decode pair `buildBundleFiles` and `importDesignZip` use
//
// `gridToPng` is NOT covered: it is `canvas.toBlob`, which is the browser's PNG encoder rather than the
// designer's code, and the PNGs it writes are for human inspection — the mod reads the .bin files.
//
// `DESIGNER=<path> node test/verify-export.js` runs this against another copy of designer.js. Every check
// below was kept only after it FAILED on a copy carrying the single change beside it, and passed on src/:
//
//   check                                        the one change that makes it fail
//   crc32 matches the standard's check value     the final inversion is dropped
//   the zip is a valid archive                   the central directory's local offset is off by one
//   unzipStore reads back what makeZip wrote     the reader walks one byte past each entry
//   a compressed entry reported as unreadable    the STORE check is removed
//   base64 round-trips across its chunk          each chunk is encoded one byte short
//   a design survives the trip and back          the decoder masks the high bit off every byte
//   the world size is found wherever it sits     findWorldWidth looks for 'worldWidth'
//
//   node test/verify-export.js
'use strict';
const { run, reporter } = require('./designer-harness');

const { check, done } = reporter();
const PARTS = ['const:CRC', 'fn:crc32', 'fn:strBytes', 'fn:abToB64', 'fn:b64ToU8', 'fn:unzipStore', 'fn:makeZip', 'fn:findWorldWidth'];

// ---------------------------------------------------------------- CRC-32

// "123456789" hashing to 0xCBF43926 is the check value the CRC-32/ISO-HDLC definition publishes. It pins
// the polynomial, the bit order, and both the initial and final inversions at once — everything a zip
// reader on the other end will assume.
{
  const r = run(PARTS, {}, `
    const one = crc32(strBytes('123456789'));
    const empty = crc32(new Uint8Array(0));
    const a = crc32(new Uint8Array([1, 2, 3, 4])), b = crc32(new Uint8Array([1, 2, 3, 5]));
    let big = 0; for (let i = 0; i < 4; i++) big = Math.max(big, crc32(new Uint8Array(70000).fill(i)));
    return { one, empty, differs: a !== b, inRange: big >= 0 && big <= 0xFFFFFFFF };`);
  check('crc32 matches the standard\'s own check value',
    r.one === 0xCBF43926 && r.empty === 0 && r.differs && r.inRange,
    'crc32("123456789") = 0x' + r.one.toString(16).toUpperCase() + ' (the standard says 0xCBF43926), empty = ' + r.empty);
}

// ---------------------------------------------------------------- the zip

/** A minimal independent zip reader: EOCD, then the central directory, then each local header it points at. */
function readZipIndependently(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let p = bytes.length - 22; p >= 0; p--) if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = dv.getUint16(eocd + 10, true), cenSize = dv.getUint32(eocd + 12, true), cenAt = dv.getUint32(eocd + 16, true);
  if (cenAt + cenSize !== eocd) throw new Error('central directory does not end where the EOCD begins');
  const entries = [];
  let p = cenAt;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('central entry ' + i + ' has no signature');
    const crc = dv.getUint32(p + 16, true), comp = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(name + ': central directory points at a non-local-header offset');
    const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
    const lName = new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + lNameLen));
    if (lName !== name) throw new Error('name mismatch: central "' + name + '" vs local "' + lName + '"');
    if (dv.getUint16(local + 8, true) !== 0) throw new Error(name + ': not stored uncompressed');
    if (dv.getUint32(local + 14, true) !== crc) throw new Error(name + ': local CRC differs from the central one');
    if (comp !== size) throw new Error(name + ': compressed and uncompressed sizes differ in a stored entry');
    const at = local + 30 + lNameLen + lExtraLen;
    entries.push({ name, crc, data: bytes.subarray(at, at + size) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p !== eocd) throw new Error('central directory is ' + (p - cenAt) + ' bytes, EOCD says ' + cenSize);
  return entries;
}

// The bundle the service receives, with the shapes that break naive writers in it: an empty file, a file
// holding every byte value, and one big enough that a 16-bit size field would wrap.
const FILES = [
  { name: 'WorldGenerator.eco', text: '{ "WorldWidth": 120 }' },
  { name: 'biome.bin', bytes: Uint8Array.from({ length: 4096 }, (_, i) => i % 11) },
  { name: 'authored.json', text: '{ "enabled": true, "source": "eco-map-generator" }' },
  { name: 'empty.bin', bytes: new Uint8Array(0) },
  { name: 'all256.bin', bytes: Uint8Array.from({ length: 256 }, (_, i) => i) },
  { name: 'height.bin', bytes: Uint8Array.from({ length: 70000 }, (_, i) => (i * 37) & 255) },
];
const zip = run(PARTS, { FILES }, `
  const files = FILES.map(f => ({ name: f.name, data: f.text != null ? strBytes(f.text) : Uint8Array.from(f.bytes) }));
  return makeZip(files);`);

{
  let err = null, entries = [];
  try { entries = readZipIndependently(zip); } catch (e) { err = e.message; }
  let wrongCrc = 0, wrongBytes = 0;
  if (!err) {
    const want = new Map(FILES.map(f => [f.name, f.text != null ? new TextEncoder().encode(f.text) : Uint8Array.from(f.bytes)]));
    for (const e of entries) {
      const w = want.get(e.name);
      if (!w || w.length !== e.data.length) { wrongBytes++; continue; }
      for (let i = 0; i < w.length; i++) if (w[i] !== e.data[i]) { wrongBytes++; break; }
      const crc = run(PARTS, { d: e.data }, 'return crc32(d);');
      if (crc !== e.crc) wrongCrc++;
    }
  }
  check('the zip is a valid archive read by anything but its own reader',
    !err && entries.length === FILES.length && wrongCrc === 0 && wrongBytes === 0,
    err ? err : entries.length + ' of ' + FILES.length + ' entries recovered, ' + wrongCrc +
    ' with a wrong CRC, ' + wrongBytes + ' with wrong bytes (' + zip.length + ' bytes total)');
}

// And its own reader must agree — that is the path `importDesignZip` takes to get a design back.
{
  const r = run(PARTS, { zip, FILES }, `
    const back = unzipStore(zip);
    const names = Object.keys(back);
    let missing = 0, wrong = 0;
    for (const f of FILES) {
      const want = f.text != null ? strBytes(f.text) : Uint8Array.from(f.bytes);
      const got = back[f.name];
      if (!got) { missing++; continue; }
      if (got.length !== want.length) { wrong++; continue; }
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { wrong++; break; }
    }
    return { n: names.length, missing, wrong };`);
  check('unzipStore reads back everything makeZip wrote',
    r.n === FILES.length && r.missing === 0 && r.wrong === 0,
    r.n + ' entries, ' + r.missing + ' missing, ' + r.wrong + ' corrupted');
}

// A zip made by any other tool is DEFLATEd, and this reader only stores. It has to say so by handing back
// null rather than the compressed bytes, or a design re-import would parse compressed data as JSON.
{
  const r = run(PARTS, { zip }, `
    const fake = zip.slice();
    new DataView(fake.buffer).setUint16(8, 8, true);          // claim DEFLATE on the first entry
    const back = unzipStore(fake);
    const first = Object.keys(back)[0];
    return { first, value: back[first] };`);
  check('a compressed entry is reported as unreadable, not as bytes', r.value === null,
    'entry "' + r.first + '" came back as ' + (r.value === null ? 'null' : typeof r.value));
}

// ---------------------------------------------------------------- base64 and the design layers

// The encoder walks the buffer in 0x8000-byte chunks because `String.fromCharCode.apply` blows the stack on
// a whole 128² Float32 layer at once. So the boundary itself is what needs exercising: a buffer several
// chunks long, containing every byte value, has to come back identical.
{
  const r = run(PARTS, {}, `
    const sizes = [0, 1, 255, 0x8000 - 1, 0x8000, 0x8000 + 1, 100000];
    const bad = [];
    for (const n of sizes) {
      const src = new Uint8Array(n); for (let i = 0; i < n; i++) src[i] = (i * 31 + (i >> 8)) & 255;
      const back = b64ToU8(abToB64(src.buffer));
      if (back.length !== n) { bad.push(n + ' (length ' + back.length + ')'); continue; }
      for (let i = 0; i < n; i++) if (back[i] !== src[i]) { bad.push(n + ' (byte ' + i + ')'); break; }
    }
    return { bad, sizes };`);
  check('base64 round-trips across its own chunk boundary', r.bad.length === 0,
    r.sizes.length + ' sizes up to 100 kB, including ' + (0x8000) + ' either side; failures: ' + (r.bad.join(', ') || 'none'));
}

// design.json carries the five editable layers, and re-importing one has to give back the design that was
// exported — same classes painted, same elevations, same channels. Float32 is the risk: a layer decoded
// with a wrong offset or element type reads as plausible garbage rather than as an error.
{
  const G = 128;
  const r = run(PARTS, { G }, `
    const target = new Uint8Array(G * G), elev = new Float32Array(G * G), elevPainted = new Uint8Array(G * G);
    const rough = new Float32Array(G * G), water = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) {
      target[i] = i % 11;
      elev[i] = (i % 1000) / 1000;                            // includes 0 and values with no exact float32 form
      elevPainted[i] = i % 3 === 0 ? 1 : 0;
      rough[i] = i % 7 === 0 ? 0.16 : 0;
      water[i] = i % 97 === 0 ? 1 : 0;
    }
    const json = JSON.stringify({ v: 1, G: G, target: abToB64(target.buffer), elev: abToB64(elev.buffer),
      elevPainted: abToB64(elevPainted.buffer), rough: abToB64(rough.buffer), water: abToB64(water.buffer) });
    const zip = makeZip([{ name: 'design.json', data: strBytes(json) }]);
    const d = JSON.parse(new TextDecoder().decode(unzipStore(zip)['design.json']));
    const src = { target, elev, elevPainted, rough, water };
    const bad = [];
    // The re-import decodes each layer back into its own typed array, and a mangled encoding shows up
    // there as a throw rather than as wrong numbers — so report it as a failure instead of dying on it.
    let back;
    try {
      back = { target: b64ToU8(d.target), elev: new Float32Array(b64ToU8(d.elev).buffer),
        elevPainted: b64ToU8(d.elevPainted), rough: new Float32Array(b64ToU8(d.rough).buffer), water: b64ToU8(d.water) };
    } catch (e) { return { bad: ['the layers would not decode: ' + e.message], g: d.G }; }
    for (const k of Object.keys(src)) {
      if (back[k].length !== src[k].length) { bad.push(k + ' length ' + back[k].length + ' != ' + src[k].length); continue; }
      for (let i = 0; i < src[k].length; i++) if (back[k][i] !== src[k][i]) { bad.push(k + ' at ' + i); break; }
    }
    return { bad, g: d.G };`);
  check('a design survives the trip out to a bundle and back', r.bad.length === 0 && r.g === G,
    r.bad.length ? r.bad.join('; ') : 'all five layers of a ' + G + '² design identical after the round trip');
}

// The bundle reports the world size by hunting `WorldWidth` through the parsed config, at whatever depth it
// sits. It is what the service sizes the world by, and the fallback when it finds nothing is 72 — so a
// search that quietly missed a nested key would generate every world at the wrong size.
{
  const r = run(PARTS, {}, `
    return {
      nested: findWorldWidth({ Generators: [{ Params: { WorldWidth: 144, Other: 1 } }] }),
      top: findWorldWidth({ WorldWidth: 96 }),
      absent: findWorldWidth({ a: { b: [1, 2, 3] }, c: 'WorldWidth' }),
      shallowFirst: findWorldWidth({ WorldWidth: 12, deep: { WorldWidth: 200 } }),
      empty: findWorldWidth({}),
      nul: findWorldWidth(null),
    };`);
  check('the world size is found wherever the config keeps it',
    r.nested === 144 && r.top === 96 && r.absent === null && r.shallowFirst === 12 && r.empty === null && r.nul === null,
    'nested ' + r.nested + ', top-level ' + r.top + ', absent ' + r.absent + ', null config ' + r.nul);
}

done();

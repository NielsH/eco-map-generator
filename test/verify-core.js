// Verifies the ported .NET Random + SharpNoise against ground-truth samples captured from Eco's own
// assemblies (SharpNoise.dll) and .NET's seeded Random. Run: node test/verify-core.js
const fs = require('fs');
const path = require('path');
const { CsRandom, Perlin, RidgedMulti, gradientCoherentNoise3D, setVectorTable, NQ } = require('../src/core.js');

setVectorTable(fs.readFileSync(path.join(__dirname, '../src/vectortable.txt'), 'utf8').trim().split(',').map(Number));
let fails = 0;
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * (1 + Math.abs(b));

// ---- .NET Random(seed) reference sequences (legacy compat PRNG, identical in .NET Framework and .NET 8) ----
const randRef = {
  1990891640: { int:[579308129,1283620533,1009835223,1455617289,180993654,209513129], rng:[26,59,47,67,8,9] },
  42: { int:[1434747710,302596119,269548474,1122627734,361709742,563913476], rng:[66,14,12,52,16,26] },
  0: { int:[1559595546,1755192844,1649316166,1198642031,442452829,1200195957], rng:[72,81,76,55,20,55] },
  '-5': { int:[726643700,610783965,564707973,1342984399,995276750,1993667614], rng:[33,28,26,62,46,92] },
};
for (const seed of Object.keys(randRef)) {
  const s = Number(seed);
  let r = new CsRandom(s); randRef[seed].int.forEach((v, i) => { const g = r.next(); if (g !== v) { fails++; console.log(`RANDINT ${seed}[${i}] ${g} != ${v}`); } });
  r = new CsRandom(s); randRef[seed].rng.forEach((v, i) => { const g = r.next(0, 100); if (g !== v) { fails++; console.log(`RANDRNG ${seed}[${i}] ${g} != ${v}`); } });
}

// ---- SharpNoise reference samples (captured from SharpNoise.dll via reflection) ----
let noiseChecks = 0;
for (const line of fs.readFileSync(path.join(__dirname, 'noise_ref.tsv'), 'utf8').trim().split(/\r?\n/)) {
  const f = line.split('\t');
  if (f[0] === 'GCN') {
    const [, q, seed, x, y, z, val] = f;
    const g = gradientCoherentNoise3D(+x, +y, +z, +seed, q === 'Best' ? NQ.Best : NQ.Standard);
    noiseChecks++; if (!approx(g, +val)) { fails++; console.log(`GCN ${q} ${seed} (${x},${y},${z}) ${g} != ${val}`); }
  } else if (f[0].startsWith('PERLIN') || f[0].startsWith('RIDGED')) {
    const [label, x, y, z, val] = f;
    const mod = label === 'PERLIN_BEST_f0.5_s7' ? new Perlin({ Seed:7, Frequency:0.5, Quality:NQ.Best })
      : label === 'PERLIN_STD_f10_s3' ? new Perlin({ Seed:3, Frequency:10.0 })
      : label === 'RIDGED_f6_s5' ? new RidgedMulti({ Seed:5, Frequency:6.0 }) : null;
    if (!mod) continue;
    const g = mod.getValue(+x, +y, +z);
    noiseChecks++; if (!approx(g, +val)) { fails++; console.log(`${label} (${x},${y},${z}) ${g} != ${val}`); }
  }
}

console.log(`Random + ${noiseChecks} noise checks`);
console.log(fails === 0 ? 'ALL PASS ✓' : `${fails} FAILURES ✗`);
process.exit(fails === 0 ? 0 : 1);

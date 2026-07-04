// Verified numeric core: .NET legacy Random + SharpNoise (libnoise) port.
// VECTORTABLE is injected by the test harness / final HTML.

// ---- .NET Framework legacy Random(seed) ----
class CsRandom {
  constructor(seed) {
    const MBIG = 2147483647, MSEED = 161803398;
    this.MBIG = MBIG;
    const sa = new Array(56).fill(0);
    let subtraction = (seed === -2147483648) ? 2147483647 : Math.abs(seed);
    let mj = MSEED - subtraction;
    sa[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      sa[ii] = mk;
      mk = (mj - mk) | 0;            // .NET int subtraction wraps at 32 bits
      if (mk < 0) mk += MBIG;
      mj = sa[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        sa[i] = (sa[i] - sa[1 + (i + 30) % 55]) | 0;   // 32-bit wrap, matches int overflow
        if (sa[i] < 0) sa[i] += MBIG;
      }
    }
    this.SeedArray = sa;
    this.inext = 0;
    this.inextp = 21;
  }
  _internalSample() {
    let locINext = this.inext, locINextp = this.inextp;
    if (++locINext >= 56) locINext = 1;
    if (++locINextp >= 56) locINextp = 1;
    let retVal = this.SeedArray[locINext] - this.SeedArray[locINextp];
    if (retVal === this.MBIG) retVal--;
    if (retVal < 0) retVal += this.MBIG;
    this.SeedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal;
  }
  _sample() { return this._internalSample() * (1.0 / this.MBIG); }
  next(a, b) {
    if (a === undefined) return this._internalSample();
    if (b === undefined) return Math.trunc(this._sample() * a);
    const range = b - a;
    return Math.trunc(this._sample() * range) + a;
  }
  nextDouble() { return this._sample(); }
}

// ---- SharpNoise / libnoise ----
const NQ = { Fast: 0, Standard: 1, Best: 2 };
let VECTORTABLE = null;
function setVectorTable(t) { VECTORTABLE = t; }

function makeInt32Range(n) {
  if (n >= 1073741824.0) return (2.0 * (n % 1073741824.0)) - 1073741824.0;
  if (n <= -1073741824.0) return (2.0 * (n % 1073741824.0)) + 1073741824.0;
  return n;
}
const sCurve3 = a => a * a * (3.0 - 2.0 * a);
const sCurve5 = a => a * a * a * (a * (a * 6.0 - 15.0) + 10.0);
const lerpN = (n0, n1, a) => ((1.0 - a) * n0) + (a * n1);
const floorI = x => (x > 0 ? Math.trunc(x) : Math.trunc(x) - 1);

function gradientNoise3D(fx, fy, fz, ix, iy, iz, seed) {
  let vi = (Math.imul(1619, ix) + Math.imul(31337, iy) + Math.imul(6971, iz) + Math.imul(1013, seed)) | 0;
  vi = (vi ^ (vi >> 8)) & 0xff;
  const idx = vi << 2;
  const xg = VECTORTABLE[idx], yg = VECTORTABLE[idx + 1], zg = VECTORTABLE[idx + 2];
  return ((xg * (fx - ix)) + (yg * (fy - iy)) + (zg * (fz - iz))) * 2.12;
}

function gradientCoherentNoise3D(x, y, z, seed, quality) {
  const x0 = floorI(x), y0 = floorI(y), z0 = floorI(z);
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  let xs, ys, zs;
  if (quality === NQ.Fast) { xs = x - x0; ys = y - y0; zs = z - z0; }
  else if (quality === NQ.Standard) { xs = sCurve3(x - x0); ys = sCurve3(y - y0); zs = sCurve3(z - z0); }
  else { xs = sCurve5(x - x0); ys = sCurve5(y - y0); zs = sCurve5(z - z0); }
  let n0, n1, ix0, ix1, iy0, iy1;
  n0 = gradientNoise3D(x, y, z, x0, y0, z0, seed);
  n1 = gradientNoise3D(x, y, z, x1, y0, z0, seed);
  ix0 = lerpN(n0, n1, xs);
  n0 = gradientNoise3D(x, y, z, x0, y1, z0, seed);
  n1 = gradientNoise3D(x, y, z, x1, y1, z0, seed);
  ix1 = lerpN(n0, n1, xs);
  iy0 = lerpN(ix0, ix1, ys);
  n0 = gradientNoise3D(x, y, z, x0, y0, z1, seed);
  n1 = gradientNoise3D(x, y, z, x1, y0, z1, seed);
  ix0 = lerpN(n0, n1, xs);
  n0 = gradientNoise3D(x, y, z, x0, y1, z1, seed);
  n1 = gradientNoise3D(x, y, z, x1, y1, z1, seed);
  ix1 = lerpN(n0, n1, xs);
  iy1 = lerpN(ix0, ix1, ys);
  return lerpN(iy0, iy1, zs);
}

class Perlin {
  constructor(o = {}) {
    this.Frequency = o.Frequency ?? 1.0;
    this.Lacunarity = o.Lacunarity ?? 2.0;
    this.OctaveCount = o.OctaveCount ?? 6;
    this.Persistence = o.Persistence ?? 0.5;
    this.Quality = o.Quality ?? NQ.Standard;
    this.Seed = o.Seed ?? 0;
  }
  getValue(x, y, z) {
    let value = 0.0, curPersistence = 1.0;
    x *= this.Frequency; y *= this.Frequency; z *= this.Frequency;
    for (let o = 0; o < this.OctaveCount; o++) {
      const nx = makeInt32Range(x), ny = makeInt32Range(y), nz = makeInt32Range(z);
      const seed = (this.Seed + o) | 0;
      const signal = gradientCoherentNoise3D(nx, ny, nz, seed, this.Quality);
      value += signal * curPersistence;
      x *= this.Lacunarity; y *= this.Lacunarity; z *= this.Lacunarity;
      curPersistence *= this.Persistence;
    }
    return value;
  }
}

class RidgedMulti {
  constructor(o = {}) {
    this.Frequency = o.Frequency ?? 1.0;
    this.Lacunarity = o.Lacunarity ?? 2.0;
    this.OctaveCount = o.OctaveCount ?? 6;
    this.Quality = o.Quality ?? NQ.Standard;
    this.Seed = o.Seed ?? 0;
    this.SpectralWeights = [];
    let freq = 1.0;
    for (let i = 0; i < 30; i++) { this.SpectralWeights[i] = Math.pow(freq, -1.0); freq *= this.Lacunarity; }
  }
  getValue(x, y, z) {
    x *= this.Frequency; y *= this.Frequency; z *= this.Frequency;
    let value = 0.0, weight = 1.0;
    const offset = 1.0, gain = 2.0;
    for (let o = 0; o < this.OctaveCount; o++) {
      const nx = makeInt32Range(x), ny = makeInt32Range(y), nz = makeInt32Range(z);
      const seed = (this.Seed + o) & 0x7fffffff;
      let signal = gradientCoherentNoise3D(nx, ny, nz, seed, this.Quality);
      signal = Math.abs(signal);
      signal = offset - signal;
      signal *= signal;
      signal *= weight;
      weight = signal * gain;
      if (weight > 1.0) weight = 1.0; else if (weight < 0.0) weight = 0.0;
      value += signal * this.SpectralWeights[o];
      x *= this.Lacunarity; y *= this.Lacunarity; z *= this.Lacunarity;
    }
    return (value * 1.25) - 1.0;
  }
}

class ScaleBias {
  constructor(o = {}) { this.Source0 = o.Source0; this.Scale = o.Scale ?? 1.0; this.Bias = o.Bias ?? 0.0; }
  getValue(x, y, z) { return this.Source0.getValue(x, y, z) * this.Scale + this.Bias; }
}

if (typeof module !== 'undefined') module.exports = { CsRandom, Perlin, RidgedMulti, ScaleBias, gradientCoherentNoise3D, setVectorTable, NQ };

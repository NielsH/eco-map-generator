// Port of the rasterization step in Eco.WorldGenerator.VoronoiWorldGenerator
// (RenderTerrainMap / RenderMaps): turns the surface polygons into the per-voxel
// grids the underground generator reads — Biome.BiomeData and the (blurred) HeightMap.
//
// The server fills each Voronoi polygon into a WorldSize x WorldSize bitmap with the
// biome's Color (SteelBlue for lakes) and a grayscale HeightmapColor, tiling across the
// wrap borders, then reads pixels back. We reproduce that with a deterministic scanline
// fill (no canvas, so this stays Node-requirable and testable like the other src files).
//
// Fidelity notes:
// - Only 13 biomes are registered in BiomeLookupFromColor. Steppe shares Grassland's
//   color, HighDesert shares Desert's, Coast shares WarmCoast's — so the round-trip
//   through color collapses them. collapseBiome() reproduces that exactly.
// - HeightmapColor = (byte)(255 * (Elevation*.5 + .5))  [BiomePolygon.cs].
// - Heightmap blur = 2 passes of a radius-4 edge-aware box blur  [VoronoiWorldGenerator.cs].
// - Not yet modeled here (thin features, added in a later pass): river/lake carving into
//   the water-elevation map. Base land shape and biomes are faithful.

// The biomes the server keeps in BiomeLookupFromColor, in a stable id order.
const RASTER_BIOMES = ['DeepOcean', 'Ocean', 'Grassland', 'ColdCoast', 'WarmCoast',
  'WarmForest', 'ColdForest', 'RainForest', 'Desert', 'Tundra', 'Taiga', 'Ice', 'Wetland'];
const RB_ID = {}; RASTER_BIOMES.forEach((n, i) => { RB_ID[n] = i; });

// Collapse a surface biome (+lake flag) to the registered biome its rasterized color maps to.
function collapseBiome(name, hasLake) {
  if (hasLake) return 'DeepOcean';      // lakes are filled SteelBlue == DeepOcean's color
  switch (name) {
    case 'Steppe':     return 'Grassland';   // LightGreen
    case 'HighDesert': return 'Desert';      // SandyBrown
    case 'Coast':      return 'WarmCoast';   // LightGoldenrodYellow (Coast unregistered)
    default:           return name;
  }
}

// Even-odd scanline fill of one polygon into a W x W grid, writing modulo W so the
// world wraps seamlessly (equivalent to the server's 9 offset FillPolygon draws).
// `set(idx)` writes the pixel at flat index idx. Samples pixel centers at (x+.5, y+.5).
function fillPolygon(pts, W, set) {
  const n = pts.length;
  if (n < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const y = pts[i].y; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const yStart = Math.ceil(minY - 0.5), yEnd = Math.floor(maxY - 0.5);
  const xs = [];
  for (let yi = yStart; yi <= yEnd; yi++) {
    const sy = yi + 0.5;
    xs.length = 0;
    // gather edge crossings at scanline sy
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi0 = pts[j].y, yi1 = pts[i].y;
      if ((yi0 <= sy && yi1 > sy) || (yi1 <= sy && yi0 > sy)) {
        const t = (sy - yi0) / (yi1 - yi0);
        xs.push(pts[j].x + t * (pts[i].x - pts[j].x));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const wy = ((yi % W) + W) % W;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xStart = Math.ceil(xs[k] - 0.5), xEnd = Math.floor(xs[k + 1] - 0.5);
      for (let xi = xStart; xi <= xEnd; xi++) {
        const wx = ((xi % W) + W) % W;
        set(wy * W + wx);
      }
    }
  }
}

// Push polygon points 1px outward from the center (the server's fudgeFactor) so
// adjacent cell fills overlap and leave no uncovered seam pixels on the biome map.
function fudged(points, cx, cy) {
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - cx, dy = points[i].y - cy;
    const len = Math.hypot(dx, dy) || 1;
    out[i] = { x: points[i].x + dx / len, y: points[i].y + dy / len };
  }
  return out;
}

// 2-pass radius-4 edge-aware box blur of the grayscale heightmap (matches the server:
// only average in a neighbor if it's within `threshold` of, or lower than, the source).
function blurHeightmap(gray, W) {
  const radius = 4, sqRadius = radius * radius, threshold = 5;
  let src = gray, dst = new Uint8Array(W * W);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const source = src[y * W + x];
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const py = ((y + dy) % W + W) % W;
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy >= sqRadius) continue;
            const px = ((x + dx) % W + W) % W;
            const c = src[py * W + px];
            if (Math.abs(source - c) <= threshold || source >= c) { sum += c; count++; }
          }
        }
        dst[y * W + x] = Math.round(sum / count);
      }
    }
    const t = src; src = dst; dst = (pass === 0) ? new Uint8Array(W * W) : t;
    for (let i = 0; i < W * W; i++) dst[i] = 0;
  }
  return src;
}

// Rasterize surface polygons into per-voxel grids.
//   polys: worldgen output polygons (each has points[{x,y}], center{x,y}, biome{name}, elevation, hasLake)
//   returns { W, biome:Uint8Array, gray:Uint8Array, biomeNames:RASTER_BIOMES }
//     biome[i] = index into RASTER_BIOMES (collapsed);  gray[i] = blurred heightmap byte (0..255)
function rasterize(polys, worldSize, opts = {}) {
  const W = worldSize;
  const biome = new Uint8Array(W * W);   // defaults to 0 == DeepOcean (server clears biome map to ocean/black)
  const gray = new Uint8Array(W * W);    // defaults to 0 == black, as the server clears the heightmap
  const progress = opts.progress || (() => {});

  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi];
    const id = RB_ID[collapseBiome(p.biome.name, p.hasLake)];
    const bpts = fudged(p.points, p.center.x, p.center.y);
    fillPolygon(bpts, W, idx => { biome[idx] = id; });
    // heightmap uses the raw (un-fudged) polygon points and the grayscale elevation color
    const g = (255 * (p.elevation * 0.5 + 0.5)) | 0;   // (byte) cast truncates
    const gc = g < 0 ? 0 : g > 255 ? 255 : g;
    fillPolygon(p.points, W, idx => { gray[idx] = gc; });
    if ((pi & 1023) === 0) progress('raster', pi / polys.length);
  }
  progress('blur', 0);
  const blurred = blurHeightmap(gray, W);
  return { W, biome, gray: blurred, biomeNames: RASTER_BIOMES };
}

if (typeof module !== 'undefined') module.exports = { rasterize, collapseBiome, RASTER_BIOMES, RB_ID, blurHeightmap, fillPolygon };

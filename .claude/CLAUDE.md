# CLAUDE.md — eco-map-generator

Developer memory for this repo. Read this before making changes.

## What this is

A single self-contained page that previews an Eco `WorldGenerator.eco` config the way the game server
would generate it — the surface map (biomes/elevation/climate/rivers/lakes) and the block/ore
composition — and lets you edit every knob and regenerate live. It is a faithful **JavaScript port of
`Eco.WorldGenerator.VoronoiWorldGenerator`** (server, .NET 8). Published via GitHub Pages.

Unlike the sibling [eco-biome-visualizer](https://github.com/NielsH/eco-biome-visualizer) (one hand-written
`index.html`, no build), this repo has a small **build step**: `index.html` is generated from `src/`.

## Files

- `index.html` — **generated artifact**. Do NOT hand-edit; your changes will be overwritten by `build.js`.
- `src/core.js` — `.NET` legacy `Random(seed)` + SharpNoise (Perlin/RidgedMulti/ScaleBias/gradient noise). Runs in the worker.
- `src/geo.js` — `PoissonDiscSampler` (Bridson) + Fortune's-algorithm `Voronoi`.
- `src/worldgen.js` — port of `VoronoiWorldGenerator.Generate`: biome placement, elevation/temp/moisture, lakes, rivers, smoothing. Also the `.NET` `IntrospectiveSort` (`netSort`) used for tie-breaks.
- `src/vectortable.txt` — SharpNoise's 1024-entry gradient vector table, extracted from `SharpNoise.dll`.
- `src/raster.js` — surface polygons → per-voxel biome + (blurred) heightmap grids (`rasterize`). Node-requirable.
- `src/voxel.js` — per-voxel underground block generation (base strata + scatter + global ore-vein pass). Runs in the worker.
- `src/render3d.js` — main-thread 3D voxel renderer (three.js). Injected raw via a `/*__RENDER3D__*/` placeholder.
- `src/search.js` — **inverse-design search core**: an 11-class "score space", a biome-similarity distance matrix, a coarse polygon→G×G class-grid rasterizer, and a wrap-invariant similarity `scoreGrids`. Node-requirable; bundled into the worker **and** inlined on the main thread (`/*__SEARCH__*/`).
- `src/designer.js` — the **"Design a map"** feature (main thread; injected raw via `/*__DESIGNER__*/`). Painter, analytic config inversion, an 8-way Web Worker search pool, ranked results gallery, apply-to-config.
- `build.js` — inlines `src/*` + vectortable + `WorldGenerator.eco` into `index.html` (this file also contains all the main-thread UI as a big template literal: config form, biome-mix editor, ore editor, ore chart, canvas rendering).
- `WorldGenerator.eco` — Eco's default world (Small preset). Embedded into `index.html` as the on-load example.
- `test/verify-core.js` + `test/noise_ref.tsv` — bit-exactness check of Random + noise against captured ground truth.

## Build / verify / run

```
node build.js             # regenerate index.html from src/ + WorldGenerator.eco
node test/verify-core.js  # Random + 66 noise checks vs references captured from the game DLLs
```

- `src/core.js`, `src/geo.js`, `src/worldgen.js` are Node-requirable (they have `module.exports` guards that
  `build.js` strips for the browser). So you can unit-test them directly in Node.
- After editing, also syntax-check the generated script body: extract the last `<script>` from `index.html`
  and `node --check` it (catches template-literal escaping bugs in `build.js` — see gotchas).
- **Runs from `file://`** because the vector table AND the default config are embedded — no `fetch`. The map
  is generated in a Blob Web Worker built from the inlined library.

## Architecture

Worker (generation, in `src/`): `generate(cfg)` →
1. `poissonSamples()` places seeds; world tiled 3×3 for wrap.
2. `Voronoi.generateVoronoi()` → polygons + adjacency.
3. biome placement: land starts Grassland; `generateBiome()` floods each biome by weight, carving nested
   biomes out of their parent (ColdForest→Taiga→Tundra→Ice; Desert→HighDesert; WarmForest→Wetland).
4. elevation/temperature/moisture from per-biome ranges × seamless noise; then lakes, rivers, valley smoothing.

Main thread (UI, in `build.js`'s template): parse config → fill the form + biome-mix + ore editor →
post cfg to the worker → render returned polygons to canvas. `buildExportJson()` merges the form + the
dereferenced `terrain` (TerrainModule) back into the loaded JSON for **Download .eco** and to feed the
live `OreChart`.

## Fidelity — what's exact and what isn't

Exact (verified against the assemblies): **`.NET Random(seed)`** (legacy compat PRNG — identical in .NET
Framework and .NET 8) and **SharpNoise** gradient-coherent noise, Perlin, RidgedMulti (with the real vector
table + hash constants X/Y/Z/Seed/Shift NoiseGen and quality S-curves).

Faithful ports (match the algorithm; not independently byte-verified against a server render):

- Poisson (reproduces the C# `(int)NextDouble()*count` bug that still consumes a draw), Fortune's Voronoi,
  the whole `Generate` sequence, rivers/lakes.
- **`.NET IntrospectiveSort`** (`netSort` in `worldgen.js`) for the two `BalanceBiome` `fillPolygons.Sort`
  calls — the terraced priorities have only 4 levels so ties are everywhere, and the server's *unstable*
  introsort decides them. A stable sort visibly diverges; do not "simplify" `netSort`.
- **Single-precision (`Math.fround`) geometry** — Eco uses `float`/`PointF` for Poisson positions, polygon
  points/centers, priorities, and elevation/temp/moisture. Double vs float tips terraced values into
  different bands and shifts Poisson sample count, so this cascades. Keep the `f()` calls.
- **seed `0` → random** (`parseConfig`): Eco randomizes when the config seed is 0. The default world has seed 0.
- The map is displayed **flipped vertically** to match the in-game `TerrainEditorPanel` (`RotateNoneFlipY`).

Not modeled: the surface generator does not consume `TerrainModule`; the ore chart is a separate density
**model** of its effect (relative index, not blocks-per-chunk — see the biome-visualizer README for the
model's honesty caveats). Underground editing changes the ore chart + the exported `.eco`, not the surface map.

## The ore editor + chart

- On load, `derefTerrain()` resolves the `TerrainModule`'s `$id`/`$ref` graph into a plain editable tree
  (keeps `$type`, drops `$id`/`$ref`) stored in the global `terrain`. Export writes it back as plain JSON
  (no cycles, so it deserializes fine without the reference ids).
- The **Manual knobs** editor exposes material-bearing **veins** (`DepositTerrainModule`) and **scatter**
  (`StandardTerrainModule`) with slider+number knobs; add/remove per biome. `oreOpen` preserves which
  `<details>` are expanded across rebuilds.
- The **Visual editor** (`OreVisual` IIFE in `build.js`) draws the whole underground for one biome as a single
  100%-stacked column and lets you drag blocks to edit them. It builds a per-**depth** composition (veins
  overwrite first-wins, then each stratum's rock is carved by its scatters — the same model as `BlockChart`),
  then **projects it onto real world height**: it ports `BlockChart.projectToY`, averaging the depth
  composition over the biome's surface band (`surfOf` via the `ELEV` map + water level) so the surface sits at
  its true Y with air above and a soft taper through the band. The column is centred and tiles exactly
  (`fracY`/`cumY`/`xOf`), so it's gap-free. Editing stays depth-based: pointer-Y maps back to depth through the
  surface **midpoint** (`depthAtSvgY`), so drags past the midpoint can fall off-screen — use the detail-panel
  number inputs for those. Vertical scale is `SCe = 1000 / max(60, MaxGenerationHeight)` (taller worlds scale up).
- Two charts render from the live `buildExportJson()`: **`BlockChart`** (the 100%-stacked block-composition
  chart the Visual editor is designed to match) and **`OreChart`**, ported from the eco-biome-visualizer
  (`extract`/`depthProfile`/`smearY`/`render`). The hand-off button posts the config to the standalone
  visualizer (`eco-oreviz-ready` → `eco-config` postMessage handshake).

## The "Design a map" inverse search (src/search.js + src/designer.js)

Draw a target biome layout → invert to a starting config → run a best-of-N seed search for a real,
playable world that resembles the drawing. **Why it's a search, not a solve:** the generator has NO
spatial-placement knob — where a biome lands is decided by the seed (biome flood fills a terraced-noise
priority field whose seed comes off the master RNG). So layout can only be matched by trying seeds and
scoring similarity. It matches the biome *mix* and *macro land-shape* well; exact placement is best-effort.

- **Score space (`search.js`)**: 11 painter-friendly classes (Ocean, Coast, Grassland, WarmForest,
  ColdForest, RainForest, Desert, Taiga, Tundra, Ice, Wetland). Steppe→Grassland, HighDesert→Desert, all
  coasts→Coast, DeepOcean+Ocean→Ocean (matches what the user can actually control + what rasterizes distinctly).
- **Candidate signature**: `classGridAt(polys, worldSize, G)` fills polygons into an intermediate R×R grid
  then majority-downsamples to G×G (G=64). Runs on **worldgen polys** (has `.biome.name`, `.points`,
  `.center`) — NOT the serialized main-thread `result.polys` (those are `{name, pts}`), so it's only ever
  called inside the worker.
- **Similarity (`scoreGrids`)**: wrap-invariant — the world tiles toroidally, so it finds the best cyclic
  shift (coarse full scan at stride 4 + local refine) minimizing mean class-distance, then blends
  `prop` (biome-proportion TV distance), `soft` (partial-credit agreement via the distance matrix), and
  `iou` (land-mask overlap). `layoutWeight`∈[0,1] trades mix vs layout. Translation-only on purpose: the
  applied map is shown at a fixed orientation, so crediting rotations/reflections would show worlds that
  don't match the drawing's orientation. Self-score is 1.0 and a pure toroidal shift recovers to 1.0
  (see `scratchpad/test-search.js` methodology).
- **Fast path**: `generate(cfg, {biomesOnly:true})` returns right after biome placement (skips
  elevation/rivers/lakes) — ~1% grid difference vs full, big speedup. Search candidates use it; **apply**
  runs a normal full generate.
- **Inversion (`designer.analyze`)**: reuses the app's `sharesToWeights` (drawn biome shares → nested
  weights), sets `landPercentRange` from land fraction, and counts toroidal connected components for
  continents/islands and per-biome min blob counts. Starts from `readForm()` so world size / pointRadius /
  elevation knobs carry over.
- **Worker pool (`designer`)**: `min(8, cores-1)` workers, own message types (`search-init`/`search-eval`/
  `classgrid`) separate from generation + 3D so they never clash. Each candidate = inverted cfg + a random
  seed (optional ±6% knob jitter). Results re-scored on the main thread against the current `layoutWeight`
  so the leaderboard stays consistent and re-ranks instantly when the slider moves. Apply stores each
  candidate's exact cfg (`cfgBySeed`) so it reproduces the previewed map even with jitter, and does **not**
  overwrite `baseCfg` (so "Reset to loaded" still returns to the file).

## Gotchas (learned the hard way)

- **`build.js` is one big template literal.** Any backtick or `${` inside the emitted HTML/JS must be
  escaped (`\``, `\${`), including inside JS comments. An unescaped backtick silently truncates the whole
  string and the build fails with a confusing syntax error. New editor JS uses single-quote concatenation to
  avoid this.
- **Don't cap the knob sliders.** Each knob is a slider + an editable number; the number has no `max` so it
  accepts any value and grows the slider's range. Don't add a `max` attribute to the number input.
- **Performance is ~O(cells)**; cells ≈ (WorldWidth·10)² / poisson-density. Small (72) ≈ 3k cells (~seconds);
  Large (160) ≈ 16k cells (~15s). It runs in a worker with a progress bar; don't move it back to the main thread.
- **Main-thread state is lexical, not on `window`.** `result`, `baseCfg`, `cfgUsed`, `terrain` etc. are
  top-level `let`/`const` in the main `<script>`, so they're NOT properties of `window` (`window.result`
  is `undefined`). Injected raw scripts (`render3d.js`, `designer.js`) run as separate `<script>`s and
  reach them via the *shared global lexical scope* — reference them by bare name (`result`, not
  `window.result`), and assign by bare name to actually mutate them (`baseCfg = cfg`).
- **Injected raw vs escaped.** Big new UI blocks live in their own `src/*.js` injected via a
  `/*__NAME__*/` placeholder replacer (see `render3d.js`/`designer.js`) so their backticks/`${}` pass
  through verbatim — far less error-prone than escaping inside `build.js`'s template literal.
- **LF line endings.** Keep them.

## Regenerating the captured references (rare)

`src/vectortable.txt` and `test/noise_ref.tsv` were captured from `SharpNoise.dll` (NuGet
`sharpnoise 0.12.1.1`) via PowerShell reflection, and the `Random` sequences from .NET. You only need to
redo this if SharpNoise's version changes in the Eco server. The originals were produced against the Eco
repo's pinned SharpNoise.

## Workflow

- Branch off `main`, commit, push, open a PR. **Do not merge** — the owner (NielsH) reviews and merges.
- After any change to `src/` or `WorldGenerator.eco`, run `node build.js` and commit the regenerated
  `index.html` in the same commit.
- End commit messages with the `Co-Authored-By: Claude` trailer.

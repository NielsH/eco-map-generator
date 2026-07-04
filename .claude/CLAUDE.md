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
- The focused editor exposes material-bearing **veins** (`DepositTerrainModule`) and **scatter**
  (`StandardTerrainModule`) with slider+number knobs; add/remove per biome. `oreOpen` preserves which
  `<details>` are expanded across rebuilds.
- `OreChart` is ported from the eco-biome-visualizer (`extract`/`depthProfile`/`smearY`/`render`). It runs on
  the live `buildExportJson()`. The hand-off button posts that config to the standalone visualizer
  (`eco-oreviz-ready` → `eco-config` postMessage handshake).

## Gotchas (learned the hard way)

- **`build.js` is one big template literal.** Any backtick or `${` inside the emitted HTML/JS must be
  escaped (`\``, `\${`), including inside JS comments. An unescaped backtick silently truncates the whole
  string and the build fails with a confusing syntax error. New editor JS uses single-quote concatenation to
  avoid this.
- **Don't cap the knob sliders.** Each knob is a slider + an editable number; the number has no `max` so it
  accepts any value and grows the slider's range. Don't add a `max` attribute to the number input.
- **Performance is ~O(cells)**; cells ≈ (WorldWidth·10)² / poisson-density. Small (72) ≈ 3k cells (~seconds);
  Large (160) ≈ 16k cells (~15s). It runs in a worker with a progress bar; don't move it back to the main thread.
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

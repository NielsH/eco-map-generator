# Eco WorldGen map generator

A single-page, zero-dependency tool that previews an [Eco](https://play.eco) `WorldGenerator.eco` config **the way the game's server would generate it** — the surface map (biomes, elevation, climate, rivers, lakes) plus the underground block/ore composition — and lets you **edit every knob and regenerate live**. Everything runs client-side in your browser; nothing is uploaded anywhere.

**Live:** https://nielsh.github.io/eco-map-generator/

A default Eco world is generated on load. Drop, upload, or paste your own `WorldGenerator.eco` to replace it, or just start turning knobs.

## What it does

- **Surface map preview** — biomes, elevation, temperature, moisture, rivers & lakes, rendered top-down (in the in-game editor's orientation). Hover any cell for its biome and elevation/temperature/moisture.
- **Editable config** — a full form for every generation parameter: world size, land/ocean, continents & islands, lakes & rivers, elevation curve, seed (with a 🎲 randomize button).
- **Biome mix editor** — a *Simple* mode where you set each biome's **share of land** (with a live budget bar and a Grassland "leftover" that can't be over-allocated), and an *Advanced* mode with the raw Voronoi weights. After a generate it shows **intended vs. actual** per biome.
- **Block & ore composition editor** — per biome, edit the base-rock strata, ore **veins** (deposits) and **scatter** blocks. Two ways to work: a **Visual editor** that draws the whole underground as one 100%-stacked column at real **world height** (surface at its true Y, air above) — drag a block to move it, its top/bottom edges to resize its depth, its inner edge to change abundance, or a rock boundary to move where a layer ends; and a **Manual knobs** mode with sliders for every value (block type, spawn chance, depth, vein size, noise frequency). Add/remove any block per biome.
- **Live composition charts** — a **Block composition** chart (100%-stacked block mix by biome and world height) and an **Ore distribution** violin chart of where each material concentrates, both updating as you edit — plus an **Open in ore visualizer** hand-off to the standalone [eco-biome-visualizer](https://github.com/NielsH/eco-biome-visualizer).
- **Export** — **Download .eco** writes your edits back into a valid `WorldGenerator.eco` (preserving everything you didn't touch), and **Export PNG** saves the current map layer.

## How faithful is it?

This is an actual port of the server's `Eco.WorldGenerator.VoronoiWorldGenerator`, not an approximation:

- The seeded **.NET `Random`** and **SharpNoise** (Perlin / RidgedMulti / gradient-coherent noise, including the exact 1024-entry gradient table) are **verified bit-exact** against the game's assemblies. See [`test/verify-core.js`](test/verify-core.js).
- The Poisson sampler, Fortune's-algorithm **Voronoi**, biome placement, elevation, rivers and lakes follow the server algorithm — including .NET's **introspective-sort** tie-breaking, single-precision (`float`) geometry, and Eco treating **seed `0` as "random"**.

**Caveat:** it targets seed-for-seed parity with the in-game generator but has not been byte-verified against a live server render. The macro layout, biome mix, elevation and climate are faithful; treat exact per-cell output for a given seed as "very close," not guaranteed.

## How it works

The world is generated in a **Web Worker** (so the UI stays responsive) from a faithful JS port of the server pipeline:

1. **Poisson-disc sampling** places cell seed points; the world is tiled 3×3 so it wraps seamlessly.
2. **Fortune's Voronoi** turns those into polygons with adjacency.
3. **Biome placement** floods the land (starting as Grassland) into biomes by their weights, carving nested biomes out of parents (Cold forest → Taiga → Tundra → Ice, etc.).
4. **Elevation / temperature / moisture** are assigned from per-biome ranges modulated by seamless noise; then **lakes** and **rivers** are carved and the terrain smoothed.

The polygons are sent back to the main thread and rendered to a canvas. The ore chart is computed separately from the config's `TerrainModule` (spawn rate × deposit size spread over an estimated vertical extent).

## Running locally

Everything — the noise gradient table **and** the default world config — is embedded in `index.html`, so it works straight from disk (`file://`); just open `index.html`. To serve it over HTTP instead:

```
python -m http.server
```

then open http://localhost:8000/.

## Development

`index.html` is **generated** — don't edit it by hand. The sources are:

```
src/core.js        .NET Random + SharpNoise port (runs in the worker)
src/geo.js         Poisson sampler + Fortune's-algorithm Voronoi
src/worldgen.js    VoronoiWorldGenerator.Generate port (biomes/elevation/rivers/lakes)
src/vectortable.txt  SharpNoise's 1024-entry gradient table (extracted from the DLL)
build.js           inlines src/* + vectortable + WorldGenerator.eco into index.html
WorldGenerator.eco default world, embedded as the on-load example
```

Edit the sources, then rebuild and verify:

```
node build.js               # regenerate index.html
node test/verify-core.js    # check Random + noise stay bit-exact vs the captured references
```

See [`.claude/CLAUDE.md`](.claude/CLAUDE.md) for a full developer guide (architecture, the exact fidelity notes, and gotchas).

## Data & credits

The world-generation algorithm and the default `WorldGenerator.eco` are from Eco by [Strange Loop Games](https://strangeloopgames.com). This tool reads those configs and reimplements the generator in JavaScript; it contains no game code. Built with [Claude Code](https://claude.com/claude-code).

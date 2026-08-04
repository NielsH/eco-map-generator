# Eco WorldGen map generator

A single-page, zero-dependency tool that previews an [Eco](https://play.eco) `WorldGenerator.eco` config **the way the game's server would generate it** — the surface map (biomes, elevation, climate, rivers, lakes) plus the underground block/ore composition — and lets you **edit every knob and regenerate live**. Everything runs client-side in your browser; nothing is uploaded anywhere.

**Live:** https://nielsh.github.io/eco-map-generator/

A default Eco world is generated on load. Drop, upload, or paste your own `WorldGenerator.eco` to replace it, or just start turning knobs.

## What it does

- **Surface map preview** — biomes, elevation, temperature, moisture, rivers & lakes, rendered top-down (in the in-game editor's orientation). Hover any cell for its biome and elevation/temperature/moisture.
- **Editable config** — a full form for every generation parameter: world size, land/ocean, continents & islands, lakes & rivers, elevation curve, seed (with a 🎲 randomize button).
- **Biome mix editor** — a *Simple* mode where you set each biome's **share of land** (with a live budget bar and a Grassland "leftover" that can't be over-allocated), and an *Advanced* mode with the raw Voronoi weights. After a generate it shows **intended vs. actual** per biome.
- **Underground panel** — a collapsible section (on the map page **and** while designing) with a **Block composition** chart (100%-stacked block mix by biome and world height) plus a **Visual editor**: per biome, edit the base-rock strata, ore **veins** (deposits) and **scatter** blocks by dragging in the underground column at real **world height** — move a block, resize its depth via the top/bottom edges, change abundance via the inner edge, or drag a rock boundary to move where a layer ends. Add/remove any block per biome; the chart updates live.
- **3D voxel world** — a fly-through view of the real per-voxel blocks (base strata, scatter, and faithful ore veins), streamed in chunks with block-type toggles and a cutaway slice. The world is **toroidal** — fly off one edge and continue seamlessly into the wrapped world.
- **Design a map (paint → exact world)** — draw the world you want and turn it into one that matches *exactly*. Paint **biomes, elevation, and rivers/water** on a toroidal canvas (brush, flood-fill, always-on edge-wrap with a live 2×2 seam preview, undo); elevation shows as a shaded relief map and painted areas get natural per-stroke roughness. **Import an image** to map its colours to biomes — with a colour-legend override, or a **Brightness** mode that maps luminance onto a terrain ramp for photos. Water that is **enclosed by land** imports as a **freshwater lake** (it keeps the surrounding biome and sits at that biome's elevation, not as deep ocean); the largest connected water body stays the sea. Paint water in **`#1E90FF`** to force fresh water (lakes/rivers) even where it runs to the coast. **Preview it in 3D**, then **☁ Generate Eco save** — one click uploads your design to the hosted generation service, which runs Eco's real headless generator in a sandbox and hands back a link to download a stock-loadable `.eco` whose biomes/terrain match your drawing *exactly* (no local tooling needed; generation is queued and takes a few minutes, and the link is permanent so you can re-download any time). **Compatible with Eco v14.** Re-import a design `.zip` later — e.g. the input re-downloaded from the service — to keep tuning.
- **Find a map (paint → closest real seed)** — prefer a naturally-generated world? Paint the layout you want and the tool **inverts** it into a starting config (biome mix → weights, land fraction, continent/island and per-biome blob counts), then runs a **parallel best-of-N seed search** across Web Workers, scoring each candidate by a wrap-invariant similarity to your drawing, and shows a **gallery of live previews** (sort, min-score filter, infinite scroll — click any to apply it and regenerate). A *mix ↔ layout* slider trades biome-proportion against spatial-layout fidelity. **Honest scope:** the generator can't place a biome at a spot you choose — layout is a chaotic function of the seed — so this matches the biome mix and macro land-shape well and only approximates placement. Every result is a genuine, exportable `.eco`.
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

The polygons are sent back to the main thread and rendered to a canvas. The underground block-composition chart and the 3D voxel blocks are computed from the config's `TerrainModule` (base strata + scatter + ore veins).

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
src/raster.js      surface polygons -> per-voxel biome + heightmap grids
src/voxel.js       per-voxel underground block generation (strata/scatter/ore veins)
src/render3d.js    main-thread 3D voxel renderer (three.js)
src/search.js      inverse-design search core (class grid + wrap-invariant similarity)
src/designer.js    "Design a map" UI: painter, config inversion, worker search pool, gallery
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

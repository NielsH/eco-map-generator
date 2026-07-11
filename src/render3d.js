// 3D voxel world view (main thread). The worker generates + face-cull-meshes chunks of real
// per-voxel blocks; this module streams chunk meshes around a fly camera and colors them by
// block type. Block-type visibility toggles let you hide surface layers to reveal ore veins.
// three.js is a global (UMD). Chunk geometry is generated on demand near the camera.
var Render3D = (function () {
  var T = null;
  var scene, camera, renderer, container, water;
  var running = false, rafId = 0;
  var meta = null;              // { W, WL, MH }
  var chunks = new Map();       // "cx,cz" -> THREE.Mesh (or Object3D placeholder while pending)
  var pending = new Set();      // chunk keys awaiting worker mesh
  var wantQueue = [];
  var hidden = new Set();       // block types hidden from view
  var colorFor = null;          // fn(blockType) -> THREE.Color
  var requestChunk = null, dropChunk = null;   // wired to the worker by the glue
  var CHUNK = 24, RENDER_DIST = 6, MAX_REQ_INFLIGHT = 6;
  var grayGrid = null, biomeGrid = null, biomeNames = null, Wg = 0, curSlice = null, lastSliceMs = 0, hud = null;   // cutaway + HUD

  // heightmap byte -> surface Y (matches the worker/TerrainGenerator), for underground detection
  function vRound(x) { var f = Math.floor(x), d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return (f % 2 === 0) ? f : f + 1; }
  function idxAt(x, z) { var wx = ((Math.floor(x) % Wg) + Wg) % Wg, wz = ((Math.floor(z) % Wg) + Wg) % Wg; return wz * Wg + wx; }
  function heightAt(x, z) {
    if (!grayGrid) return 0;
    var elev = (grayGrid[idxAt(x, z)] / 255) * 2 - 1;
    var ih = elev < 0 ? vRound((elev + 1) * meta.WL) : meta.WL + vRound(elev * (meta.MH - meta.WL));
    return ih < 0 ? 0 : ih > meta.MH ? meta.MH : ih;
  }
  function biomeAt(x, z) {
    if (!biomeGrid || !biomeNames) return '';
    var n = biomeNames[biomeGrid[idxAt(x, z)]] || '';
    return n.replace(/([a-z])([A-Z])/g, '$1 $2');   // "ColdForest" -> "Cold Forest"
  }

  // ---- input / fly camera ----
  var keys = {}, yaw = 0, pitch = -0.5, dragging = false, speed = 40, tmpF = null, lastT = 0;
  function onKey(e, down) { var k = e.key.toLowerCase(); keys[k] = down; if (down && (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === ' ')) e.preventDefault(); }
  function onMouseMove(e) {
    if (!dragging) return;
    yaw += e.movementX * 0.003; pitch += e.movementY * 0.003;   // grab-the-scene
    var lim = Math.PI / 2 - 0.02; if (pitch > lim) pitch = lim; if (pitch < -lim) pitch = -lim;
  }
  function onWheel(e) { speed = Math.max(6, Math.min(400, speed * (e.deltaY < 0 ? 1.15 : 0.87))); e.preventDefault(); }
  function forward() { return tmpF.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)); }
  function updateCamera(dt) {
    var f = forward();
    camera.lookAt(camera.position.x + f.x, camera.position.y + f.y, camera.position.z + f.z);
    var mv = speed * dt, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw), p = camera.position;
    if (keys['w']) { p.x += fx * mv; p.z += fz * mv; }
    if (keys['s']) { p.x -= fx * mv; p.z -= fz * mv; }
    if (keys['d']) { p.x += rx * mv; p.z += rz * mv; }
    if (keys['a']) { p.x -= rx * mv; p.z -= rz * mv; }
    if (keys[' '] || keys['e']) p.y += mv;
    if (keys['shift'] || keys['q']) p.y -= mv;
  }

  // ---- streaming ----
  function streamChunks() {
    if (!meta) return;
    var nC = Math.ceil(meta.W / CHUNK);
    var ccx = Math.floor(camera.position.x / CHUNK), ccz = Math.floor(camera.position.z / CHUNK);
    var want = [];
    for (var dz = -RENDER_DIST; dz <= RENDER_DIST; dz++)
      for (var dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
        var cx = ccx + dx, cz = ccz + dz;
        if (cx < 0 || cz < 0 || cx >= nC || cz >= nC) continue;
        var key = cx + ',' + cz;
        if (chunks.has(key) || pending.has(key)) continue;
        want.push({ key: key, cx: cx, cz: cz, d: dx * dx + dz * dz });
      }
    want.sort(function (a, b) { return a.d - b.d; });
    wantQueue = want;
    chunks.forEach(function (mesh, key) {
      var p = key.split(','), cx = +p[0], cz = +p[1];
      if (Math.abs(cx - ccx) > RENDER_DIST + 1 || Math.abs(cz - ccz) > RENDER_DIST + 1) {
        scene.remove(mesh); if (mesh.geometry) mesh.geometry.dispose(); chunks.delete(key);
        if (dropChunk) dropChunk(cx, cz);
      }
    });
  }
  function pump() {
    while (pending.size < MAX_REQ_INFLIGHT && wantQueue.length) {
      var c = wantQueue.shift();
      if (chunks.has(c.key) || pending.has(c.key)) continue;
      pending.add(c.key);
      requestChunk(c.cx, c.cz, CHUNK, Array.from(hidden), curSlice);
    }
  }
  // re-request meshes for all loaded chunks (used when the cutaway slice level changes)
  function remeshLoaded() {
    chunks.forEach(function (mesh, key) { var p = key.split(','); requestChunk(+p[0], +p[1], CHUNK, Array.from(hidden), curSlice); });
  }

  // worker delivered a meshed chunk: build the BufferGeometry + colored mesh
  function onChunkMesh(cx, cz, g) {
    var key = cx + ',' + cz; pending.delete(key);
    if (chunks.has(key)) { scene.remove(chunks.get(key)); var old = chunks.get(key); if (old.geometry) old.geometry.dispose(); }
    if (!g.pos.length) { chunks.set(key, new T.Object3D()); return; }
    var colors = new Float32Array(g.pal.length * 3);
    var palCols = g.palette.map(function (t) { return colorFor(t); });
    for (var i = 0; i < g.pal.length; i++) { var c = palCols[g.pal[i]]; colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new T.BufferAttribute(g.nor, 3));
    geo.setAttribute('color', new T.BufferAttribute(colors, 3));
    var mesh = new T.Mesh(geo, meta.mat); scene.add(mesh); chunks.set(key, mesh);
  }

  var streamTick = 0;
  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
    updateCamera(dt);
    updateCutaway(now);
    if ((streamTick++ % 6) === 0) streamChunks();
    pump();
    renderer.render(scene, camera);
    updateHud();
  }

  // When the eye drops below the local surface, cut the terrain at the eye height so the strata
  // around/below become visible (otherwise you're embedded in solid rock and see nothing).
  function updateCutaway(now) {
    if (!meta) return;
    var camY = camera.position.y;
    var surf = heightAt(camera.position.x, camera.position.z);
    var underground = camY < surf - 1;
    // cut a couple blocks BELOW the eye so the exposed strata surface sits under you (visible),
    // not edge-on at eye level.
    var desired = underground ? Math.max(0, Math.floor(camY) - 2) : null;   // null = no slice
    if (desired === curSlice) return;
    if (now - lastSliceMs < 120) return;   // throttle re-mesh churn while diving
    curSlice = desired; lastSliceMs = now;
    remeshLoaded();
  }

  function updateHud() {
    if (!hud) return;
    var p = camera.position, b = biomeAt(p.x, p.z);
    hud.textContent = 'Y ' + Math.round(p.y) + '   X ' + Math.round(p.x) + '  Z ' + Math.round(p.z) +
      (b ? '   ·   ' + b : '') + (curSlice != null ? '   ✂ cutaway' : '');
  }

  // ---- setup ----
  function init(el, THREE) {
    if (renderer) { container = el; el.appendChild(renderer.domElement); resize(); return; }
    T = THREE; container = el; tmpF = new T.Vector3();
    scene = new T.Scene();
    scene.background = new T.Color(0x9ec7e0);
    scene.fog = new T.Fog(0x9ec7e0, CHUNK * RENDER_DIST * 0.7, CHUNK * RENDER_DIST * 1.5);
    camera = new T.PerspectiveCamera(70, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 5000);
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    scene.add(new T.HemisphereLight(0xffffff, 0x55503f, 0.95));
    var sun = new T.DirectionalLight(0xffffff, 0.7); sun.position.set(0.5, 1, 0.3); scene.add(sun);
    resize();
    // Y/X/Z read-out overlay
    hud = document.createElement('div');
    hud.style.cssText = 'position:absolute;top:8px;left:8px;padding:4px 9px;border-radius:6px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#fff;background:rgba(0,0,0,.45);pointer-events:none;letter-spacing:.3px;z-index:2';
    el.appendChild(hud);
    renderer.domElement.style.cursor = 'grab';
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', function (e) { if (running) onKey(e, true); });
    window.addEventListener('keyup', function (e) { if (running) onKey(e, false); });
    window.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mousedown', function (e) { dragging = true; renderer.domElement.style.cursor = 'grabbing'; e.preventDefault(); });
    window.addEventListener('mouseup', function () { if (dragging) { dragging = false; if (renderer) renderer.domElement.style.cursor = 'grab'; } });
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  }
  function resize() {
    if (!renderer || !container) return;
    var w = container.clientWidth, h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function clearChunks() {
    chunks.forEach(function (m) { if (m.geometry) { scene.remove(m); m.geometry.dispose(); } else scene.remove(m); });
    chunks.clear(); pending.clear(); wantQueue = [];
  }

  // meta = {W, waterLevel, maxGenerationHeight}; colorFn(blockType)->[r,g,b] 0..1;
  // reqChunk(cx,cz,CHUNK,hiddenArr) asks the worker; dropCb(cx,cz) frees its cache.
  function setWorld(m, colorFn, reqChunk, dropCb) {
    clearChunks();
    colorFor = function (t) { return new T.Color(colorFn(t)); };   // colorFn returns a CSS color string
    requestChunk = reqChunk; dropChunk = dropCb;
    grayGrid = m.gray || null; biomeGrid = m.biome || null; biomeNames = m.biomeNames || null;
    Wg = m.W; curSlice = null; lastSliceMs = 0;
    meta = { W: m.W, WL: m.waterLevel, MH: m.maxGenerationHeight, mat: new T.MeshLambertMaterial({ vertexColors: true }) };
    if (water) { scene.remove(water); water.geometry.dispose(); water.material.dispose(); }
    var wp = new T.PlaneGeometry(m.W, m.W);
    water = new T.Mesh(wp, new T.MeshBasicMaterial({ color: 0x3d7fd6, transparent: true, opacity: 0.5, side: T.DoubleSide, depthWrite: false }));
    water.rotation.x = -Math.PI / 2; water.position.set(m.W / 2, m.waterLevel + 1, m.W / 2); water.renderOrder = 1;
    scene.add(water);
    var cx = m.W / 2, cz = m.W / 2;
    camera.position.set(cx, m.maxGenerationHeight * 0.7 + 30, cz + 40);
    yaw = Math.PI; pitch = -0.6;
    streamChunks();
  }

  // toggle a block type's visibility; re-request all loaded/pending chunks
  function setHidden(hiddenArr) {
    hidden = new Set(hiddenArr);
    clearChunks();
    streamChunks();
  }

  function start() { if (running) return; running = true; lastT = performance.now(); rafId = requestAnimationFrame(frame); }
  function stop() { running = false; if (rafId) cancelAnimationFrame(rafId); keys = {}; dragging = false; }

  return { init: init, setWorld: setWorld, onChunkMesh: onChunkMesh, setHidden: setHidden,
    start: start, stop: stop, resize: resize, isReady: function () { return !!renderer; } };
})();

// 3D voxel world view (main thread). Consumes the raster grids (biome + blurred heightmap)
// and renders the world as simple colored blocks with a fly camera. three.js is a global (UMD).
//
// Phase 2: each map column is a solid block stack from bedrock to its surface height, colored by
// biome; cliffs between columns are meshed as side faces; one translucent water plane sits at the
// water level. Chunks are streamed around the camera so world size doesn't blow up memory.
// (Phase 3 will replace the solid fill with real per-voxel block types + visibility toggles.)
var Render3D = (function () {
  var T = null;                 // THREE
  var scene, camera, renderer, container, water;
  var running = false, rafId = 0;
  var world = null;             // { W, biome, gray, names, WL, MH, colors }
  var chunks = new Map();       // "cx,cz" -> THREE.Mesh
  var buildQueue = [];          // chunks pending mesh build
  var CHUNK = 32, RENDER_DIST = 7, MAX_BUILDS_PER_FRAME = 3;

  // ---- input / fly camera ----
  var keys = {}, yaw = 0, pitch = -0.5, dragging = false, speed = 40;
  var tmpF = null, lastT = 0;

  function onKey(e, down) {
    var k = e.key.toLowerCase();
    keys[k] = down;
    if (down && (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === ' ')) e.preventDefault();
  }
  function onMouseMove(e) {
    if (!dragging) return;
    // "grab the scene": drag right and the view follows your hand (inverse of FPS look)
    yaw += e.movementX * 0.003;
    pitch += e.movementY * 0.003;
    var lim = Math.PI / 2 - 0.02;
    if (pitch > lim) pitch = lim; if (pitch < -lim) pitch = -lim;
  }
  function onWheel(e) { speed = Math.max(6, Math.min(400, speed * (e.deltaY < 0 ? 1.15 : 0.87))); e.preventDefault(); }

  function forward() { return tmpF.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)); }

  function updateCamera(dt) {
    var f = forward();
    camera.lookAt(camera.position.x + f.x, camera.position.y + f.y, camera.position.z + f.z);
    var mv = speed * dt, moved = false;
    var fx = Math.sin(yaw), fz = Math.cos(yaw);        // horizontal forward
    var rx = -Math.cos(yaw), rz = Math.sin(yaw);       // camera-right (D strafes right, A left)
    var p = camera.position;
    if (keys['w']) { p.x += fx * mv; p.z += fz * mv; moved = true; }
    if (keys['s']) { p.x -= fx * mv; p.z -= fz * mv; moved = true; }
    if (keys['d']) { p.x += rx * mv; p.z += rz * mv; moved = true; }
    if (keys['a']) { p.x -= rx * mv; p.z -= rz * mv; moved = true; }
    if (keys[' '] || keys['e']) { p.y += mv; moved = true; }
    if (keys['shift'] || keys['q']) { p.y -= mv; moved = true; }
    return moved;
  }

  // ---- world sampling ----
  function colHeight(x, z) {
    var W = world.W;
    var g = world.gray[z * W + x];
    var elev = (g / 255) * 2 - 1;
    var ih = elev < 0 ? Math.round((elev + 1) * world.WL) : world.WL + Math.round(elev * (world.MH - world.WL));
    if (ih < 0) ih = 0; if (ih > world.MH) ih = world.MH;
    return ih;
  }
  function colColor(x, z) { return world.colors[world.biome[z * world.W + x]]; }

  // ---- chunk meshing (heightmap surface: top faces + exposed cliff sides) ----
  function buildChunk(cx, cz) {
    var W = world.W, x0 = cx * CHUNK, z0 = cz * CHUNK;
    var pos = [], nor = [], col = [];
    function quad(ax, ay, az, bx, by, bz, ccx, ccy, ccz, dx, dy, dz, nx, ny, nz, c) {
      // two triangles a,b,c  and a,c,d
      pos.push(ax, ay, az, bx, by, bz, ccx, ccy, ccz, ax, ay, az, ccx, ccy, ccz, dx, dy, dz);
      for (var i = 0; i < 6; i++) { nor.push(nx, ny, nz); col.push(c[0], c[1], c[2]); }
    }
    for (var lz = 0; lz < CHUNK; lz++) {
      var z = z0 + lz; if (z >= W) break;
      for (var lx = 0; lx < CHUNK; lx++) {
        var x = x0 + lx; if (x >= W) break;
        var h = colHeight(x, z), c = colColor(x, z);
        var top = h + 1;                 // block h occupies [h, h+1)
        // top face (y = top)
        quad(x, top, z + 1,  x + 1, top, z + 1,  x + 1, top, z,  x, top, z,  0, 1, 0, c);
        // exposed sides vs 4 neighbours (wrap sampling for seamless chunk borders)
        var xm = (x - 1 + W) % W, xp = (x + 1) % W, zm = (z - 1 + W) % W, zp = (z + 1) % W;
        var hw = colHeight(xm, z), he = colHeight(xp, z), hn = colHeight(x, zm), hs = colHeight(x, zp);
        if (hw < h) { var b = hw + 1; quad(x, top, z, x, top, z + 1, x, b, z + 1, x, b, z, -1, 0, 0, c); }
        if (he < h) { var b2 = he + 1; quad(x + 1, top, z + 1, x + 1, top, z, x + 1, b2, z, x + 1, b2, z + 1, 1, 0, 0, c); }
        if (hn < h) { var b3 = hn + 1; quad(x + 1, top, z, x, top, z, x, b3, z, x + 1, b3, z, 0, 0, -1, c); }
        if (hs < h) { var b4 = hs + 1; quad(x, top, z + 1, x + 1, top, z + 1, x + 1, b4, z + 1, x, b4, z + 1, 0, 0, 1, c); }
      }
    }
    if (!pos.length) return null;
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    var mesh = new T.Mesh(geo, world.mat);
    scene.add(mesh);
    return mesh;
  }

  function streamChunks() {
    var nC = Math.ceil(world.W / CHUNK);
    var ccx = Math.floor(camera.position.x / CHUNK), ccz = Math.floor(camera.position.z / CHUNK);
    // queue missing chunks in range, nearest first
    var want = [];
    for (var dz = -RENDER_DIST; dz <= RENDER_DIST; dz++)
      for (var dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
        var cx = ccx + dx, cz = ccz + dz;
        if (cx < 0 || cz < 0 || cx >= nC || cz >= nC) continue;
        var key = cx + ',' + cz;
        if (chunks.has(key)) continue;
        want.push({ key: key, cx: cx, cz: cz, d: dx * dx + dz * dz });
      }
    want.sort(function (a, b) { return a.d - b.d; });
    buildQueue = want;
    // unload far chunks
    chunks.forEach(function (mesh, key) {
      var p = key.split(','), cx = +p[0], cz = +p[1];
      if (Math.abs(cx - ccx) > RENDER_DIST + 1 || Math.abs(cz - ccz) > RENDER_DIST + 1) {
        scene.remove(mesh); mesh.geometry.dispose(); chunks.delete(key);
      }
    });
  }

  function drainBuildQueue() {
    var n = 0;
    while (buildQueue.length && n < MAX_BUILDS_PER_FRAME) {
      var c = buildQueue.shift();
      if (chunks.has(c.key)) continue;
      var mesh = buildChunk(c.cx, c.cz);
      chunks.set(c.key, mesh || new T.Object3D());  // store placeholder for empty chunks so we don't retry
      n++;
    }
  }

  var streamTick = 0;
  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
    updateCamera(dt);
    if ((streamTick++ % 6) === 0) streamChunks();
    drainBuildQueue();
    renderer.render(scene, camera);
  }

  // ---- setup ----
  function init(el, THREE) {
    if (renderer) { container = el; el.appendChild(renderer.domElement); resize(); return; }
    T = THREE; container = el; tmpF = new T.Vector3();
    scene = new T.Scene();
    scene.background = new T.Color(0x8fbcd4);
    scene.fog = new T.Fog(0x8fbcd4, CHUNK * RENDER_DIST * 0.6, CHUNK * RENDER_DIST * 1.4);
    camera = new T.PerspectiveCamera(70, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 4000);
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    var hemi = new T.HemisphereLight(0xffffff, 0x556b2f, 0.9); scene.add(hemi);
    var sun = new T.DirectionalLight(0xffffff, 0.8); sun.position.set(0.5, 1, 0.3); scene.add(sun);
    resize();
    renderer.domElement.style.cursor = 'grab';
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', function (e) { if (running) onKey(e, true); });
    window.addEventListener('keyup', function (e) { if (running) onKey(e, false); });
    window.addEventListener('mousemove', onMouseMove);
    // click-and-drag to look around (more predictable than pointer lock; cursor stays visible)
    renderer.domElement.addEventListener('mousedown', function (e) { dragging = true; renderer.domElement.style.cursor = 'grabbing'; e.preventDefault(); });
    window.addEventListener('mouseup', function () { if (dragging) { dragging = false; if (renderer) renderer.domElement.style.cursor = 'grab'; } });
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  }

  function resize() {
    if (!renderer || !container) return;
    var w = container.clientWidth, h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function setWorld(grid, cfg, colors) {
    world = { W: grid.W, biome: grid.biome, gray: grid.gray, names: grid.biomeNames,
      WL: cfg.waterLevel, MH: cfg.maxGenerationHeight,
      colors: colors, mat: new T.MeshLambertMaterial({ vertexColors: true }) };
    // clear any existing chunks
    chunks.forEach(function (m) { if (m.geometry) { scene.remove(m); m.geometry.dispose(); } }); chunks.clear();
    buildQueue = [];
    if (water) { scene.remove(water); water.geometry.dispose(); water.material.dispose(); }
    var wp = new T.PlaneGeometry(grid.W, grid.W);
    water = new T.Mesh(wp, new T.MeshBasicMaterial({ color: 0x3d7fd6, transparent: true, opacity: 0.55, side: T.DoubleSide }));
    water.rotation.x = -Math.PI / 2; water.position.set(grid.W / 2, cfg.waterLevel + 1, grid.W / 2);
    scene.add(water);
    // drop the camera above the middle of the map, looking down-ish
    var cx = grid.W / 2, cz = grid.W / 2;
    camera.position.set(cx, colHeight(Math.floor(cx), Math.floor(cz)) + 60, cz + 40);
    yaw = Math.PI; pitch = -0.5;
    streamChunks();
  }

  function start() { if (running) return; running = true; lastT = performance.now(); rafId = requestAnimationFrame(frame); }
  function stop() { running = false; if (rafId) cancelAnimationFrame(rafId); keys = {}; dragging = false; }

  return { init: init, setWorld: setWorld, start: start, stop: stop, resize: resize, isReady: function () { return !!renderer; }, hasWorld: function () { return !!world; } };
})();

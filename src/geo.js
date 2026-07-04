// Faithful port of Eco's PoissonDiscSampler and Fortune's-algorithm Voronoi.

// ---- Poisson disc sampler (Bridson), matches PoissonDiscSampler.cs ----
// All positions/distances are single-precision to match C#'s float PointF / radius2.
function poissonSamples(width, height, radius, rand) {
  const f = Math.fround;
  const K = 30;
  const radius2 = f(f(radius) * f(radius));
  const cellSize = f(radius / Math.sqrt(2));
  const gw = Math.ceil(f(width / cellSize)), gh = Math.ceil(f(height / cellSize));
  const grid = new Array(gw * gh).fill(null); // null = empty (C# uses zero-vector)
  const active = [];
  const samples = [];

  const gpos = s => [Math.trunc(f(s.x / cellSize)), Math.trunc(f(s.y / cellSize))];
  const addSample = s => {
    active.push(s);
    const [gx, gy] = gpos(s);
    grid[gx + gy * gw] = s;
    samples.push(s);
    return s;
  };
  const isFarEnough = s => {
    const [px, py] = gpos(s);
    const xmin = Math.max(px - 2, 0), ymin = Math.max(py - 2, 0);
    const xmax = Math.min(px + 2, gw - 1), ymax = Math.min(py + 2, gh - 1);
    for (let y = ymin; y <= ymax; y++)
      for (let x = xmin; x <= xmax; x++) {
        const g = grid[x + y * gw];
        if (g && g.x !== 0 && g.y !== 0) {   // matches C#: s.X!=0 && s.Y!=0
          const dx = f(g.x - s.x), dy = f(g.y - s.y);
          if (f(f(dx * dx) + f(dy * dy)) < radius2) return false;
        }
      }
    return true;
  };

  addSample({ x: f(f(rand.nextDouble()) * width), y: f(f(rand.nextDouble()) * height) });
  while (active.length > 0) {
    const i = Math.trunc(rand.nextDouble()) * active.length; // C# bug: (int)NextDouble()*count is always 0, but still draws
    const sample = active[i];
    let found = false;
    for (let j = 0; j < K; j++) {
      const angle = f(2.0 * Math.PI * rand.nextDouble());
      const r2 = f(Math.sqrt(rand.nextDouble() * 3 * radius2 + radius2));
      const cand = { x: f(sample.x + f(r2 * f(Math.cos(angle)))), y: f(sample.y + f(r2 * f(Math.sin(angle)))) };
      const outside = cand.x < 0 || cand.x > width || cand.y < 0 || cand.y > height;
      if (!outside && isFarEnough(cand)) { found = true; addSample(cand); break; }
    }
    if (!found) { active[i] = active[active.length - 1]; active.pop(); }
  }
  return samples;
}

// ---- Fortune's algorithm, port of Voronoi.cs + VoronoiElements.cs ----
class VPoint { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Site { constructor() { this.coord = new VPoint(); this.sitenbr = 0; } }
class VEdge {
  constructor() { this.a = 0; this.b = 0; this.c = 0; this.ep = [null, null]; this.reg = [null, null]; this.edgenbr = 0; }
}
class Halfedge {
  constructor() { this.ELleft = null; this.ELright = null; this.ELedge = null; this.deleted = false; this.ELpm = 0; this.vertex = null; this.ystar = 0; this.PQnext = null; }
}
class GraphEdge { constructor() { this.x1 = 0; this.y1 = 0; this.x2 = 0; this.y2 = 0; this.site1 = 0; this.site2 = 0; } }

const LE = 0, RE = 1;

class Voronoi {
  constructor(minDist) { this.minDistanceBetweenSites = minDist; this.allEdges = null; }

  generateVoronoi(xv, yv, minX, maxX, minY, maxY) {
    this.sort(xv, yv, xv.length);
    if (minX > maxX) { const t = minX; minX = maxX; maxX = t; }
    if (minY > maxY) { const t = minY; minY = maxY; maxY = t; }
    this.borderMinX = minX; this.borderMinY = minY; this.borderMaxX = maxX; this.borderMaxY = maxY;
    this.siteidx = 0;
    this.voronoiBD();
    return this.allEdges;
  }

  sort(xv, yv, count) {
    this.sites = null;
    this.allEdges = [];
    this.nsites = count; this.nvertices = 0; this.nedges = 0;
    this.sqrtNsites = Math.trunc(Math.sqrt(count + 4));
    const xs = xv.slice(0, count), ys = yv.slice(0, count);
    this.sortNode(xs, ys, count);
  }

  sortNode(xv, yv, n) {
    this.nsites = n;
    this.sites = new Array(n);
    this.xmin = xv[0]; this.ymin = yv[0]; this.xmax = xv[0]; this.ymax = yv[0];
    for (let i = 0; i < n; i++) {
      const s = new Site();
      s.coord.x = xv[i]; s.coord.y = yv[i]; s.sitenbr = i;
      this.sites[i] = s;
      if (xv[i] < this.xmin) this.xmin = xv[i]; else if (xv[i] > this.xmax) this.xmax = xv[i];
      if (yv[i] < this.ymin) this.ymin = yv[i]; else if (yv[i] > this.ymax) this.ymax = yv[i];
    }
    // SiteSorterYX: by Y then X (no ties for distinct points)
    this.sites.sort((p1, p2) => {
      if (p1.coord.y < p2.coord.y) return -1;
      if (p1.coord.y > p2.coord.y) return 1;
      if (p1.coord.x < p2.coord.x) return -1;
      if (p1.coord.x > p2.coord.x) return 1;
      return 0;
    });
    this.deltax = this.xmax - this.xmin;
    this.deltay = this.ymax - this.ymin;
  }

  nextOne() { return this.siteidx < this.nsites ? this.sites[this.siteidx++] : null; }

  bisect(s1, s2) {
    const e = new VEdge();
    e.reg[0] = s1; e.reg[1] = s2;
    const dx = s2.coord.x - s1.coord.x, dy = s2.coord.y - s1.coord.y;
    const adx = dx > 0 ? dx : -dx, ady = dy > 0 ? dy : -dy;
    e.c = s1.coord.x * dx + s1.coord.y * dy + (dx * dx + dy * dy) * 0.5;
    if (adx > ady) { e.a = 1.0; e.b = dy / dx; e.c /= dx; }
    else { e.a = dx / dy; e.b = 1.0; e.c /= dy; }
    e.edgenbr = this.nedges++;
    return e;
  }

  makeVertex(v) { v.sitenbr = this.nvertices++; }

  PQinitialize() {
    this.pqCount = 0; this.pqMin = 0; this.pqHashsize = 4 * this.sqrtNsites;
    this.pqHash = new Array(this.pqHashsize);
    for (let i = 0; i < this.pqHashsize; i++) this.pqHash[i] = new Halfedge();
  }
  PQbucket(he) {
    let bucket = Math.trunc((he.ystar - this.ymin) / this.deltay * this.pqHashsize);
    if (bucket < 0) bucket = 0;
    if (bucket >= this.pqHashsize) bucket = this.pqHashsize - 1;
    if (bucket < this.pqMin) this.pqMin = bucket;
    return bucket;
  }
  PQinsert(he, v, offset) {
    he.vertex = v; he.ystar = v.coord.y + offset;
    let last = this.pqHash[this.PQbucket(he)], next;
    while ((next = last.PQnext) != null &&
      (he.ystar > next.ystar || (he.ystar === next.ystar && v.coord.x > next.vertex.coord.x))) last = next;
    he.PQnext = last.PQnext; last.PQnext = he; this.pqCount++;
  }
  PQdelete(he) {
    if (he.vertex != null) {
      let last = this.pqHash[this.PQbucket(he)];
      while (last.PQnext !== he) last = last.PQnext;
      last.PQnext = he.PQnext; this.pqCount--; he.vertex = null;
    }
  }
  PQempty() { return this.pqCount === 0; }
  PQ_min() {
    while (this.pqHash[this.pqMin].PQnext == null) this.pqMin++;
    return new VPoint(this.pqHash[this.pqMin].PQnext.vertex.coord.x, this.pqHash[this.pqMin].PQnext.ystar);
  }
  PQextractmin() {
    const curr = this.pqHash[this.pqMin].PQnext;
    this.pqHash[this.pqMin].PQnext = curr.PQnext; this.pqCount--;
    return curr;
  }

  HEcreate(e, pm) { const a = new Halfedge(); a.ELedge = e; a.ELpm = pm; a.PQnext = null; a.vertex = null; return a; }
  ELinitialize() {
    this.elHashsize = 2 * this.sqrtNsites;
    this.elHash = new Array(this.elHashsize).fill(null);
    this.elLeftend = this.HEcreate(null, 0);
    this.elRightend = this.HEcreate(null, 0);
    this.elLeftend.ELleft = null; this.elLeftend.ELright = this.elRightend;
    this.elRightend.ELleft = this.elLeftend; this.elRightend.ELright = null;
    this.elHash[0] = this.elLeftend; this.elHash[this.elHashsize - 1] = this.elRightend;
  }
  ELright(he) { return he.ELright; }
  ELleft(he) { return he.ELleft; }
  leftReg(he) { return he.ELedge == null ? this.bottomsite : (he.ELpm === LE ? he.ELedge.reg[LE] : he.ELedge.reg[RE]); }
  rightReg(he) { return he.ELedge == null ? this.bottomsite : (he.ELpm === LE ? he.ELedge.reg[RE] : he.ELedge.reg[LE]); }
  ELinsert(lb, he) { he.ELleft = lb; he.ELright = lb.ELright; lb.ELright.ELleft = he; lb.ELright = he; }
  ELdelete(he) { he.ELleft.ELright = he.ELright; he.ELright.ELleft = he.ELleft; he.deleted = true; }
  ELgethash(b) {
    if (b < 0 || b >= this.elHashsize) return null;
    const he = this.elHash[b];
    if (he == null || !he.deleted) return he;
    this.elHash[b] = null; return null;
  }
  ELleftbnd(p) {
    let bucket = Math.trunc((p.x - this.xmin) / this.deltax * this.elHashsize);
    if (bucket < 0) bucket = 0;
    if (bucket >= this.elHashsize) bucket = this.elHashsize - 1;
    let he = this.ELgethash(bucket);
    if (he == null) {
      for (let i = 1; i < this.elHashsize; i++) {
        if ((he = this.ELgethash(bucket - i)) != null) break;
        if ((he = this.ELgethash(bucket + i)) != null) break;
      }
    }
    if (he === this.elLeftend || (he !== this.elRightend && this.rightOf(he, p))) {
      do { he = he.ELright; } while (he !== this.elRightend && this.rightOf(he, p));
      he = he.ELleft;
    } else {
      do { he = he.ELleft; } while (he !== this.elLeftend && !this.rightOf(he, p));
    }
    if (bucket > 0 && bucket < this.elHashsize - 1) this.elHash[bucket] = he;
    return he;
  }

  pushGraphEdge(l, r, x1, y1, x2, y2) {
    const e = new GraphEdge(); this.allEdges.push(e);
    e.x1 = x1; e.y1 = y1; e.x2 = x2; e.y2 = y2; e.site1 = l.sitenbr; e.site2 = r.sitenbr;
  }

  clipLine(e) {
    let x1 = e.reg[0].coord.x, y1 = e.reg[0].coord.y, x2 = e.reg[1].coord.x, y2 = e.reg[1].coord.y;
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.sqrt(dx * dx + dy * dy) < this.minDistanceBetweenSites) return;
    const pxmin = this.borderMinX, pymin = this.borderMinY, pxmax = this.borderMaxX, pymax = this.borderMaxY;
    let s1, s2;
    if (e.a === 1.0 && e.b >= 0.0) { s1 = e.ep[1]; s2 = e.ep[0]; }
    else { s1 = e.ep[0]; s2 = e.ep[1]; }
    if (e.a === 1.0) {
      y1 = pymin;
      if (s1 != null && s1.coord.y > pymin) y1 = s1.coord.y;
      if (y1 > pymax) y1 = pymax;
      x1 = e.c - e.b * y1;
      y2 = pymax;
      if (s2 != null && s2.coord.y < pymax) y2 = s2.coord.y;
      if (y2 < pymin) y2 = pymin;
      x2 = e.c - e.b * y2;
      if ((x1 > pxmax && x2 > pxmax) || (x1 < pxmin && x2 < pxmin)) return;
      if (x1 > pxmax) { x1 = pxmax; y1 = (e.c - x1) / e.b; }
      if (x1 < pxmin) { x1 = pxmin; y1 = (e.c - x1) / e.b; }
      if (x2 > pxmax) { x2 = pxmax; y2 = (e.c - x2) / e.b; }
      if (x2 < pxmin) { x2 = pxmin; y2 = (e.c - x2) / e.b; }
    } else {
      x1 = pxmin;
      if (s1 != null && s1.coord.x > pxmin) x1 = s1.coord.x;
      if (x1 > pxmax) x1 = pxmax;
      y1 = e.c - e.a * x1;
      x2 = pxmax;
      if (s2 != null && s2.coord.x < pxmax) x2 = s2.coord.x;
      if (x2 < pxmin) x2 = pxmin;
      y2 = e.c - e.a * x2;
      if ((y1 > pymax && y2 > pymax) || (y1 < pymin && y2 < pymin)) return;
      if (y1 > pymax) { y1 = pymax; x1 = (e.c - y1) / e.a; }
      if (y1 < pymin) { y1 = pymin; x1 = (e.c - y1) / e.a; }
      if (y2 > pymax) { y2 = pymax; x2 = (e.c - y2) / e.a; }
      if (y2 < pymin) { y2 = pymin; x2 = (e.c - y2) / e.a; }
    }
    this.pushGraphEdge(e.reg[0], e.reg[1], x1, y1, x2, y2);
  }

  endPoint(e, lr, s) { e.ep[lr] = s; if (e.ep[RE - lr] == null) return; this.clipLine(e); }

  rightOf(el, p) {
    const e = el.ELedge, topsite = e.reg[1];
    const right_of_site = p.x > topsite.coord.x;
    if (right_of_site && el.ELpm === LE) return true;
    if (!right_of_site && el.ELpm === RE) return false;
    let above, fast = false;
    if (e.a === 1.0) {
      const dxp = p.x - topsite.coord.x, dyp = p.y - topsite.coord.y;
      if ((!right_of_site && e.b < 0.0) || (right_of_site && e.b >= 0.0)) { above = dyp >= e.b * dxp; fast = above; }
      else {
        above = p.x + p.y * e.b > e.c;
        if (e.b < 0.0) above = !above;
        if (!above) fast = true;
      }
      if (!fast) {
        const dxs = topsite.coord.x - e.reg[0].coord.x;
        above = e.b * (dxp * dxp - dyp * dyp) < dxs * dyp * (1.0 + 2.0 * dxp / dxs + e.b * e.b);
        if (e.b < 0) above = !above;
      }
    } else {
      const yl = e.c - e.a * p.x;
      const t1 = p.y - yl, t2 = p.x - topsite.coord.x, t3 = yl - topsite.coord.y;
      above = t1 * t1 > t2 * t2 + t3 * t3;
    }
    return el.ELpm === LE ? above : !above;
  }

  dist(s, t) { const dx = s.coord.x - t.coord.x, dy = s.coord.y - t.coord.y; return Math.sqrt(dx * dx + dy * dy); }

  intersect(el1, el2) {
    const e1 = el1.ELedge, e2 = el2.ELedge;
    if (e1 == null || e2 == null) return null;
    if (e1.reg[1] === e2.reg[1]) return null;
    const d = e1.a * e2.b - e1.b * e2.a;
    if (d > -1.0e-10 && d < 1.0e-10) return null;
    const xint = (e1.c * e2.b - e2.c * e1.b) / d;
    const yint = (e2.c * e1.a - e1.c * e2.a) / d;
    let el, e;
    if (e1.reg[1].coord.y < e2.reg[1].coord.y ||
      (e1.reg[1].coord.y === e2.reg[1].coord.y && e1.reg[1].coord.x < e2.reg[1].coord.x)) { el = el1; e = e1; }
    else { el = el2; e = e2; }
    const right_of_site = xint >= e.reg[1].coord.x;
    if ((right_of_site && el.ELpm === LE) || (!right_of_site && el.ELpm === RE)) return null;
    const v = new Site(); v.coord.x = xint; v.coord.y = yint; return v;
  }

  voronoiBD() {
    let newintstar = null;
    this.PQinitialize();
    this.ELinitialize();
    this.bottomsite = this.nextOne();
    let newsite = this.nextOne();
    let lbnd, rbnd, llbnd, rrbnd, bisector, e, bot, top, temp, p, v;
    while (true) {
      if (!this.PQempty()) newintstar = this.PQ_min();
      if (newsite != null && (this.PQempty() || newsite.coord.y < newintstar.y ||
        (newsite.coord.y === newintstar.y && newsite.coord.x < newintstar.x))) {
        lbnd = this.ELleftbnd(newsite.coord);
        rbnd = this.ELright(lbnd);
        bot = this.rightReg(lbnd);
        e = this.bisect(bot, newsite);
        bisector = this.HEcreate(e, LE);
        this.ELinsert(lbnd, bisector);
        if ((p = this.intersect(lbnd, bisector)) != null) { this.PQdelete(lbnd); this.PQinsert(lbnd, p, this.dist(p, newsite)); }
        lbnd = bisector;
        bisector = this.HEcreate(e, RE);
        this.ELinsert(lbnd, bisector);
        if ((p = this.intersect(bisector, rbnd)) != null) this.PQinsert(bisector, p, this.dist(p, newsite));
        newsite = this.nextOne();
      } else if (!this.PQempty()) {
        lbnd = this.PQextractmin();
        llbnd = this.ELleft(lbnd);
        rbnd = this.ELright(lbnd);
        rrbnd = this.ELright(rbnd);
        bot = this.leftReg(lbnd);
        top = this.rightReg(rbnd);
        v = lbnd.vertex; this.makeVertex(v);
        this.endPoint(lbnd.ELedge, lbnd.ELpm, v);
        this.endPoint(rbnd.ELedge, rbnd.ELpm, v);
        this.ELdelete(lbnd);
        this.PQdelete(rbnd);
        this.ELdelete(rbnd);
        let pm = LE;
        if (bot.coord.y > top.coord.y) { temp = bot; bot = top; top = temp; pm = RE; }
        e = this.bisect(bot, top);
        bisector = this.HEcreate(e, pm);
        this.ELinsert(llbnd, bisector);
        this.endPoint(e, RE - pm, v);
        if ((p = this.intersect(llbnd, bisector)) != null) { this.PQdelete(llbnd); this.PQinsert(llbnd, p, this.dist(p, bot)); }
        if ((p = this.intersect(bisector, rrbnd)) != null) this.PQinsert(bisector, p, this.dist(p, bot));
      } else break;
    }
    for (lbnd = this.ELright(this.elLeftend); lbnd !== this.elRightend; lbnd = this.ELright(lbnd))
      this.clipLine(lbnd.ELedge);
  }
}

if (typeof module !== 'undefined') module.exports = { poissonSamples, Voronoi };

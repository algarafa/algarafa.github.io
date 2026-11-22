/*
 * Sidebar figures. On desktop, the empty band of the sidebar between the
 * social icons and the copyright line shows one of three animated line
 * drawings from my research:
 *   quintic       a 2D slice of the Fermat quintic threefold, z1^5 + z2^5 = 1;
 *   elliptic      an elliptic fibre over a base surface, degenerating to a ring
 *                 of three spheres (Kodaira I3) over the discriminant curve;
 *   kaleidoscope  the Coxeter group of CICY 7669 tiling the hyperbolic plane
 *                 with copies of its Kähler cone, and the orbit of a point.
 * One figure is picked per visit (per tab) and its clock runs from the start
 * of the visit, so it carries on from page to page. Visitors who prefer
 * reduced motion see a still frame. Plain canvas, no dependencies.
 */
(() => {
  'use strict';

  const TAU = 2 * Math.PI, DEG = Math.PI / 180;
  const INK = { light: 'rgb(70,70,70)', dark: 'rgb(238,238,238)' };
  const smoothstep = (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };

  // ------------------------------------------------------- 3D line drawings

  // build(t) gives polylines [{ p: [x, y, z, ...], kind }], kind being
  // undefined, 'faint', 'strong' or 'dot'; view(t) gives [spin, tilt, roll,
  // camera distance]. The drawing is fitted to its box from its envelope over
  // one whole cycle, so it never leaves the box; aspect = envelope width/height.
  const ALPHA3D = { light: [0.1, 0.72], dark: [0.08, 0.66] };
  function lines3d({ build, view, cycle, step, depth, dot = 2.2 }) {
    const project = (t, f) => {
      const [th, tilt, roll, dist] = view(t);
      const ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(tilt), sp = Math.sin(tilt);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      for (const line of build(t)) {
        const p = line.p;
        for (let o = 0; o < p.length; o += 3) {
          const x = ct * p[o] - st * p[o + 1], y = st * p[o] + ct * p[o + 1];
          const up = cp * p[o + 2] + sp * y, near = sp * p[o + 2] - cp * y;
          const k = dist / (dist - near);
          f(line, o, (cr * x - sr * up) * k, (sr * x + cr * up) * k, near);
        }
      }
    };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let t = 0; t < cycle; t += step) {
      project(t, (line, o, x, y) => {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      });
    }
    const K = 7; // depth levels: nearer lines are drawn stronger
    const level = (near) => Math.min(K - 1, Math.max(0, Math.floor(((near + depth) / (2 * depth)) * K)));
    return {
      aspect: (x1 - x0) / (y1 - y0),
      draw(ctx, w, h, t, theme) {
        const S = 0.92 * Math.min(w / (x1 - x0), h / (y1 - y0));
        const cx = w / 2 - S * (x0 + x1) / 2, cy = h / 2 + S * (y0 + y1) / 2;
        const sets = { line: [], faint: [], strong: [] };
        for (const s of Object.values(sets)) for (let k = 0; k < K; k++) s.push(new Path2D());
        const dots = [];
        let px = 0, py = 0, pn = 0;
        project(t, (line, o, x, y, near) => {
          const sx = cx + S * x, sy = cy - S * y;
          if (line.kind === 'dot') dots.push([sx, sy, level(near)]);
          else if (o > 0) {
            const path = sets[line.kind || 'line'][level((pn + near) / 2)];
            path.moveTo(px, py);
            path.lineTo(sx, sy);
          }
          px = sx; py = sy; pn = near;
        });
        const [a0, a1] = ALPHA3D[theme];
        const alpha = (k) => a0 + ((a1 - a0) * k) / (K - 1);
        ctx.strokeStyle = ctx.fillStyle = INK[theme];
        ctx.lineCap = 'round';
        for (let k = 0; k < K; k++) {
          ctx.lineWidth = 0.75;
          ctx.globalAlpha = alpha(k);
          ctx.stroke(sets.line[k]);
          ctx.globalAlpha = alpha(k) * 0.6;
          ctx.stroke(sets.faint[k]);
          ctx.lineWidth = 1.15;
          ctx.globalAlpha = Math.min(1, alpha(k) * 1.4);
          ctx.stroke(sets.strong[k]);
        }
        for (const [x, y, k] of dots) {
          ctx.globalAlpha = Math.min(1, alpha(k) * 1.4);
          ctx.beginPath();
          ctx.arc(x, y, dot, 0, TAU);
          ctx.fill();
        }
      },
    };
  }

  // ----------------------------------------------------------- the quintic

  // The complex curve z1^5 + z2^5 = 1 (Hanson's construction): z1 = w^k1
  // cos(u)^(2/5), z2 = w^k2 sin(u)^(2/5), u = a + ib, w = e^(2 pi i / 5), 25
  // patches, drawn in R^3 as (Re z1, Re z2, cos(al) Im z1 + sin(al) Im z2).
  // The five-fold star only shows near al = spin = 45 deg, so the slice angle
  // al breathes +-40 deg around it while the figure turns in the plane of the
  // screen (which never changes its shape).
  function quintic() {
    const NA = 8, NB = 12, BMAX = 1.1;
    const cpow = (re, im, p) => {
      const r = Math.hypot(re, im);
      if (r < 1e-12) return [0, 0];
      const a = Math.atan2(im, re) * p, m = r ** p;
      return [m * Math.cos(a), m * Math.sin(a)];
    };
    const patches = [];
    let depth = 0;
    for (let k1 = 0; k1 < 5; k1++) {
      for (let k2 = 0; k2 < 5; k2++) {
        const c1 = Math.cos((TAU * k1) / 5), s1 = Math.sin((TAU * k1) / 5);
        const c2 = Math.cos((TAU * k2) / 5), s2 = Math.sin((TAU * k2) / 5);
        const z = [];
        for (let i = 0; i <= NA; i++) {
          const a = ((Math.PI / 2) * i) / NA, ca = Math.cos(a), sa = Math.sin(a);
          for (let j = 0; j <= NB; j++) {
            const b = BMAX * ((2 * j) / NB - 1), ch = Math.cosh(b), sh = Math.sinh(b);
            const [ur, ui] = cpow(ca * ch, -sa * sh, 0.4); // cos(u)^(2/5)
            const [vr, vi] = cpow(sa * ch, ca * sh, 0.4); //  sin(u)^(2/5)
            const q = [ur * c1 - ui * s1, ur * s1 + ui * c1, vr * c2 - vi * s2, vr * s2 + vi * c2];
            depth = Math.max(depth, Math.hypot(q[0], q[2], Math.hypot(q[1], q[3])));
            z.push(...q);
          }
        }
        patches.push(Float64Array.from(z)); // (Re z1, Im z1, Re z2, Im z2) per vertex
      }
    }
    // each patch's mesh lines in both directions, as views into two flat arrays
    const build = (t) => {
      const al = 45 * DEG + 40 * DEG * Math.sin((TAU * t) / 40);
      const ca = Math.cos(al), sa = Math.sin(al), n = (NA + 1) * (NB + 1);
      const out = [];
      for (const z of patches) {
        const rows = new Float64Array(3 * n), cols = new Float64Array(3 * n);
        for (let i = 0; i <= NA; i++) {
          for (let j = 0; j <= NB; j++) {
            const q = 4 * (i * (NB + 1) + j), r = 3 * (i * (NB + 1) + j), c = 3 * (j * (NA + 1) + i);
            rows[r] = cols[c] = z[q];
            rows[r + 1] = cols[c + 1] = z[q + 2];
            rows[r + 2] = cols[c + 2] = ca * z[q + 1] + sa * z[q + 3];
          }
        }
        for (let i = 0; i <= NA; i++) out.push({ p: rows.subarray(3 * i * (NB + 1), 3 * (i + 1) * (NB + 1)) });
        for (let j = 0; j <= NB; j++) out.push({ p: cols.subarray(3 * j * (NA + 1), 3 * (j + 1) * (NA + 1)) });
      }
      return out;
    };
    return lines3d({ build, view: (t) => [45 * DEG, 0.42, (TAU * t) / 80, 7], cycle: 80, step: 1, depth });
  }

  // ---------------------------------------------------------- the elliptic

  // An I3 fibre floating over a base surface: its base point travels along a
  // path that crosses the discriminant curve, and the fibre (a torus) pinches
  // into a ring of three spheres as the point reaches it. A topological
  // picture: the tube radius is r(phi) ~ sqrt(1 - p + p sin^2(3 phi / 2)).
  function elliptic() {
    const BASE = -0.85, FIBRE = BASE + 1.05;
    const sampled = (f, a, b, n) => {
      const p = [];
      for (let m = 0; m <= n; m++) p.push(...f(a + ((b - a) * m) / n));
      return p;
    };
    const path = (s) => [0.95 * s, 0.32 * s + 0.12 * s * s, BASE];
    const discriminant = sampled((u) => [0.22 * Math.sin(2.4 * u), 0.95 * u, BASE], -1, 1, 80);
    const route = sampled(path, -1.15, 1.15, 60);
    const X = 1.35, Y = 1.05;
    const plane = [-X, -Y, BASE, X, -Y, BASE, X, Y, BASE, -X, Y, BASE, -X, -Y, BASE];
    const torus = (out, [cx, cy, cz], pinch, phase) => {
      const point = (phi, psi) => {
        const r = 0.3 * Math.sqrt(1 - pinch + pinch * Math.sin((3 * (phi - phase)) / 2) ** 2);
        const ring = 0.56 + r * Math.cos(psi);
        return [cx + ring * Math.cos(phi), cy + ring * Math.sin(phi), cz + r * Math.sin(psi)];
      };
      for (let j = 0; j < 30; j++) {
        const p = [];
        for (let k = 0; k <= 20; k++) p.push(...point((TAU * j) / 30 + phase, (TAU * k) / 20));
        out.push({ p, kind: j % 10 === 0 ? 'strong' : undefined }); // the three vanishing cycles
      }
      for (let k = 0; k < 10; k++) {
        const p = [];
        for (let j = 0; j <= 90; j++) p.push(...point((TAU * j) / 90 + phase, (TAU * k) / 10));
        out.push({ p });
      }
    };
    const build = (t) => {
      // the base point lingers near the discriminant (s = 0) and the path's ends
      const [bx, by] = path(Math.sin((TAU * t) / 20) ** 3);
      let d = Infinity;
      for (let o = 0; o < discriminant.length; o += 3) {
        d = Math.min(d, Math.hypot(discriminant[o] - bx, discriminant[o + 1] - by));
      }
      const out = [
        { p: plane },
        { p: discriminant, kind: 'strong' },
        { p: route, kind: 'faint' },
        { p: [bx, by, FIBRE, bx, by, BASE], kind: 'faint' },
        { p: [bx, by, BASE], kind: 'dot' },
      ];
      torus(out, [bx, by, FIBRE], 1 - smoothstep(0, 0.55, d / 0.95), (TAU * t) / 60);
      return out;
    };
    return lines3d({ build, view: () => [0, 0.42, 0, 16], cycle: 60, step: 0.5, depth: 1.85 });
  }

  // ------------------------------------------------------ the kaleidoscope

  // CICY 7669 (h11 = 3; three iso-flop walls, every pair of mirrors of type P).
  // Its KahlerRefGens act on the Kahler parameters t and preserve
  // B(t, t) = -2 (t1 t2 + t2 t3 + t3 t1), of signature (1, 2); the Kahler cone
  // t_i > 0 is an ideal triangle in the hyperbolic plane, and its mirror images
  // tile the whole Poincare disc. A point tours the disc along three motions
  // (a wave along the axis of the glide reflection s1 s2 s3, a drift beside
  // that axis, a loop round a cusp), blended at each hand-off; every mirror
  // image of it is drawn, with a trail.
  function kaleidoscope() {
    const GENS = [
      [[-1, 0, 0], [2, 1, 0], [2, 0, 1]],
      [[1, 2, 0], [0, -1, 0], [0, 2, 1]],
      [[1, 0, 2], [0, 1, 2], [0, 0, -1]],
    ];
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    const app = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    const lin = (a, x, b, y) => x.map((xi, i) => a * xi + b * y[i]);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const Bf = (a, b) => -(a[0] * (b[1] + b[2]) + a[1] * (b[0] + b[2]) + a[2] * (b[0] + b[1]));
    const Binv = (v) => v.map((x) => x - (v[0] + v[1] + v[2]) / 2);
    const unit = (v) => v.map((x) => x / Math.sqrt(-Bf(v, v)));
    const dist = (a, b) => Math.acosh(Math.max(1, -Bf(a, b)));
    // Minkowski frame centred on the incentre of the Kahler cone, (1,1,1)/sqrt6
    const S2 = Math.SQRT2, S6 = Math.sqrt(6);
    const mink = (t) => [(t[0] + t[1] + t[2]) * Math.sqrt(2 / 3), (t[0] - t[1]) / S2, (t[0] + t[1] - 2 * t[2]) / S6];
    const fromMink = ([x0, x1, x2]) => [x0 / S6 + x1 / S2 + x2 / S6, x0 / S6 - x1 / S2 + x2 / S6, (x0 - 2 * x2) / S6];
    const disc = (t) => {
      const [y0, y1, y2] = mink(t), n = Math.sqrt(Math.max(0, y0 * y0 - y1 * y1 - y2 * y2));
      return [y1 / (n + y0), y2 / (n + y0)];
    };
    // reflect t back into the Kahler cone, returning the element used
    const reduce = (t) => {
      let r = I, v = t;
      for (let k, n = 0; n < 200 && (k = v.findIndex((x) => x < -1e-12)) >= 0; n++) {
        v = app(GENS[k], v);
        r = mul(GENS[k], r);
      }
      return { r, v };
    };
    const words = (L) => {
      let all = [{ M: I, last: -1 }], front = all;
      for (let d = 0; d < L; d++) {
        front = front.flatMap((e) => [0, 1, 2].filter((k) => k !== e.last).map((k) => ({ M: mul(e.M, GENS[k]), last: k })));
        all = all.concat(front);
      }
      return all.map((e) => e.M);
    };
    const W3 = words(3), W5 = words(5);
    const closest = (ref, q, set) => {
      let best = { d: Infinity };
      set.forEach((M, i) => {
        const v = app(M, q), d = dist(ref, v);
        if (d < best.d) best = { v, d, i };
      });
      return best;
    };
    // where a track is heading: its last step repeated, so that at a wall it
    // continues across instead of folding back onto its mirror image
    const ahead = (a, b) => (b ? unit(lin(2, a, -1, b)) : a);
    // the copy of q that continues a track heading for `to`: q itself except
    // where the track has just crossed a wall
    const follow = (to, q) => (dist(to, q) < 1e-3 ? { v: q, i: 0 } : closest(to, q, W3));

    // the axis of the glide reflection h = s1 s2 s3: lightlike eigenvectors
    // l+, l- (eigenvalues lam, 1/lam) and unit normal n; h maps the point at
    // signed distance d from the axis at tau to the one at -d, tau + log lam
    const H = mul(mul(GENS[0], GENS[1]), GENS[2]);
    const sum = H[0][0] + H[1][1] + H[2][2] + 1;
    const lam = (sum + Math.sqrt(sum * sum - 4)) / 2, len = Math.log(lam);
    const eigen = (mu) => {
      const A = H.map((r, i) => r.map((x, j) => x - (i === j ? mu : 0)));
      const v = [cross(A[0], A[1]), cross(A[0], A[2]), cross(A[1], A[2])].sort((a, b) => Math.hypot(...b) - Math.hypot(...a))[0];
      return mink(v)[0] < 0 ? v.map((x) => -x) : v;
    };
    let lp = eigen(lam), lm = eigen(1 / lam);
    const scale = Math.sqrt(-2 * Bf(lp, lm));
    lp = lp.map((x) => x / scale);
    lm = lm.map((x) => x / scale);
    const nrm = Binv(cross(lp, lm)), n = nrm.map((x) => x / Math.sqrt(Bf(nrm, nrm)));
    const axisPoint = (tau, offset) => {
      const k = Math.floor(tau / len), u = tau - k * len, d = offset(u, k % 2 !== 0);
      return lin(Math.cosh(d), lin(Math.exp(u), lp, Math.exp(-u), lm), Math.sinh(d), n);
    };
    const speed = len / 26; // one translation length every 26 s
    const wave = (t) => axisPoint(speed * t, (u) => 0.34 * Math.sin((3 * Math.PI * u) / len));
    const beside = (t) => axisPoint(speed * t, (u, odd) => (odd ? -0.34 : 0.34));

    // the horocycle through the incentre round the cusp e1, which the
    // parabolic s2 s3 moves along itself by delta
    const T0 = fromMink([1, 0, 0]), l = [1, 0, 0], m = [0, 1, 0];
    const wv = Binv(cross(l, m)), w = wv.map((x) => x / Math.sqrt(Bf(wv, wv)));
    const c = -Bf(l, T0), u0 = Bf(w, T0);
    const horo = (u) => [0, 1, 2].map((i) => ((u * u + 1) / (2 * c)) * l[i] + c * m[i] + u * w[i]);
    const delta = Bf(w, app(mul(GENS[1], GENS[2]), horo(u0))) - u0;
    const Th = Math.abs(delta) / 0.11;
    const cusp = (t) => horo(u0 + delta * (t / Th - Math.floor(t / Th)));

    // The tour. Each phase starts at `at`; its first 10 s blend in from the
    // previous one along the geodesic between the two, each motion being paired
    // with the mirror image of the next that runs closest to it. The clock
    // shifts make the motions run together through each blend (found by
    // searching for the closest run over the whole 10 s); the loop ends on a
    // whole number of wave periods, so it closes up.
    const PHASES = [[wave, 0, 0], [beside, 30, 0], [cusp, 72, 8.4], [wave, 118, 15.4]];
    const BLEND = 10;
    const Lc = 15.4 + 26 * Math.ceil((118 + BLEND + 20 - 15.4) / 26);
    const rep = (p, t) => unit(reduce(PHASES[p][0](t - PHASES[p][2])).v);
    const N = Math.round(Lc * 30), dt = Lc / N;
    const pts = [];
    for (let i = 0, p = 0; i < N; i++) {
      while (p < 3 && i * dt >= PHASES[p + 1][1]) p++;
      if (p === 0 || i * dt >= PHASES[p][1] + BLEND) pts[i] = rep(p, i * dt); // blends below
    }
    for (let p = 1; p < 4; p++) {
      const from = PHASES[p][1], i0 = Math.ceil(from / dt), i1 = Math.floor((from + BLEND) / dt);
      const im = Math.round((from + BLEND / 2) / dt);
      const a = { [im]: rep(p - 1, im * dt) }, b = { [im]: closest(a[im], rep(p, im * dt), W5).v };
      for (const s of [1, -1]) {
        for (let i = im + s; i >= i0 && i <= i1; i += s) {
          a[i] = follow(ahead(a[i - s], a[i - 2 * s]), rep(p - 1, i * dt)).v;
          b[i] = follow(ahead(b[i - s], b[i - 2 * s]), rep(p, i * dt)).v;
        }
      }
      for (let i = i0; i <= i1; i++) {
        const x = a[i], y = b[i], d = dist(x, y), f = smoothstep(0, 1, (i * dt - from) / BLEND);
        const g = d < 1e-9 ? x : lin(Math.sinh((1 - f) * d) / Math.sinh(d), x, Math.sinh(f * d) / Math.sinh(d), y);
        pts[i] = unit(reduce(g).v);
      }
    }
    // The samples are stored inside the Kahler cone (small numbers); step[i]
    // relates sample i to the continuation of sample i - 1 (the seam included).
    const inv = W3.map((M) => {
      const [[a1, b1, c1], [d1, e1, f1], [g1, h1, i1]] = M;
      const A = e1 * i1 - f1 * h1, Bc = f1 * g1 - d1 * i1, C = d1 * h1 - e1 * g1, det = a1 * A + b1 * Bc + c1 * C;
      return [[A, c1 * h1 - b1 * i1, b1 * f1 - c1 * e1], [Bc, a1 * i1 - c1 * g1, c1 * d1 - a1 * f1], [C, b1 * g1 - a1 * h1, a1 * e1 - b1 * d1]]
        .map((r) => r.map((x) => Math.round(x / det)));
    });
    const step = new Uint8Array(N), at = (i) => pts[(i + N) % N];
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < (pass ? 3 : N); i++) {
        const before = pass || i > 1 ? app(inv[step[(i - 1 + N) % N]], at(i - 2)) : undefined;
        step[i] = follow(ahead(at(i - 1), before), pts[i]).i;
      }
    }
    // the head at time t, and the trail behind it, in the head's frame
    const tour = (t, samples, seconds) => {
      const x = (((t % Lc) + Lc) % Lc) / dt, i = Math.floor(x) % N, f = x - Math.floor(x);
      const head = unit(lin(1 - f, pts[i], f, app(W3[step[(i + 1) % N]], at(i + 1))));
      const trail = [head];
      let M = I;
      for (let s = 1, j = i, moved = 0; s <= samples; s++) {
        for (; moved < Math.round((s * seconds) / samples / dt); moved++, j = (j - 1 + N) % N) {
          if (step[j]) M = mul(M, inv[step[j]]);
        }
        trail.push(app(M, pts[j]));
      }
      return { head, trail };
    };

    // The tiling, kept to the walls that are visible at the figure's largest
    // size: the chambers form a tree (the group is a free product of three Z2),
    // and a whole branch is skipped when the wall it hangs from is under a
    // quarter of a pixel (everything beyond it is smaller still). Found on the
    // first drawing, so that building the figure and drawing it first stay two
    // short tasks.
    const RMAX = 0.46 * 220, RHO = 0.06, TRAIL = 16, SAMPLES = 64;
    const RAYS = [0, 1, 2].map((k) => [I[(k + 1) % 3], I[(k + 2) % 3]]); // wall k = {t_k = 0}
    let walls, images, trailed;
    const visible = () => {
      const els = [];
      walls = [];
      for (const stack = [{ M: I, last: -1, chord: Infinity }]; stack.length; ) {
        const e = stack.pop();
        els.push(e);
        for (let k = 0; k < 3; k++) {
          if (k === e.last) continue;
          const [a, b] = RAYS[k].map((ray) => disc(app(e.M, ray)));
          const chord = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (chord * RMAX < 0.25) continue;
          walls.push([a, b, chord]);
          stack.push({ M: mul(e.M, GENS[k]), last: k, chord });
        }
      }
      // an image of the point has radius under ~ rho/2 x its chamber's wall
      images = els.filter((e) => e.chord * RMAX * (RHO / 2) * 1.5 >= 0.15);
      trailed = els.filter((e) => e.chord * RMAX >= 3);
    };

    const ALPHA = { light: [0.14, 0.75], dark: [0.12, 0.7] };
    let cache = null, cacheKey = '';
    const tiling = (ctx, w, h, theme) => {
      const R = 0.46 * Math.min(w, h), cx = w / 2, cy = h / 2, [a0, a1] = ALPHA[theme];
      const paths = Array.from({ length: 12 }, () => new Path2D());
      for (const [a, b, chord] of walls) {
        const px = chord * R, strength = smoothstep(0.25, 3, px) * (0.35 + 0.65 * Math.min(1, chord / 1.2) ** 0.6);
        if (strength <= 0) continue;
        const path = paths[Math.min(11, Math.floor(strength * 12))], dot = a[0] * b[0] + a[1] * b[1];
        path.moveTo(cx + R * a[0], cy - R * a[1]);
        if (dot < -0.9995 || px < 3) path.lineTo(cx + R * b[0], cy - R * b[1]);
        else {
          // the geodesic: the circle through a and b orthogonal to the rim
          const ox = (a[0] + b[0]) / (1 + dot), oy = (a[1] + b[1]) / (1 + dot);
          const ta = Math.atan2(oy - a[1], a[0] - ox), tb = Math.atan2(oy - b[1], b[0] - ox);
          path.arc(cx + R * ox, cy - R * oy, R * Math.sqrt((1 - dot) / (1 + dot)), ta, tb, Math.sin(tb - ta) < 0);
        }
      }
      ctx.strokeStyle = INK[theme];
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.75;
      paths.forEach((path, k) => {
        ctx.globalAlpha = 0.55 * (a0 + ((a1 - a0) * (k + 0.5)) / 12);
        ctx.stroke(path);
      });
      ctx.globalAlpha = Math.min(1, a1 * 1.2);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
    };
    const circumcircle = ([a, b, c]) => {
      const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
      if (Math.abs(d) < 1e-18) return null;
      const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
      const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
      const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
      return [x, y, Math.hypot(a[0] - x, a[1] - y)];
    };

    return {
      aspect: 1,
      draw(ctx, w, h, t, theme) {
        // the tiling is drawn once per size and theme, then reused
        if (!walls) visible();
        const key = [w, h, theme, ctx.canvas.width].join();
        if (key !== cacheKey) {
          cache = Object.assign(document.createElement('canvas'), { width: ctx.canvas.width, height: ctx.canvas.height });
          const c2 = cache.getContext('2d');
          c2.setTransform(ctx.getTransform());
          tiling(c2, w, h, theme);
          cacheKey = key;
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(cache, 0, 0);
        ctx.restore();

        const R = 0.46 * Math.min(w, h), cx = w / 2, cy = h / 2, [, a1] = ALPHA[theme];
        const { head, trail } = tour(t, SAMPLES, TRAIL);
        const { r, v } = reduce(head);
        // three points at distance RHO round the head: their images fix the
        // image of the small disc that stands for the point
        const [x0, x1, x2] = mink(v), eta = Math.acosh(Math.max(1, x0)), phi = Math.atan2(x2, x1);
        const ring = [0, 1, 2].map((k) => {
          const q = [Math.cosh(RHO), Math.sinh(RHO) * Math.cos((TAU * k) / 3), Math.sinh(RHO) * Math.sin((TAU * k) / 3)];
          const along = q[1] * Math.cos(phi) + q[2] * Math.sin(phi), across = -q[1] * Math.sin(phi) + q[2] * Math.cos(phi);
          const y0 = Math.cosh(eta) * q[0] + Math.sinh(eta) * along, y1 = Math.sinh(eta) * q[0] + Math.cosh(eta) * along;
          return fromMink([y0, y1 * Math.cos(phi) - across * Math.sin(phi), y1 * Math.sin(phi) + across * Math.cos(phi)]);
        });
        // images fade in and out with their size (never a hard cut-off)
        const dotPaths = Array.from({ length: 24 }, () => new Path2D()), size = new Map();
        for (const e of images) {
          const o = circumcircle(ring.map((p) => disc(app(e.M, p))));
          if (!o) continue;
          const px = o[2] * R, k = Math.min(23, Math.floor(smoothstep(0.15, 1.6, px) * 24));
          size.set(e, px);
          if (k < 0 || px < 0.15) continue;
          dotPaths[k].moveTo(cx + R * (o[0] + o[2]), cy - R * o[1]);
          dotPaths[k].arc(cx + R * o[0], cy - R * o[1], Math.max(px, 0.5), 0, TAU);
        }
        // trails: the recent path, carried by every visible image, fading with age
        const path = trail.map((p) => app(r, p)), trailPaths = Array.from({ length: 10 }, () => new Path2D());
        for (const e of trailed) {
          const px = size.get(e);
          if (!px || px < 0.4) continue;
          const fade = smoothstep(0.4, 2, px), stride = px > 3 ? 1 : px > 1.5 ? 2 : 4;
          let prev = null;
          for (let j = 0; j <= SAMPLES; j += stride) {
            const d = disc(app(e.M, path[j])), q = [cx + R * d[0], cy - R * d[1]];
            if (prev) {
              const k = Math.min(9, Math.floor((1 - j / SAMPLES) * fade * 10));
              trailPaths[k].moveTo(prev[0], prev[1]);
              trailPaths[k].lineTo(q[0], q[1]);
            }
            prev = q;
          }
        }
        ctx.strokeStyle = ctx.fillStyle = INK[theme];
        ctx.lineCap = 'round';
        ctx.lineWidth = 0.9;
        trailPaths.forEach((p, k) => {
          ctx.globalAlpha = a1 * 0.8 * ((k + 0.5) / 10);
          ctx.stroke(p);
        });
        dotPaths.forEach((p, k) => {
          ctx.globalAlpha = a1 * ((k + 0.5) / 24);
          ctx.fill(p);
        });
      },
    };
  }

  // ------------------------------------------------------------- the page

  // pose: where each figure starts on the first page of a visit (and the still
  // frame for reduced motion)
  const FIGURES = {
    quintic: { make: quintic, pose: 0 },
    elliptic: { make: elliptic, pose: 0 },
    kaleidoscope: { make: kaleidoscope, pose: 12.5 },
  };

  function start() {
    const sidebar = document.querySelector('.sidebar');
    const icons = sidebar && sidebar.querySelector('.sidebar__list');
    const note = sidebar && sidebar.querySelector('.footer__sidebar .footer__item');
    if (!icons || !note) return;

    // one figure per visit (this tab), and a clock from the start of the visit
    const names = Object.keys(FIGURES);
    let name = names[Math.floor(Math.random() * names.length)], since = Date.now(), kept = null;
    try {
      kept = sessionStorage.getItem('sidebar-figure');
      if (FIGURES[kept]) name = kept;
      else sessionStorage.setItem('sidebar-figure', name);
      since = Number(sessionStorage.getItem('sidebar-figure-since')) || since;
      sessionStorage.setItem('sidebar-figure-since', String(since));
    } catch (e) {
      // no storage: a new pick on each page
    }
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { make, pose } = FIGURES[name];
    const run = (figure) => show(sidebar, icons, note, figure, pose, since, still);
    const later = () => {
      const figure = make();
      requestAnimationFrame(() => run(figure));
    };
    // Carrying on from the previous page, the figure is built and drawn at once,
    // before the page first paints, so it never blinks out between pages. On the
    // first page of a visit there is nothing to carry on from: it is built when
    // the browser is idle and drawn a frame later, two short tasks that never
    // delay the page.
    if (name === kept) run(make());
    else if (window.requestIdleCallback) requestIdleCallback(later, { timeout: 1000 });
    else setTimeout(later, 0);
  }

  function show(sidebar, icons, note, figure, pose, since, still) {
    const root = document.documentElement;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;display:none';
    sidebar.appendChild(canvas);
    let w = 0, h = 0;
    const draw = () => {
      if (!w) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
      const t = still ? pose : pose + (Date.now() - since) / 1000;
      figure.draw(ctx, w, h, t, root.classList.contains('theme--dark') ? 'dark' : 'light');
    };

    // The visible edges of the icons above and of the copyright line below: a
    // line's baseline from a zero-size inline-block marker (its bottom sits on
    // the baseline), the glyphs' extents from the fonts' own metrics.
    const meter = document.createElement('canvas').getContext('2d');
    const baseline = (el, first) => {
      const mark = document.createElement('span');
      mark.style.cssText = 'display:inline-block;width:0;height:0';
      first ? el.prepend(mark) : el.append(mark);
      const y = mark.getBoundingClientRect().bottom;
      mark.remove();
      return y;
    };
    const glyphs = (el, pseudo, text) => {
      const s = getComputedStyle(el, pseudo);
      meter.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      return meter.measureText(text);
    };
    const layout = () => {
      w = 0;
      canvas.style.display = 'none';
      if (getComputedStyle(sidebar).position !== 'fixed') return; // phone/tablet: no figure
      let top = -Infinity;
      for (const i of icons.querySelectorAll('i')) {
        const glyph = getComputedStyle(i, '::before').content.slice(1, -1);
        top = Math.max(top, baseline(i) + glyphs(i, '::before', glyph).actualBoundingBoxDescent);
      }
      const bottom = baseline(note, true) - glyphs(note, null, note.textContent.trim()).actualBoundingBoxAscent;
      const s = sidebar.getBoundingClientRect(), box = icons.getBoundingClientRect();
      // the height is the same for every figure (at most 220 px, at least 24 px
      // of white space above and below, hidden under 90 px); the width follows
      // the figure's shape
      const size = Math.min(220, bottom - top - 48, (s.width - 48) / figure.aspect);
      if (size < 90) return;
      // Crisp lines: position and size on whole device pixels that the browser
      // can also store exactly (it keeps positions in 1/64 px), so the drawing
      // is never resampled: steps of 1 px at 100%, 2 px at 150%, 4 px at 125%.
      const dpr = window.devicePixelRatio || 1;
      let grid = 1 / dpr;
      for (let k = 1; k <= 64; k++) {
        if (Math.abs(((k / dpr) * 64) % 1) < 1e-6 || Math.abs(((k / dpr) * 64) % 1) > 1 - 1e-6) { grid = k / dpr; break; }
      }
      const snap = (x) => Math.round(x / grid) * grid;
      h = Math.floor(size / grid) * grid;
      w = snap(h * figure.aspect);
      Object.assign(canvas.style, {
        display: 'block',
        width: `${w}px`,
        height: `${h}px`,
        left: `${snap(box.left + box.width / 2 - w / 2) - s.left}px`,
        top: `${snap(top + (bottom - top - h) / 2) - s.top}px`, // equal white space above and below
      });
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      draw();
    };
    layout();
    window.addEventListener('resize', layout); // also on zoom
    if (document.fonts) document.fonts.ready.then(layout); // icon glyph metrics
    new MutationObserver(draw).observe(root, { attributes: true, attributeFilter: ['class'] }); // theme switch
    if (!still) {
      // 30 frames per second; requestAnimationFrame pauses in background tabs
      let last = 0;
      const loop = (now) => {
        requestAnimationFrame(loop);
        if (now - last < 1000 / 30 - 2) return;
        last = now;
        draw();
      };
      requestAnimationFrame(loop);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

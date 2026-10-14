/*
 * 3D preview of the printed paper.
 *
 * Scene: #world holds your view of things (any rotation, all the way round).
 * Inside it, #scene holds the printed sheets: a stack still to read, and the
 * sheets already turned over, lying back-up beside the stack on the side they
 * were turned to. (Or, folded, #book holds the booklet.)
 *
 * Dragging the top sheet turns it over on a hinge: left/right like a book
 * page, up/down like a calendar page. It lands beside the stack and the next
 * sheet shows. Dragging the last turned sheet brings it back. Dragging
 * anywhere else rotates the whole view.
 *
 * Which side you see and which way up each page looks are worked out from
 * the actual 3D rotation, so they stay right from any angle.
 */
(function () {
  'use strict';

  var L = window.PrintLayout;
  function $(id) { return document.getElementById(id); }

  var stage = $('stage'), world = $('world'), scene = $('scene'), bookEl = $('book');
  var readout = $('readout'), pos = $('pos');

  var TURN_MS = 560, FOLD_MS = 1400, VIEW_MS = 500;
  var DRAG_START_PX = 8, DEG_PER_PX = 0.25;
  var GAP = 1.6, MAX_LAYERS = 10;   // px between stacked sheets; most sheets drawn per pile

  var job = null, settings = null, book = null, leaves = [];
  var view = freshView();
  var busy = false, drag = null;
  var k = 1;                                  // screen pixels per millimetre of paper
  var topEl = null, topZ = 0, stackDrawn = 0; // the sheet on top of the stack
  var pileEls = {}, pileZ = {}, pileDrawn = {};

  function homeView() { return qmul(quat([1, 0, 0], 22), quat([0, 1, 0], -18)); }
  function freshView() {
    return {
      mode: 'flat', q: homeView(),
      sheet: 0,        // the sheet on top of the stack; sheets before it are turned over
      hinges: [],      // which way each turned sheet was turned: 'L', 'R', 'T' or 'B'
      frame: { cx: 0, cy: 0, zoom: 1 },
      leaf: 0, lastTurn: null
    };
  }

  // --- small helpers -----------------------------------------------------

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function px(v) { return v + 'px'; }
  function place(e, x, y, w, h) {
    e.style.left = px(x); e.style.top = px(y);
    e.style.width = px(w); e.style.height = px(h);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rad(d) { return d * Math.PI / 180; }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // Runs step(0..1) once per frame for ms milliseconds.
  function tween(ms, step, done) {
    busy = true;
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
      step(ease(t));
      if (t < 1) { requestAnimationFrame(frame); return; }
      busy = false;
      if (done) done();
    }
    requestAnimationFrame(frame);
  }

  // --- 3D maths, in CSS's axes: x right, y down, z towards you ------------------

  function rx(a) { var c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
  function ry(a) { var c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
  function rz(a) { var c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
  function mul(A, B) {
    var M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) for (var n = 0; n < 3; n++) M[i][j] += A[i][n] * B[n][j];
    return M;
  }
  function apply(M, v) {
    return [0, 1, 2].map(function (i) { return M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]; });
  }

  // Quaternions [w, x, y, z]; the view is one, so it can turn any way without getting stuck.
  function quat(axis, deg) {
    var s = Math.sin(rad(deg) / 2);
    return [Math.cos(rad(deg) / 2), axis[0] * s, axis[1] * s, axis[2] * s];
  }
  function qmul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
  }
  function qnorm(q) {
    var l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    return q.map(function (v) { return v / l; });
  }
  function qmat(q) {
    var w = q[0], x = q[1], y = q[2], z = q[3];
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
    ];
  }
  function slerp(a, b, t) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map(function (v) { return -v; }); d = -d; }
    if (d > 0.9995) return qnorm(a.map(function (v, i) { return v + (b[i] - v) * t; }));
    var th = Math.acos(d), s = Math.sin(th);
    var wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map(function (v, i) { return wa * v + wb * b[i]; });
  }

  function applyView() {
    var m = qmat(view.q);
    world.style.transform = 'matrix3d(' + [
      m[0][0], m[1][0], m[2][0], 0,
      m[0][1], m[1][1], m[2][1], 0,
      m[0][2], m[1][2], m[2][2], 0,
      0, 0, 0, 1
    ].join(',') + ')';
  }

  // A pointer movement on screen, measured along the paper's own x and y axes
  // (in px of the scene). null when the paper is seen edge-on.
  function toPaper(dx, dy) {
    var R = qmat(view.q), ex = [R[0][0], R[1][0]], ey = [R[0][1], R[1][1]];
    var det = ex[0] * ey[1] - ey[0] * ex[1];
    if (Math.abs(det) < 0.08) return null;
    var z = view.mode === 'flat' ? view.frame.zoom : 1;
    return { x: (dx * ey[1] - dy * ey[0]) / det / z, y: (ex[0] * dy - ex[1] * dx) / det / z };
  }

  // Where the pointer meets the plane of the paper, in the paper's own px
  // (0,0 = centre of the view). Worked out from the view and the stage's
  // perspective rather than from the element under the pointer, which
  // browsers report unreliably for 3D-transformed elements.
  function toPlane(clientX, clientY) {
    var sr = stage.getBoundingClientRect(), P = parseFloat(getComputedStyle(stage).perspective) || 1400;
    var x = clientX - (sr.left + sr.width / 2), y = clientY - (sr.top + sr.height / 2);
    var R = qmat(view.q), n = [R[0][2], R[1][2], R[2][2]];
    var den = n[0] * x + n[1] * y - n[2] * P;
    if (Math.abs(n[2]) < 0.05 || Math.abs(den) < 1e-6) return null;
    var t = -n[2] * P / den;
    if (t <= 0) return null;
    var q = [t * x, t * y, P * (1 - t)];
    return { x: R[0][0] * q[0] + R[1][0] * q[1] + R[2][0] * q[2], y: R[0][1] * q[0] + R[1][1] * q[1] + R[2][1] * q[2] };
  }

  // Which way up a page looks, from the angle of its top on screen.
  // one/many: the wording for a single page and for several.
  function status(angle) {
    var a = ((Math.round(angle) % 360) + 360) % 360;
    if (a < 45 || a >= 315) return { one: 'is upright', many: 'are upright', cls: 'ok' };
    if (a < 135) return { one: 'is on its side, top pointing right', many: 'are on their sides, tops pointing right', cls: 'warn' };
    if (a < 225) return { one: 'is upside down', many: 'are upside down', cls: 'bad' };
    return { one: 'is on its side, top pointing left', many: 'are on their sides, tops pointing left', cls: 'warn' };
  }

  // Status of one page item, given the matrix that places its side of the paper.
  function pageStatus(M, face, it) {
    var P = mul(mul(M, rz(face.rot)), rz(it.rot));
    var normal = apply(P, [0, 0, 1]), up = apply(P, [0, -1, 0]);
    if (Math.abs(normal[2]) < 0.2) return { one: 'is seen edge-on', many: 'are seen edge-on', cls: 'warn' };
    return status(Math.atan2(up[0], -up[1]) * 180 / Math.PI);
  }

  // [1] -> "1", [1, 2] -> "1 and 2", [1, 2, 3] -> "1, 2 and 3"
  function listText(nums) {
    return nums.length < 2 ? String(nums[0]) : nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
  }

  // --- hinges: the four ways to turn a page over -------------------------------
  // origin: the edge it turns on; rot/m: the turn as CSS and as a matrix;
  // dir: where it lands, seen from the stack.

  var HINGES = {
    L: { origin: '0 50%', css: function (a) { return 'rotateY(' + (-a) + 'deg)'; }, m: function (a) { return ry(-a); }, dir: [-1, 0], name: 'to the left', book: true },
    R: { origin: '100% 50%', css: function (a) { return 'rotateY(' + a + 'deg)'; }, m: function (a) { return ry(a); }, dir: [1, 0], name: 'to the right', book: true },
    T: { origin: '50% 0', css: function (a) { return 'rotateX(' + a + 'deg)'; }, m: function (a) { return rx(a); }, dir: [0, -1], name: 'upwards', book: false },
    B: { origin: '50% 100%', css: function (a) { return 'rotateX(' + (-a) + 'deg)'; }, m: function (a) { return rx(-a); }, dir: [0, 1], name: 'downwards', book: false }
  };

  // The paper edge a hinge turns the sheet over.
  function hingeEdge(h, frame) {
    var v = L.verticalEdge(frame);
    return HINGES[h].book ? v : (v === 'long' ? 'short' : 'long');
  }

  // The hinge on the paper edge that lies towards a direction on screen.
  function hingeTowards(sx, sy) {
    var d = toPaper(sx, sy);
    if (!d) return sx ? 'L' : 'T';
    return Math.abs(d.x) >= Math.abs(d.y) ? (d.x < 0 ? 'L' : 'R') : (d.y < 0 ? 'T' : 'B');
  }

  // --- drawing paper -----------------------------------------------------------

  function drawPage(parent, it, ox, oy) {
    var w = it.w * k, h = it.h * k, u = Math.min(w, h);
    var p = el('div', 'pg', parent);
    place(p, (it.cx - ox) * k - w / 2, (it.cy - oy) * k - h / 2, w, h);
    if (it.rot) p.style.transform = 'rotate(' + it.rot + 'deg)';
    if (it.border) p.className += ' bordered';
    if (it.page == null) {
      p.className += ' blankpg';
      p.style.fontSize = px(Math.max(u * 0.09, 6));
      p.textContent = 'blank page';
      return;
    }
    if (settings.doc.pdf) { drawPdfPage(p, it.page, u); return; }
    p.style.backgroundSize = px(u / 7) + ' ' + px(u / 7);
    var bandH = h * 0.085;
    var band = el('div', 'band', p);
    band.style.height = band.style.lineHeight = px(bandH);
    band.style.fontSize = px(bandH * 0.62);
    band.textContent = '▲ TOP · Page ' + it.page;
    var num = el('div', 'num', p);
    num.style.fontSize = px(u * 0.42);
    num.textContent = it.page;
    el('div', 'txt', p);
    var c = settings.comments;
    if (c === 'markups') el('div', 'note', p);
    if (c === 'markups' || c === 'stamps') {
      var st = el('div', 'stamp', p);
      st.style.fontSize = px(u * 0.07);
      st.textContent = 'OK';
    }
    if (c === 'forms') {
      p.className += ' formsonly';
      el('div', 'field', p);
    }
  }

  // A page of your own PDF: its picture, plus a small tag with the page number and which way is up.
  function drawPdfPage(p, n, u) {
    var withMarkups = settings.comments !== 'document';
    p.className += ' real';
    var img = el('img', 'pdfimg', p);
    img.alt = '';
    img.draggable = false;
    img.setAttribute('data-pdfk', PdfDoc.key(n, withMarkups));
    var src = PdfDoc.picture(n, withMarkups);
    if (src) img.src = src;
    else p.setAttribute('data-wait', PdfDoc.failed(n, withMarkups) ? 'Page ' + n + ' could not be drawn' : 'Drawing page ' + n + '…');
    var tag = el('div', 'pdftag', p);
    tag.style.fontSize = px(Math.max(u * 0.055, 7));
    tag.textContent = '▲ ' + n;
  }

  // Fill in page pictures as they finish drawing.
  if (window.PdfDoc) {
    PdfDoc.onReady(function (k, src) {
      Array.prototype.forEach.call(document.querySelectorAll('img[data-pdfk="' + k + '"]'), function (img) {
        img.src = src;
        img.parentNode.removeAttribute('data-wait');
      });
    });
  }

  function drawCutmarks(parent, it) {
    var len = 4.5 * k, x0 = it.x * k, y0 = it.y * k, x1 = (it.x + it.w) * k, y1 = (it.y + it.h) * k;
    [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]].forEach(function (c) {
      var across = el('div', 'cut', parent);
      place(across, c[2] < 0 ? c[0] - len : c[0], c[1], len, 0);
      across.style.borderTopWidth = '1px';
      var down = el('div', 'cut', parent);
      place(down, c[0], c[3] < 0 ? c[1] - len : c[1], 0, len);
      down.style.borderLeftWidth = '1px';
    });
  }

  function drawLabel(parent, it) {
    var d = el('div', 'lbl', parent);
    d.style.left = px(it.x * k);
    d.style.top = px(it.y * k);
    d.style.fontSize = px(Math.max(it.h * k, 5));
    d.style.lineHeight = '1';
    d.textContent = it.text;
  }

  // Fills one side of a piece of paper. Sets its size, not its position.
  function drawFace(faceEl, face, w, h, sideText) {
    faceEl.innerHTML = '';
    faceEl.style.width = px(w * k);
    faceEl.style.height = px(h * k);
    var content = el('div', 'content', faceEl);
    if (face.rot) content.style.transform = 'rotate(' + face.rot + 'deg)';
    face.items.forEach(function (it) {
      if (it.type === 'page' && it.clip) {
        var clip = el('div', 'clip', content);
        place(clip, it.clip.x * k, it.clip.y * k, it.clip.w * k, it.clip.h * k);
        drawPage(clip, it, it.clip.x, it.clip.y);
      } else if (it.type === 'page') {
        drawPage(content, it, 0, 0);
      } else if (it.type === 'cutmarks') {
        drawCutmarks(content, it);
      } else if (it.type === 'label') {
        drawLabel(content, it);
      }
    });
    if (!face.items.length) el('div', 'blankside', faceEl).textContent = 'nothing printed on this side';
    if (sideText) {
      // Sits in the printer's blank border so it never covers a page.
      var tag = el('div', 'side', faceEl);
      tag.style.fontSize = tag.style.lineHeight = px(Math.max(L.MARGIN * k * 0.8, 5));
      tag.style.bottom = px(L.MARGIN * k * 0.1);
      tag.textContent = sideText;
    }
  }

  // Pixels per mm so one sheet fits the stage whichever way it is turned.
  function fitScale(w, h) {
    return 0.86 * Math.min(stage.clientWidth, stage.clientHeight) / Math.sqrt(w * w + h * h);
  }

  // --- the stack and the turned piles -----------------------------------------------

  // Turned sheets by the way they were turned, bottom of each pile first.
  function pilesFor(s, hinges) {
    var p = { L: [], R: [], T: [], B: [] };
    for (var i = 0; i < s; i++) p[hinges[i] || 'L'].push(i);
    return p;
  }

  // Where the centre of a sheet ends up after turning on hinge h.
  function pileOffset(h, sh) {
    var d = HINGES[h].dir;
    return [d[0] * sh.w * k, d[1] * sh.h * k];
  }

  function rectOf(sh, o) {
    var w = sh.w * k / 2, h = sh.h * k / 2;
    return [o[0] - w, o[1] - h, o[0] + w, o[1] + h];
  }
  function inRect(r, x, y) { var m = 6; return x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m; }

  // Zoom and centre so the stack and every pile are in view.
  function framing(s, hinges) {
    var N = job.sheets.length, p = pilesFor(s, hinges), rects = [];
    if (s < N) rects.push(rectOf(job.sheets[s], [0, 0]));
    Object.keys(p).forEach(function (h) {
      if (!p[h].length) return;
      var sh = job.sheets[p[h][p[h].length - 1]];
      rects.push(rectOf(sh, pileOffset(h, sh)));
    });
    if (!rects.length) return { cx: 0, cy: 0, zoom: 1 };
    var x0 = Math.min.apply(null, rects.map(function (r) { return r[0]; }));
    var y0 = Math.min.apply(null, rects.map(function (r) { return r[1]; }));
    var x1 = Math.max.apply(null, rects.map(function (r) { return r[2]; }));
    var y1 = Math.max.apply(null, rects.map(function (r) { return r[3]; }));
    var zoom = Math.min(1, 0.9 * stage.clientWidth / (x1 - x0), 0.9 * stage.clientHeight / (y1 - y0));
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom: zoom };
  }
  function applyFrame(f) {
    view.frame = f;
    scene.style.transform = 'scale3d(' + f.zoom + ',' + f.zoom + ',' + f.zoom + ') translate(' + px(-f.cx) + ',' + px(-f.cy) + ')';
  }
  function lerpFrame(a, b, t) {
    return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, zoom: a.zoom + (b.zoom - a.zoom) * t };
  }

  // Keeps the first max-1 entries and the last one (the bottom of the pile shows from behind).
  function thin(list, max) {
    return list.length <= max ? list : list.slice(0, max - 1).concat([list[list.length - 1]]);
  }

  function makeSheet(sh, front, back) {
    var e = el('div', 'sheet3d', scene), W = sh.w * k, H = sh.h * k;
    place(e, -W / 2, -H / 2, W, H);
    if (front) drawFace(el('div', 'face front', e), sh.front, sh.w, sh.h, 'FRONT SIDE');
    if (back) drawFace(el('div', 'face back', e), sh.back, sh.w, sh.h, 'BACK SIDE');
    if (!front && !back) {
      var layer = el('div', 'face layer', e);
      layer.style.width = px(W);
      layer.style.height = px(H);
    }
    return e;
  }

  function renderFlat() {
    var N = job.sheets.length, s = view.sheet;
    k = fitScale(job.sheets[0].w, job.sheets[0].h);
    scene.innerHTML = '';
    topEl = null;
    pileEls = {};
    pileZ = {};
    pileDrawn = {};

    // the stack still to read: top sheet complete, the next one's front, the bottom one's back
    var stack = [];
    for (var i = s; i < N; i++) stack.push(i);
    stack = thin(stack, MAX_LAYERS);
    stackDrawn = stack.length;
    stack.forEach(function (idx, r) {
      var z = (stack.length - r) * GAP;
      var e = makeSheet(job.sheets[idx], r <= 1, r === 0 || idx === N - 1);
      e.style.transform = 'translateZ(' + px(z) + ')';
      if (r === 0) { topEl = e; topZ = z; }
    });

    // the turned piles: each lies back-up on the side it was turned to
    var piles = pilesFor(s, view.hinges);
    Object.keys(piles).forEach(function (h) {
      var list = piles[h].slice().reverse();   // top first
      if (!list.length) return;
      list = thin(list, MAX_LAYERS);
      pileDrawn[h] = list.length;
      list.forEach(function (idx, r) {
        var z = (list.length - r) * GAP;
        var e = makeSheet(job.sheets[idx], r === 0 || r === list.length - 1, r <= 1);
        e.style.transformOrigin = HINGES[h].origin;
        e.style.transform = 'translateZ(' + px(z) + ') ' + HINGES[h].css(180);
        if (r === 0) { pileEls[h] = e; pileZ[h] = z; }
      });
    });
    applyFrame(framing(s, view.hinges));
  }

  // The top sheet part-way through a turn (a: 0 = on the stack, 180 = on the pile).
  function setTop(h, a) {
    var land = (Math.min(pileDrawn[h] || 0, MAX_LAYERS - 1) + 1) * GAP;
    topEl.style.transformOrigin = HINGES[h].origin;
    topEl.style.transform = 'translateZ(' + px(topZ + (land - topZ) * a / 180) + ') ' + HINGES[h].css(a);
  }

  // The last turned sheet part-way back (a: 180 = on its pile, 0 = back on the stack).
  function setReturning(h, a) {
    var land = (Math.min(stackDrawn, MAX_LAYERS - 1) + 1) * GAP;
    pileEls[h].style.transform = 'translateZ(' + px(land + (pileZ[h] - land) * a / 180) + ') ' + HINGES[h].css(a);
  }

  function turnPage(h, from) {
    var s = view.sheet;
    if (s >= job.sheets.length) return;
    var hinges = view.hinges.slice(0, s).concat([h]);
    var f0 = view.frame, f1 = framing(s + 1, hinges);
    tween(TURN_MS * (1 - 0.5 * from / 180), function (t) {
      setTop(h, from + (180 - from) * t);
      applyFrame(lerpFrame(f0, f1, t));
    }, function () {
      view.hinges = hinges;
      view.sheet = s + 1;
      view.lastTurn = { sheet: s, hinge: h };
      renderFlat();
      update();
    });
  }

  function turnBack(from) {
    var s = view.sheet;
    if (s <= 0) return;
    var h = view.hinges[s - 1], hinges = view.hinges.slice(0, s - 1);
    var f0 = view.frame, f1 = framing(s - 1, hinges);
    tween(TURN_MS * (0.5 + 0.5 * from / 180), function (t) {
      setReturning(h, from * (1 - t));
      applyFrame(lerpFrame(f0, f1, t));
    }, function () {
      view.hinges = hinges;
      view.sheet = s - 1;
      view.lastTurn = null;
      renderFlat();
      update();
    });
  }

  function springTop(h, from) { tween(80 + TURN_MS * from / 180, function (t) { setTop(h, from * (1 - t)); }, update); }
  function springReturning(h, from) { tween(80 + TURN_MS * (180 - from) / 180, function (t) { setReturning(h, from + (180 - from) * t); }, update); }

  // --- folded booklet ----------------------------------------------------------

  function turnedAngle() { return book.right ? 180 : -180; }

  // p: 0 = lying on the unread pile, 1 = turned onto the read pile
  function leafZ(i, p) {
    var n = leaves.length;
    return GAP * ((1 - p) * (n - i) + p * (i + 1)) - GAP * n / 2;
  }
  function setLeaf(i, p) {
    leaves[i].style.transform = 'translateZ(' + px(leafZ(i, p)) + ') rotateY(' + p * turnedAngle() + 'deg)';
  }

  // A closed booklet slides over so it stays in the middle.
  function bookShift(leaf) {
    var n = leaves.length, half = book.w * k / 2;
    if (leaf === 0) return book.right ? half : -half;
    if (leaf === n) return book.right ? -half : half;
    return 0;
  }
  function setBookShift(x) { bookEl.style.transform = 'translateX(' + px(x) + ')'; }

  function layoutBook() {
    leaves.forEach(function (lf, i) { setLeaf(i, i < view.leaf ? 1 : 0); });
    setBookShift(bookShift(view.leaf));
  }

  function renderBook() {
    book = L.foldBooklet(job);
    if (!book) { view.mode = 'flat'; render(); return; }
    view.leaf = Math.min(view.leaf, book.leaves.length);
    k = fitScale(book.w * 2, book.h);
    var W = book.w * k, H = book.h * k;
    bookEl.innerHTML = '';
    leaves = book.leaves.map(function (leaf, i) {
      var lf = el('div', 'leaf', bookEl);
      place(lf, book.right ? -W : 0, -H / 2, W, H);
      lf.style.transformOrigin = book.right ? '100% 50%' : '0 50%';   // hinged at the spine
      lf.setAttribute('data-i', i);
      drawFace(el('div', 'face recto', lf), leaf.recto, book.w, book.h, null);
      drawFace(el('div', 'face verso', lf), leaf.verso, book.w, book.h, null);
      return lf;
    });
    layoutBook();
  }

  function turnLeaf(forward, fromP) {
    var n = leaves.length, i = forward ? view.leaf : view.leaf - 1;
    if (i < 0 || i >= n) return;
    var p0 = fromP == null ? (forward ? 0 : 1) : fromP, p1 = forward ? 1 : 0;
    var s0 = bookShift(view.leaf);
    view.leaf += forward ? 1 : -1;
    var s1 = bookShift(view.leaf);
    tween(TURN_MS, function (t) {
      setLeaf(i, p0 + (p1 - p0) * t);
      setBookShift(s0 + (s1 - s0) * t);
    }, function () { layoutBook(); update(); });
  }

  function springLeaf(i, p, forward) {
    var target = forward ? 0 : 1;
    tween(TURN_MS * 0.6, function (t) { setLeaf(i, p + (target - p) * t); }, layoutBook);
  }

  // Sheet 1 is folded in half (the back cover goes underneath) and becomes the booklet.
  function foldIntoBooklet() {
    var sh = job.sheets.filter(function (s) { return s.copy === 1 && s.booklet; })[0];
    if (!sh) return;
    var right = sh.booklet.right;
    k = fitScale(sh.w, sh.h);
    var W = sh.w * k, H = sh.h * k, endShift = right ? W / 4 : -W / 4;
    view.lastTurn = null;
    scene.hidden = true;

    var wrap = el('div', 'foldwrap', world);
    var halves = [0, 1].map(function (i) {
      var half = el('div', 'foldhalf', wrap);
      place(half, -W / 2 + i * W / 2, -H / 2, W / 2, H);
      var f = el('div', 'face', half);
      drawFace(f, sh.front, sh.w, sh.h, null);
      f.style.left = px(-i * W / 2);
      return half;
    });
    var mover = halves[right ? 1 : 0];
    mover.style.transformOrigin = right ? '0 50%' : '100% 50%';
    readout.innerHTML = '<div><b>Folding the sheets in half…</b></div>';

    tween(FOLD_MS, function (t) {
      wrap.style.transform = 'translateX(' + px(endShift * t) + ')';
      mover.style.transform = 'rotateY(' + (right ? 180 : -180) * t + 'deg)';
    }, function () {
      world.removeChild(wrap);
      if (job && job.sizing === 'booklet') {
        view.mode = 'book';
        view.leaf = 0;
      }
      render();
    });
  }

  // --- readout -------------------------------------------------------------

  function pagesOn(face) { return face.items.filter(function (it) { return it.type === 'page'; }); }

  // One sentence per group of pages that look the same way up. M places this side of the paper.
  function pageLines(face, M, lines, where) {
    var pages = pagesOn(face), groups = [], byKey = {};
    var prefix = where ? where + ': ' : '';
    if (!pages.length) { lines.push(prefix + 'nothing is printed on this side.'); return; }
    pages.forEach(function (it) {
      var blank = it.page == null;
      var st = blank ? { one: '', many: '', cls: '' } : pageStatus(M, face, it);
      var key = (blank ? 'blank' : 'page') + st.one;
      if (!byKey[key]) groups.push(byKey[key] = { st: st, blank: blank, list: [], piece: !!it.clip });
      byKey[key].list.push(it.page);
    });
    groups.forEach(function (g) {
      var n = g.list.length, text;
      if (g.blank) text = (n === 1 ? 'a blank page' : n + ' blank pages') + ', added to fill the booklet';
      else if (g.piece) text = 'part of page ' + listText(g.list) + ' ' + g.st.one;
      else text = (n === 1 ? 'page ' : 'pages ') + listText(g.list) + ' ' + (n === 1 ? g.st.one : g.st.many);
      lines.push(prefix + '<span class="' + g.st.cls + '">' + text + '</span>.');
    });
  }

  function sheetName(sh) {
    var name = sh.copies > 1 ? 'copy ' + sh.copy + ', sheet ' + sh.index : 'sheet ' + sh.index;
    if (sh.tile) name += ' (poster piece: row ' + sh.tile.row + ', column ' + sh.tile.col + ' of page ' + sh.tile.page + ')';
    if (sh.booklet) name += ' (booklet sheet ' + (sh.booklet.index + 1) + ')';
    return name;
  }

  function howToTurn(sh) {
    return sh.turnEdge === L.verticalEdge(sh.frame)
      ? 'sideways, like a book page'
      : 'top over bottom, like a wall calendar';
  }

  // Tip when the sheet just turned shows its back the wrong way up.
  function flatTip() {
    var lt = view.lastTurn;
    if (!lt || lt.sheet !== view.sheet - 1) return null;
    var sh = job.sheets[lt.sheet], held = mul(HINGES[lt.hinge].m(180), ry(180));
    var pages = pagesOn(sh.back).filter(function (it) { return it.page != null; });
    var wrong = pages.some(function (it) { return pageStatus(held, sh.back, it).cls !== 'ok'; });
    var edge = hingeEdge(lt.hinge, sh.frame);
    if (!wrong || !sh.turnEdge || edge === sh.turnEdge) return null;
    if (sh.booklet) return 'booklet sheets are printed to be turned over the ' + sh.turnEdge + ' edge. Try turning it the other way.';
    return 'this sheet was printed to be turned over the ' + sh.turnEdge + ' edge, but you turned it over the ' + edge +
      ' edge. Turn it the other way instead, or choose “Flip on ' + edge + ' edge” if your readers will turn it like this.';
  }

  function flatReadout() {
    var N = job.sheets.length, s = view.sheet, R = qmat(view.q), lines = [];
    var piles = pilesFor(s, view.hinges);
    var head = s < N ? '<b>Sheet ' + (s + 1) + ' of ' + N + '</b> is on top of the stack' : '<b>All ' + N + (N === 1 ? ' sheet is' : ' sheets are') + '</b> turned over';
    if (s > 0 && s < N) head += ', and ' + s + (s === 1 ? ' sheet is' : ' sheets are') + ' turned over';
    lines.push(head + '.');
    var fromFront = apply(R, [0, 0, 1])[2] >= 0;
    if (fromFront) {
      lines.push('You are looking at the paper from the front.');
      if (s < N) pageLines(job.sheets[s].front, R, lines, 'On the stack (' + sheetName(job.sheets[s]) + ', front side)');
      Object.keys(piles).forEach(function (h) {
        var list = piles[h];
        if (!list.length) return;
        var sh = job.sheets[list[list.length - 1]];
        pageLines(sh.back, mul(R, mul(HINGES[h].m(180), ry(180))), lines, 'Turned ' + HINGES[h].name + ' (' + sheetName(sh) + ', back side)');
      });
    } else {
      lines.push('You are looking at the paper from behind.');
      if (s < N) pageLines(job.sheets[N - 1].back, mul(R, ry(180)), lines, 'Underneath the stack (' + sheetName(job.sheets[N - 1]) + ', back side)');
      Object.keys(piles).forEach(function (h) {
        var list = piles[h];
        if (!list.length) return;
        var sh = job.sheets[list[0]];
        pageLines(sh.front, mul(R, HINGES[h].m(180)), lines, 'Underneath the sheets turned ' + HINGES[h].name + ' (' + sheetName(sh) + ', front side)');
      });
    }
    var ref = job.sheets[Math.min(s, N - 1)];
    if (ref.turnEdge) lines.push('These sheets are printed to be turned over the <b>' + ref.turnEdge + ' edge</b>, ' + howToTurn(ref) + '.');
    else lines.push('Printed on one side only, so the backs are blank.');
    var lt = view.lastTurn;
    if (lt && lt.sheet === s - 1) {
      var lsh = job.sheets[lt.sheet];
      lines.push('You turned ' + sheetName(lsh) + ' ' + HINGES[lt.hinge].name + ', ' + (HINGES[lt.hinge].book ? 'like a book page' : 'like a calendar page') +
        ', over its <b>' + hingeEdge(lt.hinge, lsh.frame) + ' edge</b>.');
    }
    var tip = flatTip();
    if (tip) lines.push('<span class="warn">Tip: ' + tip + '</span>');
    readout.innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');

    pos.textContent = s < N ? 'Sheet ' + (s + 1) + ' of ' + N : 'All ' + N + ' sheets turned';
    $('prev').innerHTML = '&#9664; Turn back';
    $('next').innerHTML = 'Next page &#9654;';
    $('prev').disabled = s === 0;
    $('next').disabled = s >= N;
  }

  function bookReadout() {
    var n = leaves.length, i = view.leaf, R = qmat(view.q);
    var lines = [];
    lines.push('<b>Folded booklet</b>: ' + n / 2 + (n === 2 ? ' sheet' : ' sheets') + ' folded in half, making ' + 2 * n + ' pages. ' +
      (book.right ? 'It opens from the right, for right-to-left languages.' : 'It opens from the left, like most books.'));
    var state = i === 0 ? 'It is closed, showing the front cover.' : i === n ? 'It is closed, showing the back cover.' : 'It is open.';
    if (apply(R, [0, 0, 1])[2] >= 0) {
      lines.push(state + ' You are looking at it from the front.');
      var recto = i < n ? book.leaves[i].recto : null, verso = i > 0 ? book.leaves[i - 1].verso : null;
      var left = book.right ? recto : verso, right = book.right ? verso : recto;
      if (left) pageLines(left, R, lines, 'Left-hand page');
      if (right) pageLines(right, R, lines, 'Right-hand page');
    } else {
      lines.push(state + ' You are looking at it from behind.');
      if (i > 0) pageLines(book.leaves[0].recto, mul(R, ry(turnedAngle())), lines, 'Underneath the turned pages');
      if (i < n) pageLines(book.leaves[n - 1].verso, mul(R, ry(180)), lines, 'Underneath the pages still to read');
    }
    readout.innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');

    pos.textContent = i === 0 ? 'Front cover' : i === n ? 'Back cover' : 'Spread ' + i + ' of ' + (n - 1);
    $('prev').innerHTML = '&#9664; Previous page';
    $('next').innerHTML = 'Next page &#9654;';
    $('prev').disabled = i === 0;
    $('next').disabled = i === n;
  }

  function update() {
    if (!job) return;
    var has = job.sheets.length > 0, inBook = view.mode === 'book';
    $('fold').hidden = !(has && job.sizing === 'booklet');
    $('fold').textContent = inBook ? 'Unfold to flat sheets' : 'Fold into a booklet';
    $('turnBook').disabled = $('turnCal').disabled = inBook || !has || view.sheet >= job.sheets.length;
    $('rotL').disabled = $('rotR').disabled = $('otherSide').disabled = $('straight').disabled = !has;
    $('hint').textContent = inBook
      ? 'Drag a page to turn it · drag outside the booklet to rotate'
      : 'Drag the top sheet to turn it · drag a turned sheet back to undo · drag outside the paper to rotate';
    if (!has) {
      pos.textContent = 'No sheets';
      readout.innerHTML = '';
      $('prev').disabled = $('next').disabled = true;
      return;
    }
    if (inBook && book) bookReadout(); else flatReadout();
  }

  function render() {
    if (!job) return;
    var has = job.sheets.length > 0, inBook = has && view.mode === 'book';
    $('empty').hidden = has;
    world.hidden = !has;
    scene.hidden = inBook;
    bookEl.hidden = !inBook;
    applyView();
    if (has) {
      if (inBook) renderBook(); else renderFlat();
    }
    update();
  }

  // --- actions -------------------------------------------------------------

  function ready() { return job && job.sheets.length && !busy && !drag; }

  function go(delta) {
    if (!ready()) return;
    if (view.mode === 'book') { turnLeaf(delta > 0); return; }
    if (delta > 0) turnPage(hingeTowards(-1, 0), 0);
    else turnBack(180);
  }

  function moveView(target, ms) {
    var q0 = view.q;
    tween(ms, function (t) {
      view.q = slerp(q0, target, t);
      applyView();
    }, function () {
      view.q = qnorm(target);
      applyView();
      update();
    });
  }

  function backToStart() {
    if (!job || !job.sheets.length || busy) return;
    if (view.mode === 'book') { view.leaf = 0; layoutBook(); update(); return; }
    view.sheet = 0;
    view.hinges = [];
    view.lastTurn = null;
    renderFlat();
    update();
  }

  function resetPosition() {
    if (!ready()) return;
    moveView(homeView(), VIEW_MS);
  }

  // Straight on to whichever side is facing you now.
  function lookStraight() {
    if (!ready()) return;
    var facing = apply(qmat(view.q), [0, 0, 1])[2] >= 0;
    moveView(facing ? [1, 0, 0, 0] : quat([0, 1, 0], 180), VIEW_MS);
  }

  $('prev').addEventListener('click', function () { go(-1); });
  $('next').addEventListener('click', function () { go(1); });
  $('turnBook').addEventListener('click', function () { if (ready() && view.mode === 'flat') turnPage(hingeTowards(-1, 0), 0); });
  $('turnCal').addEventListener('click', function () { if (ready() && view.mode === 'flat') turnPage(hingeTowards(0, -1), 0); });
  $('rotL').addEventListener('click', function () { if (ready()) moveView(qmul(quat([0, 0, 1], -90), view.q), VIEW_MS); });
  $('rotR').addEventListener('click', function () { if (ready()) moveView(qmul(quat([0, 0, 1], 90), view.q), VIEW_MS); });
  $('otherSide').addEventListener('click', function () { if (ready()) moveView(qmul(quat([0, 1, 0], 180), view.q), VIEW_MS * 1.4); });
  $('straight').addEventListener('click', lookStraight);
  $('resetPage').addEventListener('click', backToStart);
  $('resetPos').addEventListener('click', resetPosition);
  $('fold').addEventListener('click', function () {
    if (!ready()) return;
    if (view.mode === 'book') {
      view.mode = 'flat';
      view.sheet = 0;
      view.hinges = [];
      view.lastTurn = null;
      render();
    } else {
      foldIntoBooklet();
    }
  });

  stage.addEventListener('keydown', function (e) {
    var keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in keys) { go(keys[e.key]); e.preventDefault(); }
    if (e.key === 'ArrowUp' && ready() && view.mode === 'flat') { turnPage(hingeTowards(0, -1), 0); e.preventDefault(); }
    if (e.key === 'ArrowDown') { go(-1); e.preventDefault(); }
  });

  // --- pointer: turn pages, or rotate everything -------------------------------

  // What a press at this point would grab: the top sheet, the last turned sheet,
  // a booklet page, or nothing (= rotate the view).
  function grabAt(clientX, clientY) {
    var p = toPlane(clientX, clientY);
    if (!p || !job || !job.sheets.length) return null;
    if (view.mode === 'flat') {
      var f = view.frame, x = p.x / f.zoom + f.cx, y = p.y / f.zoom + f.cy, s = view.sheet, N = job.sheets.length;
      if (s < N && inRect(rectOf(job.sheets[s], [0, 0]), x, y)) return { kind: 'turn' };
      if (s > 0) {
        var h = view.hinges[s - 1], sh = job.sheets[s - 1];
        if (inRect(rectOf(sh, pileOffset(h, sh)), x, y)) return { kind: 'back', hinge: h };
      }
      return null;
    }
    if (!book || Math.abs(p.y) > book.h * k / 2 + 6) return null;
    var n = leaves.length, W = book.w * k, bx = p.x - bookShift(view.leaf);
    if (Math.abs(bx) > W + 6) return null;
    var unreadSide = book.right ? bx < 0 : bx > 0;
    if (unreadSide && view.leaf < n) return { kind: 'leaf', i: view.leaf, forward: true };
    if (!unreadSide && view.leaf > 0) return { kind: 'leaf', i: view.leaf - 1, forward: false };
    return null;
  }

  stage.addEventListener('pointerdown', function (e) {
    if (e.button > 0) return;
    if (drag) cancelDrag();   // a press while an old drag never finished: drop the old one
    if (!ready()) return;
    var grab = toPaper(1, 0) ? grabAt(e.clientX, e.clientY) : null;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, kind: grab ? grab.kind : 'view', hinge: null, a: 0 };
    if (grab && grab.kind === 'back') { drag.hinge = grab.hinge; drag.a = 180; }
    if (grab && grab.kind === 'leaf') {
      drag.i = grab.i;
      drag.forward = grab.forward;
      drag.p = grab.forward ? 0 : 1;
    }
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    stage.classList.add('dragging');
    stage.focus({ preventScroll: true });
    e.preventDefault();
  });

  // Records the angle and how fast it is changing, for a quick flick.
  function track(a) {
    var now = performance.now();
    if (drag.t) drag.speed = (a - drag.a) / Math.max(now - drag.t, 1);
    drag.a = a;
    drag.t = now;
  }

  stage.addEventListener('pointermove', function (e) {
    if (!drag) {
      // show what a press here would do: a hand over a sheet you can turn, four arrows elsewhere
      if (e.pointerType === 'mouse') stage.style.cursor = !busy && grabAt(e.clientX, e.clientY) ? 'grab' : 'move';
      return;
    }
    if (e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0, d, H, sh, size;
    if (drag.kind === 'turn' || drag.kind === 'back') {
      if (!drag.started) {
        if (Math.abs(dx) < DRAG_START_PX && Math.abs(dy) < DRAG_START_PX) return;
        drag.started = true;
      }
      d = toPaper(dx, dy);
      if (!d) return;
      if (drag.kind === 'turn') {
        // the drag's main direction picks the hinge: left, right, up or down
        if (!drag.hinge) drag.hinge = Math.abs(d.x) >= Math.abs(d.y) ? (d.x < 0 ? 'L' : 'R') : (d.y < 0 ? 'T' : 'B');
        H = HINGES[drag.hinge];
        sh = job.sheets[view.sheet];
        size = (H.dir[0] ? sh.w : sh.h) * k;
        track(clamp((d.x * H.dir[0] + d.y * H.dir[1]) / size * 180, 0, 180));
        setTop(drag.hinge, drag.a);
      } else {
        H = HINGES[drag.hinge];
        sh = job.sheets[view.sheet - 1];
        size = (H.dir[0] ? sh.w : sh.h) * k;
        track(180 - clamp(-(d.x * H.dir[0] + d.y * H.dir[1]) / size * 180, 0, 180));   // dragging it back towards the stack
        setReturning(drag.hinge, drag.a);
      }
    } else if (drag.kind === 'leaf') {
      d = toPaper(dx, dy);
      if (!d) return;
      drag.p = clamp((drag.forward ? 0 : 1) + (book.right ? 1 : -1) * d.x / (book.w * k), 0, 1);
      setLeaf(drag.i, drag.p);
    } else {
      // turn everything around the screen's own axes: free, all the way round
      var mx = e.clientX - drag.x, my = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      view.q = qnorm(qmul(qmul(quat([0, 1, 0], mx * DEG_PER_PX), quat([1, 0, 0], -my * DEG_PER_PX)), view.q));
      applyView();
      update();
    }
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag, released = e.type === 'pointerup', speed = d.speed || 0;
    drag = null;
    stage.classList.remove('dragging');
    if (d.kind === 'turn') {
      if (!d.started || !d.hinge) return;
      // past halfway, or a quick flick, completes the turn
      if (released && (d.a >= 90 || (d.a >= 25 && speed > 0.4))) turnPage(d.hinge, d.a);
      else springTop(d.hinge, d.a);
    } else if (d.kind === 'back') {
      if (!d.started) return;
      if (released && (d.a <= 90 || (d.a <= 155 && speed < -0.4))) turnBack(d.a);
      else springReturning(d.hinge, d.a);
    } else if (d.kind === 'leaf') {
      var done = released && (d.forward ? d.p > 0.5 : d.p < 0.5);
      if (done) turnLeaf(d.forward, d.p);
      else springLeaf(d.i, d.p, d.forward);
    } else {
      update();
    }
  }
  function cancelDrag() { if (drag) endDrag({ type: 'pointercancel', pointerId: drag.id }); }

  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // If the release is missed (pointer capture lost, window switched), never stay stuck mid-drag.
  stage.addEventListener('lostpointercapture', function (e) {
    if (drag && e.pointerId === drag.id) endDrag({ type: 'pointerup', pointerId: e.pointerId });
  });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('blur', cancelDrag);

  // Redraw at the new size when the window changes.
  if (window.ResizeObserver) {
    var lastSize = '';
    new ResizeObserver(function () {
      var size = stage.clientWidth + 'x' + stage.clientHeight;
      if (size === lastSize) return;
      lastSize = size;
      if (!busy && !drag) render();
    }).observe(stage);
  }

  window.PrintViewer = {
    show: function (newJob, s) {
      // a different kind of printout starts again from sheet 1; smaller changes keep your place
      if (job && job.sizing !== newJob.sizing) { view.sheet = 0; view.hinges = []; view.lastTurn = null; }
      job = newJob;
      settings = s;
      stage.classList.toggle('gray', !!s.grayscale);
      stage.classList.toggle('ink', !!s.saveInk);
      if (job.sizing !== 'booklet') view.mode = 'flat';
      // keep how far you had read, as far as the new set of sheets allows
      view.sheet = clamp(view.sheet, 0, job.sheets.length);
      view.hinges = view.hinges.slice(0, view.sheet);
      while (view.hinges.length < view.sheet) view.hinges.push('L');
      if (busy) setTimeout(function () { if (!busy) render(); }, FOLD_MS + 60);
      else render();
    },
    reset: function () { view = freshView(); },
    first: backToStart,
    grabAt: grabAt
  };
  window.PrintViewer.setView = function (axisAngles) {   // for testing: set the view from [[axis, deg], ...]
    view.q = axisAngles.reduce(function (q, aa) { return qmul(quat(aa[0], aa[1]), q); }, [1, 0, 0, 0]);
    applyView();
    update();
  };
})();

/*
 * Print layout model.
 * Turns Adobe-Reader-style print settings into a list of printed sheets.
 * Pure functions, no DOM. All sizes are in millimetres.
 *
 * Every sheet face is described in its own "reading frame": the way you hold
 * that side of the paper so the layout reads normally. face.rot (0 or 180)
 * says how that layout sits on the paper when the sheet is turned over
 * left-right (around its vertical edge), like a book page.
 */
(function (root) {
  'use strict';

  var PAPERS = {
    a4: { w: 210, h: 297, label: 'A4' },
    letter: { w: 215.9, h: 279.4, label: 'Letter' },
    legal: { w: 215.9, h: 355.6, label: 'Legal' }
  };
  var MARGIN = 6.35;                // unprintable border, 1/4 inch on every side
  var MM_PER_INCH = 25.4;
  var DOC_SCALE = { same: 1, smaller: Math.SQRT1_2, larger: Math.SQRT2 };
  var GRIDS = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function paperOf(s) { return PAPERS[s.paper] || PAPERS.a4; }

  // Size of page n of the document: the real size from your PDF, or the example's.
  function docPageSize(s, n) {
    if (s.doc.pdf) return s.doc.pdf.sizes[clamp(n, 1, s.doc.pdf.sizes.length) - 1];
    var p = paperOf(s), k = DOC_SCALE[s.doc.size] || 1;
    var land = s.doc.shape === 'landscape' || (s.doc.shape === 'mixed' && n % 2 === 0);
    return land ? { w: p.h * k, h: p.w * k } : { w: p.w * k, h: p.h * k };
  }

  function frameSize(s, frame) {
    var p = paperOf(s);
    return frame === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
  }

  function printable(size) {
    return { x: MARGIN, y: MARGIN, w: size.w - 2 * MARGIN, h: size.h - 2 * MARGIN };
  }

  // The paper edge that runs up-down when a sheet in this frame is held upright.
  function verticalEdge(frame) { return frame === 'landscape' ? 'short' : 'long'; }

  // "1-3, 6, 9-" -> [1, 2, 3, 6, 9, ..., max]
  function parseRange(text, max) {
    var out = [];
    String(text || '').split(',').forEach(function (part) {
      part = part.trim();
      if (!part) return;
      var m = part.match(/^(\d*)\s*-\s*(\d*)$/), a, b;
      if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : max; }
      else if (/^\d+$/.test(part)) { a = b = +part; }
      else return;
      // numbers past the end of the document are skipped; a range keeps the part that exists
      if (Math.max(a, b) < 1 || Math.min(a, b) > max) return;
      a = clamp(a, 1, max);
      b = clamp(b, 1, max);
      var step = a <= b ? 1 : -1;
      for (var i = a; i !== b + step; i += step) out.push(i);
    });
    return out;
  }

  function pageSequence(s) {
    var n = s.doc.pages, seq = [];
    if (s.range.mode === 'current') seq = [clamp(s.doc.current, 1, n)];
    else if (s.range.mode === 'pages') seq = parseRange(s.range.pages, n);
    else for (var i = 1; i <= n; i++) seq.push(i);
    if (s.range.oddEven === 'odd') seq = seq.filter(function (p) { return p % 2 === 1; });
    if (s.range.oddEven === 'even') seq = seq.filter(function (p) { return p % 2 === 0; });
    if (s.range.reverse) seq.reverse();
    return seq;
  }

  // Fits a page into a cell. mode: 'fit' | 'actual' | 'shrink' | a number (custom scale).
  // A page that is auto-rotated is turned a quarter turn counter-clockwise
  // (its top ends up against the left side of the cell).
  function placePage(pg, cell, allowRotate, mode) {
    var fit0 = Math.min(cell.w / pg.w, cell.h / pg.h);
    var fit90 = Math.min(cell.w / pg.h, cell.h / pg.w);
    var turned = !!allowRotate && fit90 > fit0 * 1.0001;
    var fit = turned ? fit90 : fit0;
    var scale = mode === 'actual' ? 1
      : mode === 'shrink' ? Math.min(1, fit)
      : typeof mode === 'number' ? mode
      : fit;
    return {
      cx: cell.x + cell.w / 2, cy: cell.y + cell.h / 2,
      w: pg.w * scale, h: pg.h * scale,
      rot: turned ? 270 : 0, scale: scale
    };
  }

  function pageItem(n, pg, cell, allowRotate, mode, border) {
    var it = placePage(pg, cell, allowRotate, mode);
    it.type = 'page';
    it.page = n;           // null = a blank page added to fill a booklet
    it.border = !!border;
    return it;
  }

  // Ties go to portrait. A rotated layout loses a tie against an unrotated one.
  function chooseFrame(s, score) {
    if (s.orientation === 'portrait' || s.orientation === 'landscape') return s.orientation;
    return score('landscape') > score('portrait') ? 'landscape' : 'portrait';
  }

  function placementScore(p) { return p.scale * (p.rot ? 0.999 : 1); }

  function blankFace() { return { rot: 0, items: [] }; }

  // --- Size -------------------------------------------------------------

  function sizeMode(s) {
    if (s.size.mode !== 'custom') return s.size.mode;
    return clamp(+s.size.custom || 100, 1, 999) / 100;
  }

  function sizeFace(s, n, frame) {
    var pg = docPageSize(s, n);
    return { rot: 0, items: [pageItem(n, pg, printable(frameSize(s, frame)), s.orientation === 'auto', sizeMode(s), false)] };
  }

  function sizeFrame(s, n) {
    var pg = docPageSize(s, n);
    return chooseFrame(s, function (f) {
      return placementScore(placePage(pg, printable(frameSize(s, f)), true, 'fit'));
    });
  }

  // --- Multiple (n-up) ----------------------------------------------------

  function gridFor(s, frame) {
    var m = s.multiple;
    if (m.perSheet === 'custom') return { cols: clamp(m.cols | 0, 1, 10), rows: clamp(m.rows | 0, 1, 10) };
    var g = GRIDS[m.perSheet] || GRIDS[2];
    return frame === 'landscape' ? { cols: g[0], rows: g[1] } : { cols: g[1], rows: g[0] };
  }

  // Cells in the order pages are put into them.
  function cellsFor(s, frame) {
    var P = printable(frameSize(s, frame)), g = gridFor(s, frame);
    var cw = P.w / g.cols, ch = P.h / g.rows, order = s.multiple.order, cells = [];
    for (var i = 0; i < g.cols * g.rows; i++) {
      var row, col;
      if (order === 'v' || order === 'vr') { col = Math.floor(i / g.rows); row = i % g.rows; }
      else { row = Math.floor(i / g.cols); col = i % g.cols; }
      if (order === 'hr' || order === 'vr') col = g.cols - 1 - col;
      cells.push({ x: P.x + col * cw, y: P.y + row * ch, w: cw, h: ch });
    }
    return cells;
  }

  function multipleFace(s, pages, frame) {
    var cells = cellsFor(s, frame);
    return {
      rot: 0,
      items: pages.map(function (n, i) {
        return pageItem(n, docPageSize(s, n), cells[i], s.multiple.autoRotate, 'fit', s.multiple.border);
      })
    };
  }

  function multipleFrame(s, pages) {
    var pg = docPageSize(s, pages[0]);
    return chooseFrame(s, function (f) {
      return placementScore(placePage(pg, cellsFor(s, f)[0], s.multiple.autoRotate, 'fit'));
    });
  }

  // Puts printed sides onto sheets: one side per sheet, or front + back.
  function pairSides(s, sides, frameOf, layout) {
    var sheets = [], step = s.duplex ? 2 : 1;
    for (var i = 0; i < sides.length; i += step) {
      var frame = frameOf(sides[i]);
      var sheet = { frame: frame, front: layout(sides[i], frame), back: blankFace(), turnEdge: null };
      if (s.duplex) {
        sheet.turnEdge = s.flip;
        if (i + 1 < sides.length) sheet.back = layout(sides[i + 1], frame);
        // The printer prints the back so it reads upright after turning the
        // sheet over the chosen edge. If that edge is not the vertical one,
        // a left-right turn shows the back upside down.
        sheet.back.rot = s.flip === verticalEdge(frame) ? 0 : 180;
      }
      sheets.push(sheet);
    }
    return sheets;
  }

  // --- Booklet ------------------------------------------------------------

  function isTall(binding) { return binding === 'leftTall' || binding === 'rightTall'; }
  function isRightBound(binding) { return binding === 'right' || binding === 'rightTall'; }

  function bookletSheets(s, seq) {
    var b = s.booklet;
    var P = Math.max(4, Math.ceil(seq.length / 4) * 4), S = P / 4;
    var right = isRightBound(b.binding);
    var frame = isTall(b.binding) ? 'portrait' : 'landscape';
    var pr = printable(frameSize(s, frame));
    var halves = [
      { x: pr.x, y: pr.y, w: pr.w / 2, h: pr.h },
      { x: pr.x + pr.w / 2, y: pr.y, w: pr.w / 2, h: pr.h }
    ];

    function face(leftPos, rightPos) {
      return {
        rot: 0,
        items: [leftPos, rightPos].map(function (pos, i) {
          var n = pos <= seq.length ? seq[pos - 1] : null;
          var it = pageItem(n, docPageSize(s, n || 1), halves[i], b.autoRotate, 'fit', false);
          it.half = i ? 'R' : 'L';
          return it;
        })
      };
    }

    var from = clamp(b.from | 0 || 1, 1, S);
    var to = clamp(b.to | 0 || S, from, S);
    var sheets = [];
    for (var i = from - 1; i < to; i++) {
      // Position numbers count through the (padded) booklet, 1..P.
      var front = right ? face(2 * i + 1, P - 2 * i) : face(P - 2 * i, 2 * i + 1);
      var back = right ? face(P - 2 * i - 1, 2 * i + 2) : face(2 * i + 2, P - 2 * i - 1);
      if (b.subset === 'front') back = blankFace();
      if (b.subset === 'back') front = blankFace();
      sheets.push({
        frame: frame, front: front, back: back,
        turnEdge: verticalEdge(frame),
        booklet: { index: i, right: right }
      });
    }
    return { sheets: sheets, total: S };
  }

  // Leaves of the folded booklet, front cover first. Built from the printed
  // sheets, so a wrong setting shows up in the folded result too.
  function foldBooklet(job) {
    var sheets = job.sheets.filter(function (sh) { return sh.copy === 1 && sh.booklet; });
    var S = sheets.length;
    if (!S) return null;
    var right = sheets[0].booklet.right, hw = sheets[0].w / 2;
    var outer = right ? 'L' : 'R', inner = right ? 'R' : 'L';

    function half(face, side) {
      return {
        rot: 0,
        items: face.items.filter(function (it) { return it.half === side; }).map(function (it) {
          if (side === 'L') return it;
          var copy = {};
          for (var key in it) copy[key] = it[key];
          copy.cx -= hw;
          return copy;
        })
      };
    }

    var leaves = new Array(2 * S);
    sheets.forEach(function (sh, i) {
      leaves[i] = { recto: half(sh.front, outer), verso: half(sh.back, inner) };
      leaves[2 * S - 1 - i] = { recto: half(sh.back, outer), verso: half(sh.front, inner) };
    });
    return { leaves: leaves, right: right, w: hw, h: sheets[0].h };
  }

  // --- Poster -------------------------------------------------------------

  function fitsOnPaper(pg, paper) {
    var t = 0.5;
    return (pg.w <= paper.w + t && pg.h <= paper.h + t) || (pg.w <= paper.h + t && pg.h <= paper.w + t);
  }

  function posterSheets(s, seq) {
    var paper = paperOf(s);
    var tileScale = clamp(+s.poster.tileScale || 100, 1, 1000) / 100;
    var overlap = Math.max(0, (+s.poster.overlap || 0) * MM_PER_INCH);
    var sheets = [];

    seq.forEach(function (n) {
      var pg = docPageSize(s, n);
      if (s.poster.onlyLarge && fitsOnPaper(pg, paper)) {
        var f = sizeFrame(s, n);
        sheets.push({
          frame: f, back: blankFace(), turnEdge: null,
          front: { rot: 0, items: [pageItem(n, pg, printable(frameSize(s, f)), s.orientation === 'auto', 'shrink', false)] }
        });
        return;
      }

      var W = pg.w * tileScale, H = pg.h * tileScale;
      function grid(frame) {
        var pr = printable(frameSize(s, frame));
        var ov = Math.min(overlap, pr.w / 2, pr.h / 2);
        var sx = pr.w - ov, sy = pr.h - ov;
        return {
          frame: frame, pr: pr, ov: ov, sx: sx, sy: sy,
          cols: Math.max(1, Math.ceil((W - ov) / sx)),
          rows: Math.max(1, Math.ceil((H - ov) / sy))
        };
      }
      var gp = grid('portrait'), gl = grid('landscape'), g;
      if (s.orientation === 'portrait') g = gp;
      else if (s.orientation === 'landscape') g = gl;
      else g = gl.cols * gl.rows < gp.cols * gp.rows ? gl : gp;

      // The enlarged page is centred on the block of tiles.
      var offX = (g.cols * g.sx + g.ov - W) / 2, offY = (g.rows * g.sy + g.ov - H) / 2;
      for (var r = 0; r < g.rows; r++) {
        for (var c = 0; c < g.cols; c++) {
          var gx = c * g.sx, gy = r * g.sy;
          var items = [{
            type: 'page', page: n, rot: 0, scale: tileScale, border: false,
            cx: g.pr.x + offX + W / 2 - gx, cy: g.pr.y + offY + H / 2 - gy, w: W, h: H,
            clip: { x: g.pr.x, y: g.pr.y, w: g.pr.w, h: g.pr.h }
          }];
          if (s.poster.cutMarks) {
            // Trim line: cut off the overlap on the left/top, then lay the tile over its neighbour.
            var tx = c ? g.ov : 0, ty = r ? g.ov : 0;
            items.push({ type: 'cutmarks', x: g.pr.x + tx, y: g.pr.y + ty, w: g.pr.w - tx, h: g.pr.h - ty });
          }
          if (s.poster.labels) {
            items.push({
              type: 'label', x: g.pr.x + g.ov + 6, y: MARGIN * 0.2, h: MARGIN * 0.55,
              text: (s.doc.pdf ? s.doc.pdf.name : 'example.pdf') + ' · page ' + n + ' · tile row ' + (r + 1) + ', column ' + (c + 1)
            });
          }
          sheets.push({
            frame: g.frame, front: { rot: 0, items: items }, back: blankFace(), turnEdge: null,
            tile: { page: n, row: r + 1, col: c + 1, rows: g.rows, cols: g.cols }
          });
        }
      }
    });
    return sheets;
  }

  // --- Main ---------------------------------------------------------------

  function compute(s) {
    var seq = pageSequence(s), sheets = [], bookletTotal = 0;

    if (seq.length) {
      if (s.sizing === 'multiple') {
        var g = GRIDS[s.multiple.perSheet];
        var per = g ? g[0] * g[1] : clamp(s.multiple.cols | 0, 1, 10) * clamp(s.multiple.rows | 0, 1, 10);
        var groups = [];
        for (var i = 0; i < seq.length; i += per) groups.push(seq.slice(i, i + per));
        sheets = pairSides(s, groups,
          function (pages) { return multipleFrame(s, pages); },
          function (pages, frame) { return multipleFace(s, pages, frame); });
      } else if (s.sizing === 'booklet') {
        var bk = bookletSheets(s, seq);
        sheets = bk.sheets;
        bookletTotal = bk.total;
      } else if (s.sizing === 'poster') {
        sheets = posterSheets(s, seq);
      } else {
        sheets = pairSides(s, seq,
          function (n) { return sizeFrame(s, n); },
          function (n, frame) { return sizeFace(s, n, frame); });
      }
    }

    sheets.forEach(function (sh) {
      var f = frameSize(s, sh.frame);
      sh.w = f.w;
      sh.h = f.h;
    });

    var copies = clamp(s.copies | 0 || 1, 1, 99), all = [];
    for (var c = 1; c <= copies; c++) {
      sheets.forEach(function (sh, i) {
        var copy = {};
        for (var key in sh) copy[key] = sh[key];
        copy.copy = c;
        copy.copies = copies;
        copy.index = i + 1;
        copy.perCopy = sheets.length;
        all.push(copy);
      });
    }

    var first = null, scaleMin = Infinity, scaleMax = -Infinity;
    sheets.some(function (sh) {
      first = sh.front.items.concat(sh.back.items).filter(function (it) { return it.type === 'page'; })[0];
      return !!first;
    });
    // pages of different shapes or sizes can each print at their own scale
    sheets.forEach(function (sh) {
      sh.front.items.concat(sh.back.items).forEach(function (it) {
        if (it.type !== 'page' || it.page == null) return;
        var pct = Math.round(it.scale * 100);
        if (pct < scaleMin) scaleMin = pct;
        if (pct > scaleMax) scaleMax = pct;
      });
    });

    return {
      sheets: all,
      perCopy: sheets.length,
      pages: seq,
      sizing: s.sizing,
      duplex: !!s.duplex && (s.sizing === 'size' || s.sizing === 'multiple'),
      bookletTotal: bookletTotal,
      scalePct: first ? Math.round(first.scale * 100) : 100,
      scaleRange: scaleMin <= scaleMax ? [scaleMin, scaleMax] : null
    };
  }

  var api = {
    PAPERS: PAPERS,
    MARGIN: MARGIN,
    compute: compute,
    foldBooklet: foldBooklet,
    parseRange: parseRange,
    pageSequence: pageSequence,
    verticalEdge: verticalEdge
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PrintLayout = api;
})(this);

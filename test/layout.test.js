const assert = require('assert');
const path = require('path');
// Run with: node test/layout.test.js
const L = require(process.argv[2] || path.join(__dirname, '..', 'layout.js'));

function settings(over) {
  const s = {
    doc: { pages: 8, shape: 'portrait', size: 'same', current: 1 },
    paper: 'a4', copies: 1,
    range: { mode: 'all', pages: '1-8', oddEven: 'all', reverse: false },
    sizing: 'size',
    size: { mode: 'fit', custom: 100 },
    poster: { tileScale: 100, overlap: 0, cutMarks: false, labels: false, onlyLarge: false },
    multiple: { perSheet: '2', cols: 2, rows: 2, order: 'h', border: false, autoRotate: true },
    booklet: { subset: 'both', from: 1, to: 0, binding: 'left', autoRotate: true },
    orientation: 'auto', duplex: false, flip: 'long', comments: 'markups'
  };
  for (const k in over) {
    if (typeof over[k] === 'object' && !Array.isArray(over[k])) Object.assign(s[k], over[k]);
    else s[k] = over[k];
  }
  return s;
}
const pages = face => face.items.filter(i => i.type === 'page').map(i => i.page);

// default: 8 single-sided sheets
let job = L.compute(settings({}));
assert.strictEqual(job.sheets.length, 8);
assert.deepStrictEqual(pages(job.sheets[0].back), []);
assert.strictEqual(job.sheets[0].frame, 'portrait');
assert.strictEqual(job.scalePct, 94);

// duplex back rotation rule
job = L.compute(settings({ duplex: true, flip: 'long' }));
assert.strictEqual(job.sheets.length, 4);
assert.deepStrictEqual([pages(job.sheets[0].front), pages(job.sheets[0].back)], [[1], [2]]);
assert.strictEqual(job.sheets[0].back.rot, 0);
job = L.compute(settings({ duplex: true, flip: 'short' }));
assert.strictEqual(job.sheets[0].back.rot, 180);
job = L.compute(settings({ sizing: 'multiple', duplex: true, flip: 'long' }));
assert.strictEqual(job.sheets[0].frame, 'landscape');
assert.deepStrictEqual(pages(job.sheets[0].front), [1, 2]);
assert.strictEqual(job.sheets[0].back.rot, 180);
assert.strictEqual(job.sheets[0].front.items[0].rot, 0);
job = L.compute(settings({ sizing: 'multiple', duplex: true, flip: 'short' }));
assert.strictEqual(job.sheets[0].back.rot, 0);
// landscape document, size mode, long edge -> calendar style
job = L.compute(settings({ doc: { shape: 'landscape' }, duplex: true, flip: 'long' }));
assert.strictEqual(job.sheets[0].frame, 'landscape');
assert.strictEqual(job.sheets[0].back.rot, 180);
// mixed document: back page turned to fit the front's frame
job = L.compute(settings({ doc: { shape: 'mixed' }, duplex: true }));
assert.strictEqual(job.sheets[0].frame, 'portrait');
assert.strictEqual(job.sheets[0].back.items[0].rot, 270);

// booklet imposition
job = L.compute(settings({ sizing: 'booklet' }));
assert.strictEqual(job.sheets.length, 2);
assert.strictEqual(job.sheets[0].frame, 'landscape');
assert.deepStrictEqual(pages(job.sheets[0].front), [8, 1]);
assert.deepStrictEqual(pages(job.sheets[0].back), [2, 7]);
assert.deepStrictEqual(pages(job.sheets[1].front), [6, 3]);
assert.deepStrictEqual(pages(job.sheets[1].back), [4, 5]);
let book = L.foldBooklet(job);
assert.deepStrictEqual(book.leaves.map(l => [pages(l.recto)[0], pages(l.verso)[0]]), [[1, 2], [3, 4], [5, 6], [7, 8]]);
assert.ok(book.leaves.every(l => l.recto.items.every(i => i.cx < book.w) && l.verso.items.every(i => i.cx < book.w)));

job = L.compute(settings({ sizing: 'booklet', booklet: { binding: 'right' } }));
assert.deepStrictEqual(pages(job.sheets[0].front), [1, 8]);
assert.deepStrictEqual(pages(job.sheets[0].back), [7, 2]);
book = L.foldBooklet(job);
assert.deepStrictEqual(book.leaves.map(l => [pages(l.recto)[0], pages(l.verso)[0]]), [[1, 2], [3, 4], [5, 6], [7, 8]]);

job = L.compute(settings({ sizing: 'booklet', booklet: { binding: 'leftTall' } }));
assert.strictEqual(job.sheets[0].frame, 'portrait');
assert.strictEqual(job.sheets[0].turnEdge, 'long');

job = L.compute(settings({ doc: { pages: 10 }, sizing: 'booklet' }));
assert.strictEqual(job.sheets.length, 3);
assert.deepStrictEqual(pages(job.sheets[0].front), [null, 1]);
assert.deepStrictEqual(pages(job.sheets[0].back), [2, null]);
assert.deepStrictEqual(pages(job.sheets[2].front), [8, 5]);
assert.strictEqual(job.bookletTotal, 3);

job = L.compute(settings({ sizing: 'booklet', booklet: { subset: 'front' } }));
assert.deepStrictEqual(pages(job.sheets[0].back), []);
job = L.compute(settings({ sizing: 'booklet', booklet: { from: 2, to: 2 } }));
assert.deepStrictEqual(pages(job.sheets[0].front), [6, 3]);

// 6-up page orders (A4 portrait pages -> landscape sheet, 3 columns x 2 rows)
function order(o) {
  const j = L.compute(settings({ doc: { pages: 6 }, sizing: 'multiple', multiple: { perSheet: '6', order: o } }));
  const items = j.sheets[0].front.items;
  // read the grid left-to-right, top-to-bottom
  return items.slice().sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx)).map(i => i.page);
}
assert.deepStrictEqual(order('h'), [1, 2, 3, 4, 5, 6]);
assert.deepStrictEqual(order('hr'), [3, 2, 1, 6, 5, 4]);
assert.deepStrictEqual(order('v'), [1, 3, 5, 2, 4, 6]);
assert.deepStrictEqual(order('vr'), [5, 3, 1, 6, 4, 2]);

// poster tiling
job = L.compute(settings({ doc: { pages: 1, size: 'larger' }, sizing: 'poster' }));
assert.strictEqual(job.sheets.length, 4);
assert.deepStrictEqual([job.sheets[0].tile.rows, job.sheets[0].tile.cols], [2, 2]);
for (const ov of [0, 0.5, 1, 2, 3]) {
  for (const ts of [50, 100, 150, 250]) {
    job = L.compute(settings({ doc: { pages: 1, size: 'larger' }, sizing: 'poster', poster: { overlap: ov, tileScale: ts } }));
    const t = job.sheets[0].tile, it = job.sheets[0].front.items[0], clip = it.clip;
    const step = { x: clip.w - Math.min(ov * 25.4, clip.w / 2, clip.h / 2), y: clip.h - Math.min(ov * 25.4, clip.w / 2, clip.h / 2) };
    assert.ok(t.cols * step.x + (clip.w - step.x) >= it.w - 1e-6, 'covers width ' + ov + '/' + ts);
    assert.ok(t.rows * step.y + (clip.h - step.y) >= it.h - 1e-6, 'covers height ' + ov + '/' + ts);
    assert.ok((t.cols - 1) * step.x + (clip.w - step.x) < it.w, 'no spare column ' + ov + '/' + ts);
    assert.strictEqual(job.sheets.length, t.rows * t.cols);
  }
}
job = L.compute(settings({ doc: { pages: 1, size: 'larger' }, sizing: 'poster', poster: { tileScale: 150, overlap: 0 } }));
assert.strictEqual(job.sheets.length, 8); // auto picks landscape: 2 x 4 beats 3 x 3
job = L.compute(settings({ doc: { pages: 2 }, sizing: 'poster', poster: { onlyLarge: true } }));
assert.strictEqual(job.sheets.length, 2);

// page ranges
assert.deepStrictEqual(L.parseRange('1-3, 6', 8), [1, 2, 3, 6]);
assert.deepStrictEqual(L.parseRange('7-', 8), [7, 8]);
assert.deepStrictEqual(L.parseRange('0', 8), []);
assert.deepStrictEqual(L.parseRange('99', 8), []);
assert.deepStrictEqual(L.parseRange('2-99', 8), [2, 3, 4, 5, 6, 7, 8]);
assert.deepStrictEqual(L.parseRange('3, 12-15', 8), [3]);

// pages that print at different scales are reported as a range
job = L.compute(settings({ doc: { pages: 4, shape: 'mixed', size: 'same', current: 1 }, orientation: 'portrait' }));
assert.deepStrictEqual(job.scaleRange, [66, 94]);
job = L.compute(settings({}));
assert.deepStrictEqual(job.scaleRange, [94, 94]);
assert.deepStrictEqual(L.pageSequence(settings({ range: { mode: 'pages', pages: '1-3, 6', oddEven: 'odd', reverse: true } })), [3, 1]);
assert.deepStrictEqual(L.pageSequence(settings({ range: { mode: 'current' }, doc: { current: 5 } })), [5]);

// copies
job = L.compute(settings({ copies: 2, duplex: true }));
assert.strictEqual(job.sheets.length, 8);
assert.strictEqual(job.sheets[4].copy, 2);

console.log('all layout checks passed');

/*
 * Connects the pseudo Print window to the layout model and the preview.
 * Grays out options the same way Reader does and fills in the summary column.
 */
(function () {
  'use strict';

  var form = document.getElementById('f');
  var sizing = 'size';
  var bookToTouched = false;   // until the user edits "to", it follows the number of booklet sheets

  function $(id) { return document.getElementById(id); }
  function all(sel) { return Array.prototype.slice.call(form.querySelectorAll(sel)); }
  function radio(name) {
    var r = form.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : null;
  }
  function int(id, lo, hi, def) {
    var v = parseInt($(id).value, 10);
    return isNaN(v) ? def : Math.max(lo, Math.min(hi, v));
  }
  function num(id, def) {
    var v = parseFloat($(id).value);
    return isNaN(v) ? def : v;
  }
  function twoSidedAllowed() { return sizing === 'size' || sizing === 'multiple'; }

  function readSettings() {
    var pdf = PdfDoc.info(), pages = pdf ? pdf.pages : int('docPages', 1, 200, 8);
    return {
      doc: { pages: pages, shape: $('docShape').value, size: $('docSize').value, current: int('docCurrent', 1, pages, 1), pdf: pdf },
      paper: $('paper').value,
      copies: int('copies', 1, 20, 1),
      grayscale: $('grayscale').checked,
      saveInk: $('saveInk').checked,
      range: { mode: radio('range'), pages: $('rangePages').value, oddEven: $('oddEven').value, reverse: $('reverse').checked },
      sizing: sizing,
      size: { mode: radio('sizeMode'), custom: num('customScale', 100) },
      poster: {
        tileScale: num('tileScale', 100), overlap: num('overlap', 0),
        cutMarks: $('cutMarks').checked, labels: $('labels').checked, onlyLarge: $('onlyLarge').checked
      },
      multiple: {
        perSheet: $('perSheet').value, cols: int('customCols', 1, 10, 2), rows: int('customRows', 1, 10, 2),
        order: $('pageOrder').value, border: $('border').checked, autoRotate: $('nupRotate').checked
      },
      booklet: {
        subset: $('subset').value, from: int('bookFrom', 1, 999, 1), to: bookToTouched ? int('bookTo', 1, 999, 0) : 0,
        binding: $('binding').value, autoRotate: $('bookRotate').checked
      },
      orientation: radio('orient'),
      duplex: twoSidedAllowed() && $('duplex').checked,
      flip: radio('flip'),
      comments: $('comments').value
    };
  }

  function syncControls(s, job) {
    // with your own PDF, its pages decide the count, shape and size
    var own = !!s.doc.pdf;
    $('docPages').disabled = $('docPages2').disabled = $('docShape').disabled = $('docSize').disabled = own;
    Array.prototype.forEach.call(document.querySelectorAll('.pgstep'), function (b) { b.disabled = own; });
    $('pdfClear').hidden = !own;
    $('docCurrent').max = s.doc.pages;
    // a box you are not typing in shows what is actually used
    if ($('docCurrent') !== document.activeElement && +$('docCurrent').value > s.doc.pages) $('docCurrent').value = s.doc.pages;
    $('rangePages').disabled = s.range.mode !== 'pages';
    if (s.range.mode !== 'pages') $('rangePages').value = '1 - ' + s.doc.pages;
    $('customScale').disabled = s.size.mode !== 'custom';
    $('customCols').disabled = $('customRows').disabled = s.multiple.perSheet !== 'custom';
    $('duplex').disabled = !twoSidedAllowed();
    all('input[name="flip"]').forEach(function (r) { r.disabled = !s.duplex; });
    all('input[name="orient"]').forEach(function (r) { r.disabled = sizing === 'booklet'; });
    $('bindingPick').hidden = sizing !== 'booklet' || !job.sheets.length;
    $('binding2').value = s.booklet.binding;
    $('duplexNote').textContent = sizing === 'booklet'
      ? '(Booklets always print on both sides. Reader picks the flip edge itself: the short edge, or the long edge for the Tall bindings.)'
      : sizing === 'poster' ? '(Posters are shown printed on one side only.)' : '';
    if (job.bookletTotal) {
      $('bookFrom').max = $('bookTo').max = job.bookletTotal;
      if (!bookToTouched) $('bookTo').value = job.bookletTotal;
      [$('bookFrom'), $('bookTo')].forEach(function (box) {
        if (box !== document.activeElement && +box.value > job.bookletTotal) box.value = job.bookletTotal;
      });
    }
    all('[data-sizing]').forEach(function (b) {
      var on = b.getAttribute('data-sizing') === sizing;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      $('panel-' + b.getAttribute('data-sizing')).hidden = !on;
    });
  }

  function summary(s, job) {
    var p = PrintLayout.PAPERS[s.paper];
    var range = job.scaleRange;
    $('infoScale').textContent = range && range[0] !== range[1] ? range[0] + '–' + range[1] + '%' : job.scalePct + '%';
    $('infoInches').textContent = (p.w / 25.4).toFixed(2) + ' x ' + (p.h / 25.4).toFixed(2) + ' Inches';
    $('infoSheets').textContent = job.sheets.length + (s.copies > 1 && job.perCopy ? ' (' + job.perCopy + ' per copy)' : '');
    var sides;
    if (sizing === 'booklet') {
      sides = { both: 'Printed on both sides (booklet)', front: 'Front sides only', back: 'Back sides only' }[s.booklet.subset];
    } else if (job.duplex) {
      sides = 'Printed on both sides, flip on ' + s.flip + ' edge';
    } else {
      sides = 'Printed on one side';
    }
    $('infoSides').textContent = sides;
  }

  function update() {
    var s = readSettings(), job = PrintLayout.compute(s);
    if (s.doc.pdf) $('docPages').value = s.doc.pages;
    if (document.activeElement !== $('docPages2')) $('docPages2').value = s.doc.pages;
    syncControls(s, job);
    summary(s, job);
    if (s.doc.pdf) PdfDoc.prefetch(s.comments !== 'document');   // draw every page in the background
    PrintViewer.show(job, s);
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; update(); });
  }

  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);
  // When you leave a number box, it snaps to the number actually used: a blank box
  // goes back to its default, and a value out of range to the nearest one allowed.
  form.addEventListener('change', function (e) {
    var box = e.target;
    if (box.type !== 'number') return;
    var v = parseFloat(box.value), lo = parseFloat(box.min), hi = parseFloat(box.max);
    if (isNaN(v)) v = box.id === 'bookTo' && !isNaN(hi) ? hi : parseFloat(box.defaultValue);
    if (!isNaN(lo) && v < lo) v = lo;
    if (!isNaN(hi) && v > hi) v = hi;
    if (box.value === '' || +box.value !== v) box.value = v;
    // booklet sheets "from" can't be past "to"
    if (box.id === 'bookFrom' && +$('bookTo').value < v) { $('bookTo').value = v; bookToTouched = true; }
    if (box.id === 'bookTo' && +$('bookFrom').value > v) $('bookFrom').value = v;
  });
  $('bookTo').addEventListener('input', function () { bookToTouched = true; });
  all('[data-sizing]').forEach(function (b) {
    b.addEventListener('click', function () {
      sizing = b.getAttribute('data-sizing');
      update();
    });
  });
  // Page count: the box in "Example document", its copy above the preview, and the -/+ buttons.
  function setPageCount(n) {
    $('docPages').value = Math.max(1, Math.min(200, n));
    update();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.pgstep'), function (b) {
    b.addEventListener('click', function () {
      setPageCount(int('docPages', 1, 200, 8) + parseInt(b.getAttribute('data-step'), 10));
    });
  });
  $('docPages2').addEventListener('input', function () {
    var v = parseInt($('docPages2').value, 10);
    if (!isNaN(v)) setPageCount(v);
  });
  $('docPages2').addEventListener('change', function () { $('docPages2').value = $('docPages').value; });
  // Booklet binding: a copy next to the preview, so you can switch sides while looking at the booklet.
  $('binding2').addEventListener('change', function () {
    $('binding').value = $('binding2').value;
    update();
  });

  // Your own PDF: picked with the file box or dropped onto the preview.
  var pdfHelp = $('pdfStatus').textContent, pagesBeforePdf = null, opening = 0;
  function pdfStatus(text) { $('pdfStatus').textContent = text; }

  function openPdf(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      pdfStatus(file.name + ' is not a PDF file.');
      return;
    }
    var my = ++opening;   // only the latest file gets to report back
    pdfStatus('Opening ' + file.name + '…');
    PdfDoc.open(file).then(function (info) {
      if (my !== opening) return;
      if (pagesBeforePdf === null) pagesBeforePdf = $('docPages').value;
      pdfStatus('Showing ' + info.name + ': ' + (info.pages === 1 ? '1 page at its' : info.pages + ' pages at their') +
        ' real size. The file stays on your computer.');
      update();
      PrintViewer.first();
    }).catch(function (err) {
      if (my !== opening) return;
      // opening a file closed the one before it, so the example is back
      restorePageCount();
      $('pdfFile').value = '';
      pdfStatus(err && err.name === 'PasswordException'
        ? file.name + " is password-protected, so it can't be shown."
        : "Couldn't open " + file.name + ' (' + String(err && err.message || err).replace(/\.$/, '') + ').');
      update();
    });
  }

  function restorePageCount() {
    if (pagesBeforePdf !== null) $('docPages').value = pagesBeforePdf;
    pagesBeforePdf = null;
  }

  function useExample() {
    opening++;
    PdfDoc.close();
    $('pdfFile').value = '';
    restorePageCount();
    pdfStatus(pdfHelp);
  }

  $('pdfFile').addEventListener('change', function () { openPdf($('pdfFile').files[0]); });
  $('pdfClear').addEventListener('click', function () { useExample(); update(); PrintViewer.first(); });
  // A file dropped anywhere on the page opens as the document instead of replacing the page.
  document.addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    openPdf(e.dataTransfer.files[0]);
  });

  $('pageSetup').addEventListener('click', function () { $('paper').focus(); });
  $('printBtn').addEventListener('click', function () {
    PrintViewer.first();
    $('preview').scrollIntoView({ behavior: 'smooth' });
  });
  $('resetAll').addEventListener('click', function () {
    useExample();
    form.reset();
    sizing = 'size';
    bookToTouched = false;
    PrintViewer.reset();
    update();
  });

  update();
})();

/*
 * Your own PDF: reads the file you pick and turns its pages into pictures,
 * all inside the browser. Nothing is uploaded. Uses the copy of PDF.js in
 * lib/pdfjs, which is only loaded once someone actually picks a file.
 *
 * Pages are drawn one at a time in the background; the ones on screen jump
 * the queue. Each finished picture is announced to onReady listeners.
 */
(function () {
  'use strict';

  var BASE = 'lib/pdfjs/';
  var MM_PER_PT = 25.4 / 72;
  var PICTURE_PX = 1100;   // longest side of each page picture

  var libPromise = null, pdfjs = null;
  var task = null, doc = null, info = null, token = 0;   // task: PDF.js's handle for closing the file
  var pictures = {}, failed = {}, queue = [], drawing = false, listeners = [];

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadLibrary() {
    if (!libPromise) {
      libPromise = loadScript(BASE + 'pdf.js').then(function () {
        pdfjs = window.pdfjsLib;
        if (location.protocol === 'file:') {
          // Browsers refuse background workers on pages opened straight from disk,
          // so PDF.js does its work on the page itself instead.
          return loadScript(BASE + 'pdf.worker.js');
        }
        // Served from a web server: the same file runs as a background worker. (A .js file,
        // because some servers send .mjs files with a type browsers won't run.)
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(BASE + 'pdf.worker.js', location.href).href;
      }).then(function () { return pdfjs; });
      libPromise.catch(function () { libPromise = null; });   // let a later attempt try again
    }
    return libPromise;
  }

  function dataUrl(path) { return new URL(BASE + path, location.href).href; }

  function key(n, withMarkups) { return (withMarkups ? 'm' : 'd') + n; }

  // Opens a PDF file. Resolves with { name, pages, sizes: [{ w, h } in mm, ...] }.
  function open(file) {
    close();
    var my = token;
    return loadLibrary().then(function () {
      return file.arrayBuffer();
    }).then(function (buffer) {
      if (my !== token) throw new Error('replaced by another file');
      task = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        cMapUrl: dataUrl('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: dataUrl('standard_fonts/'),
        wasmUrl: dataUrl('wasm/'),
        iccUrl: dataUrl('iccs/')
      });
      return task.promise;
    }).then(function (pdf) {
      if (my !== token) throw new Error('replaced by another file');
      var pages = [];
      for (var n = 1; n <= pdf.numPages; n++) pages.push(pdf.getPage(n));
      return Promise.all(pages).then(function (list) {
        if (my !== token) throw new Error('replaced by another file');
        doc = pdf;
        info = {
          name: file.name,
          pages: pdf.numPages,
          // the size each page prints at, already turned if the PDF says so
          sizes: list.map(function (page) {
            var vp = page.getViewport({ scale: 1 });
            return { w: vp.width * MM_PER_PT, h: vp.height * MM_PER_PT };
          })
        };
        return info;
      });
    });
  }

  function close() {
    token++;
    if (task) task.destroy();   // also stops a file that is still opening
    task = null;
    doc = null;
    info = null;
    Object.keys(pictures).forEach(function (k) { URL.revokeObjectURL(pictures[k]); });
    pictures = {};
    failed = {};
    queue = [];
  }

  // The picture of page n, or null while it is still being drawn (it is queued first in line).
  function picture(n, withMarkups) {
    var k = key(n, withMarkups);
    if (pictures[k] || failed[k] || !doc) return pictures[k] || null;
    var at = queue.indexOf(k);
    if (at >= 0) queue.splice(at, 1);
    queue.unshift(k);
    pump();
    return null;
  }

  // Queues every page behind the ones already waiting, so turning pages later is instant.
  function prefetch(withMarkups) {
    if (!info) return;
    queue = queue.filter(function (k) { return k.charAt(0) === (withMarkups ? 'm' : 'd'); });
    for (var n = 1; n <= info.pages; n++) {
      var k = key(n, withMarkups);
      if (!pictures[k] && queue.indexOf(k) < 0) queue.push(k);
    }
    pump();
  }

  function pump() {
    if (drawing || !queue.length || !doc) return;
    drawing = true;
    var k = queue.shift(), n = +k.slice(1), withMarkups = k.charAt(0) === 'm', my = token, pdf = doc;
    pdf.getPage(n).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: PICTURE_PX / Math.max(base.width, base.height) });
      var canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({
        canvasContext: ctx,
        viewport: vp,
        intent: 'print',   // what the printer would get, like Reader's Print
        annotationMode: withMarkups ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE
      }).promise.then(function () {
        return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.88); });
      });
    }).then(function (blob) {
      if (my !== token || !blob) return;
      pictures[k] = URL.createObjectURL(blob);
      listeners.forEach(function (fn) { fn(k, pictures[k]); });
    }).catch(function (err) {
      if (my === token) failed[k] = true;
      if (window.console) console.warn('Page ' + n + ' could not be drawn:', err);
    }).then(function () {
      drawing = false;
      pump();
    });
  }

  window.PdfDoc = {
    open: open,
    close: close,
    info: function () { return info; },
    key: key,
    picture: picture,
    failed: function (n, withMarkups) { return !!failed[key(n, withMarkups)]; },
    prefetch: prefetch,
    onReady: function (fn) { listeners.push(fn); }
  };
})();

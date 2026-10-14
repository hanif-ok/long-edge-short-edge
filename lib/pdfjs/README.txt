PDF.js 6.3.289 (npm package pdfjs-dist), by Mozilla. Licence: Apache-2.0 (see LICENSE).
Used to show the pages of a PDF the visitor picks. Everything runs in the browser; nothing is uploaded.

Files
  pdf.js          build/pdf.min.mjs converted to a plain script (global "pdfjsLib")
  pdf.worker.js   build/pdf.worker.min.mjs converted the same way. Served from a web server it runs as
                  a background worker; opened straight from disk (file://), where browsers refuse
                  workers, it is loaded as a normal script and PDF.js runs on the page itself.
  cmaps/ standard_fonts/ wasm/ iccs/   unchanged data files from the package

The two converted files were made with:
  npx esbuild@0.28.2 build/pdf.min.mjs --bundle --format=iife --global-name=pdfjsLib --target=es2022 --minify --legal-comments=eof --outfile=pdf.js
  npx esbuild@0.28.2 build/pdf.worker.min.mjs --bundle --format=iife --global-name=pdfjsWorkerModule --target=es2022 --minify --legal-comments=eof --outfile=pdf.worker.js

#!/bin/bash
# Assembles the installable bundle from the tested source tree.
set -euo pipefail
cd /home/tester/build
SRC=tresorit-connector; OUT=bundle; VER=1.4.4
rm -rf $OUT && mkdir -p $OUT
cp -R $SRC/server $OUT/
cat > $OUT/package.json <<JSON
{
  "name": "tresorit-local-connector",
  "version": "$VER",
  "private": true,
  "description": "Local connector between Claude and the Tresorit folder synced on this Mac",
  "type": "module",
  "main": "server/index.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.2",
    "fflate": "0.8.3",
    "tesseract.js": "7.0.0",
    "unpdf": "2.2.1",
    "zod": "4.6.7"
  }
}
JSON
# production dependencies only, installed fresh from the lock-free manifest above
(cd $OUT && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1)
# the OCR engine ships each build twice; the copies meant for web browsers (*.wasm.js) are not used here
(cd $OUT/node_modules/tesseract.js-core && rm -f *.wasm.js)
# code that can download files is not needed (language data is inside the bundle) and is removed
rm -rf $OUT/node_modules/node-fetch $OUT/node_modules/whatwg-url $OUT/node_modules/tr46 $OUT/node_modules/webidl-conversions $OUT/node_modules/idb-keyval $OUT/node_modules/opencollective-postinstall
rm -rf $OUT/node_modules/tesseract.js/dist $OUT/node_modules/tesseract.js/docs $OUT/node_modules/tesseract.js/examples $OUT/node_modules/tesseract.js/scripts 2>/dev/null || true
cp scratch/icon.png $OUT/icon.png
cp scratch/README.md $OUT/README.md
cp scratch/manifest.json $OUT/manifest.json
(cd $OUT && node ../tools/node_modules/.bin/mcpb validate manifest.json >/dev/null && node ../tools/node_modules/.bin/mcpb pack . ../tresorit-local-$VER.mcpb 2>&1 | grep -E "package size|unpacked size|total files|shasum")

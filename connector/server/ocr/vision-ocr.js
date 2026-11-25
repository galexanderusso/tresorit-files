// Text recognition with the Mac's built-in Vision framework. Run by the connector as:
//   /usr/bin/osascript -l JavaScript vision-ocr.js <path of a PDF or a picture> <pages, e.g. 1,2,5> <languages, e.g. en-US,pt-BR>
// Prints one line of JSON: {"total": <page count>, "pages": {"1": "text", ...}} or {"error": "..."}.
// Reads the file only; it changes nothing and contacts nothing.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Quartz');
ObjC.import('Vision');

function recognise(tiff, langs) {
  var handler = $.VNImageRequestHandler.alloc.initWithDataOptions(tiff, $.NSDictionary.dictionary);
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.setRecognitionLevel(0); // accurate
  req.setUsesLanguageCorrection(true);
  if (langs && langs.length) req.setRecognitionLanguages($(langs));
  var err = $();
  var ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
  if (!ok) return null;
  var lines = [];
  var res = req.results;
  if (res && !res.isNil()) {
    var count = res.count;
    for (var j = 0; j < count; j++) {
      var cand = res.objectAtIndex(j).topCandidates(1);
      if (cand.count > 0) lines.push(ObjC.unwrap(cand.objectAtIndex(0).string));
    }
  }
  return lines.join('\n');
}

function run(argv) {
  try {
    var path = argv[0];
    var wanted = String(argv[1] || '1').split(',').map(function (s) { return parseInt(s, 10); });
    var langs = String(argv[2] || '').split(',').filter(function (s) { return s; });
    var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(path));
    if (!doc || doc.isNil()) {
      // Not a PDF: a picture saved under a document's name is recognised as it is (one page).
      // The picture is opened from its bytes, not by its name: opened by name, the Mac goes by the ending
      // (".pdf") and refuses a picture that carries a document's ending.
      var bytes = $.NSData.dataWithContentsOfFile(path);
      if (!bytes || bytes.isNil() || !(Number(bytes.length) > 0)) return JSON.stringify({ error: 'the file could not be opened' });
      var picData = null;
      var pic = $.NSImage.alloc.initWithData(bytes);
      if (pic && !pic.isNil()) {
        var picTiff = pic.TIFFRepresentation;
        if (picTiff && !picTiff.isNil()) picData = picTiff;
      }
      if (!picData) picData = bytes; // let the recognition itself work out what kind of picture the bytes are
      var picText = recognise(picData, langs);
      if (picText === null) picText = recognise(picData, []);
      if (picText === null && picData !== bytes) { picText = recognise(bytes, langs); if (picText === null) picText = recognise(bytes, []); }
      if (picText === null) return JSON.stringify({ error: 'the file could not be opened as a PDF or as a picture' });
      return JSON.stringify({ total: 1, pages: { 1: picText } });
    }
    var total = Number(doc.pageCount);
    var out = {};
    for (var k = 0; k < wanted.length; k++) {
      var p = wanted[k];
      if (!(p >= 1 && p <= total)) continue;
      var page = doc.pageAtIndex(p - 1);
      var b = page.boundsForBox(0); // media box
      var w = Number(b.size.width);
      var h = Number(b.size.height);
      if (!(w > 0 && h > 0)) { out[p] = ''; continue; }
      var scale = Math.min(4, Math.max(1.5, 2400 / Math.max(w, h))); // long edge of about 2400 pixels
      var img = page.thumbnailOfSizeForBox({ width: w * scale, height: h * scale }, 0);
      var tiff = img.TIFFRepresentation;
      var text = recognise(tiff, langs);
      if (text === null) text = recognise(tiff, []); // retry with automatic language choice
      out[p] = text === null ? '' : text;
    }
    return JSON.stringify({ total: total, pages: out });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

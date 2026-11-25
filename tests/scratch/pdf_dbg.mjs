import fs from 'node:fs';
import { getDocumentProxy, extractText } from '../tresorit-connector/node_modules/unpdf/dist/index.mjs';
const f = process.argv[2];
const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(f)), { verbosity: 1 });
console.error('pages', pdf.numPages);
const page = await pdf.getPage(1);
try {
  const tc = await page.getTextContent();
  console.error('items on page 1:', tc.items.length, JSON.stringify(tc.items.slice(0, 3).map((i) => i.str)));
} catch (e) { console.error('getTextContent threw:', e.message); }
const { text } = await extractText(pdf, { mergePages: false });
console.error('extractText page lengths:', text.map((t) => t.length).slice(0, 8).join(','));
const ann = await page.getAnnotations();
console.error('annotations on page 1:', ann.length, JSON.stringify(ann.slice(0, 4).map((a) => ({ subtype: a.subtype, fieldType: a.fieldType, fieldName: a.fieldName, fieldValue: a.fieldValue, contents: a.contentsObj && a.contentsObj.str }))).slice(0, 500));

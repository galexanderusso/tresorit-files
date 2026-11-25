// Stand-in for the Mac helper, for testing the orchestration on Linux. argv: [mode, pdf, pages, langs]
const [mode, pdf, pages] = process.argv.slice(2);
if (mode === 'garbage') { console.log('this is not json'); process.exit(0); }
if (mode === 'crash') { process.exit(3); }
const out = {};
for (const p of pages.split(',')) out[p] = pdf.includes('selftest') ? 'TRESORIT CONNECTOR\nOCR SELF TEST 48213' : (mode === 'failfile' ? null : `VISION-STUB text for page ${p}`);
if (mode === 'failfile' && !pdf.includes('selftest')) { console.log(JSON.stringify({ error: 'the PDF could not be opened' })); process.exit(0); }
console.log(JSON.stringify({ total: 9, pages: out }));

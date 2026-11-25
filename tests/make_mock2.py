# Adds version 1.1 test material to the mock Tresorit folder (run after make_mock.py).
import os, shutil, subprocess, sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from PIL import Image, ImageDraw, ImageFont
root = '/home/tester/build/mock/Tresors'
def d(*p):
    q = os.path.join(root, *p); os.makedirs(q, exist_ok=True); return q
leg = d('Alder Works UK', '05 - Legacy'); mail = d('Alder Works UK', '06 - Emails'); scans = d('Personal', 'Scans')
fin = os.path.join(root, 'Alder Works UK', '03 - Finance'); orbit = os.path.join(root, 'Alder Works UK', '07 - Research', 'ORBIT')
prof = 'file:///home/tester/build/scratch/lo-profile'
def conv(fmt, src, out):
    subprocess.run(['soffice', f'-env:UserInstallation={prof}', '--headless', '--convert-to', fmt, '--outdir', out, src], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
conv('doc:MS Word 97', os.path.join(fin, 'NDA Fundação Exemplo.docx'), leg)
conv('xls:MS Excel 97', os.path.join(fin, 'Commission tracker 2026.xlsx'), leg)
conv('ppt:MS PowerPoint 97', os.path.join(orbit, 'ORBIT pilot deck.pptx'), leg)
poi = '/home/tester/samples/poi/test-data'
shutil.copy(f'{poi}/document/SampleDoc.doc', leg); shutil.copy(f'{poi}/document/footnote.doc', leg)
shutil.copy(f'{poi}/slideshow/basic_test_ppt_file.ppt', leg); shutil.copy(f'{poi}/spreadsheet/SimpleWithFormula.xls', leg)
shutil.copy(f'{poi}/spreadsheet/password.xls', leg) if os.path.exists(f'{poi}/spreadsheet/password.xls') else shutil.copy(f'{poi}/spreadsheet/35897-type4.xls', os.path.join(leg, 'password.xls'))
mx = '/home/tester/samples/msgx/example-msg-files'; mr = '/home/tester/samples/msgr'
for f in ['unicode.msg', 'multi-to.msg', 'signed.msg']: shutil.copy(f'{mx}/{f}', mail)
for f in ['nonUnicodeCP932.msg', 'msgInMsgInMsg.msg', 'htmlLink.msg']: shutil.copy(f'{mr}/test/{f}', mail)
shutil.copy(f'{mr}/test3/cyclicFatRing.msg', mail)
open(os.path.join(leg, 'export.xls'), 'w').write('<html><body><table><tr><td>Invoice</td><td>HTML-EXPORT-551</td></tr></table></body></html>')
open(os.path.join(leg, 'letter.doc'), 'w').write(r'{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}\f0 Dear Sir,\par This is an RTF-LETTER-907 saved as doc. Caf\'e9.\par}')
# scans
o = '/home/tester/build/scratch/ocr'
shutil.copy(f'{o}/scan_jpeg.pdf', os.path.join(scans, 'Contract scan.pdf'))
shutil.copy(f'{o}/scan_1bit.pdf', os.path.join(scans, 'Settlement one-bit.pdf'))
shutil.copy(f'{o}/scan_jpx.pdf', os.path.join(scans, 'JPEG2000 scan.pdf'))
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 34)
im = Image.new('L', (1654, 2339), 255); dr = ImageDraw.Draw(im)
for i, ln in enumerate(['SIGNATURE PAGE', '', 'Signed by the parties on 9 November 2026.', 'Witness reference: MAGENTA-HERON-3310.']): dr.text((150, 200 + 60 * i), ln, fill=0, font=font)
tmp = '/home/tester/build/scratch/sigpage.png'; im.save(tmp)
c = canvas.Canvas(os.path.join(scans, 'Mixed agreement.pdf'), pagesize=A4)
c.drawString(72, 800, 'SHARE PURCHASE AGREEMENT'); c.drawString(72, 780, 'This first page has a real text layer with the marker TEXTLAYER-OK-17 and enough words to count.'); c.showPage()
c.drawImage(tmp, 0, 0, 595, 842); c.showPage(); c.save()
# other audit material
tax = os.path.join(root, 'Personal', 'Tax')
open(os.path.join(tax, 'latin1 notes.txt'), 'wb').write('Relatório de março – cláusula nº 4\n'.encode('cp1252'))
br = d('Birch Labs', 'Briefs')
if not os.path.lexists(os.path.join(br, 'dangling')): os.symlink('/nonexistent/target/file.txt', os.path.join(br, 'dangling'))
pf = d('Birch Labs', 'Pipes', 'has-fifo'); open(os.path.join(pf, 'a.txt'), 'w').write('a')
if not os.path.exists(os.path.join(pf, 'pipe')): os.mkfifo(os.path.join(pf, 'pipe'))
dst = d('Birch Labs', 'Pipes', 'target', 'has-fifo'); open(os.path.join(dst, 'precious.txt'), 'w').write('precious original content')
nest = d('Birch Labs', 'Nest', 'inner'); open(os.path.join(nest, 'x.txt'), 'w').write('x'); open(os.path.join(root, 'Birch Labs', 'Nest', 'y.txt'), 'w').write('y')
open(os.path.join(root, 'Birch Labs', 'Briefs', 'aaaa.txt'), 'w').write('a' * 60 + '!')

import unicodedata
nfd = unicodedata.normalize('NFD', 'Relatório de comissão ação.txt')
open(os.path.join(root, 'Birch Labs', 'Briefs', nfd), 'w').write('conteúdo decomposto NFD-MARKER-88')
print('legacy:', sorted(os.listdir(leg))); print('mail:', sorted(os.listdir(mail))); print('scans:', sorted(os.listdir(scans)))

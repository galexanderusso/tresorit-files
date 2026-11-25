# Material for the third-round tests (run after make_mock.py and make_mock2.py).
import os, shutil, zipfile, datetime, io, subprocess
from openpyxl import Workbook
from pptx import Presentation
from PIL import Image, ImageDraw, ImageFont
root = '/home/tester/build/mock/Tresors'
def d(*p):
    q = os.path.join(root, *p); os.makedirs(q, exist_ok=True); return q
real = d('Alder Works UK', '08 - Real files'); poi = '/home/tester/samples/poi/test-data'
for f in ['59021.xlsx', '65016.xlsx', '59746_NoRowNums.xlsx']: shutil.copy(f'{poi}/spreadsheet/{f}', real)
shutil.copy(f'{poi}/spreadsheet/craftonhills.edu_programreview_report.aspx_goalpriorityreport_0011d159-1eeb-4b63-8833-867b0926e5f3.xlsx', os.path.join(real, 'prefixed shared strings.xlsx'))
shutil.copy(f'{poi}/document/bug53475-password-is-pass.docx', os.path.join(real, 'locked.docx'))
pj = '/home/tester/samples/pdfjs/test/pdfs'
shutil.copy(f'{pj}/annotation-text-widget.pdf', os.path.join(real, 'filled form.pdf'))
shutil.copy(f'{pj}/issue15096.pdf', os.path.join(real, 'form with choices.pdf'))
enc = [f for f in os.listdir(pj) if 'encrypt' in f.lower()]
shutil.copy(f'{pj}/bug1782186.pdf', os.path.join(real, 'password.pdf'))
# spreadsheet with dates, times, percentages and plain numbers
wb = Workbook(); ws = wb.active; ws.title = 'Payments'
ws.append(['Due date', 'Paid at', 'Amount', 'Share', 'Duration', 'Serial-looking number'])
ws.append([datetime.date(2026, 10, 3), datetime.datetime(2026, 11, 9, 14, 30), 48213.5, 0.25, datetime.time(1, 15, 0), 46298])
ws['D2'].number_format = '0.00%'
wb.save(os.path.join(real, 'Payment dates.xlsx'))
subprocess.run(['soffice', '-env:UserInstallation=file:///home/tester/build/scratch/lo-profile', '--headless', '--convert-to', 'xls:MS Excel 97', '--outdir', real, os.path.join(real, 'Payment dates.xlsx')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
# deck whose slides were re-ordered after creation: shown order is C, A, B
prs = Presentation()
for name in ['ALPHA', 'BRAVO', 'CHARLIE']:
    s = prs.slides.add_slide(prs.slide_layouts[1]); s.shapes.title.text = f'Slide about {name}'; s.placeholders[1].text = f'Body of {name}'
    s.notes_slide.notes_text_frame.text = f'Notes for {name}'
lst = prs.slides._sldIdLst; ids = list(lst); lst.remove(ids[2]); lst.insert(0, ids[2])
prs.save(os.path.join(real, 'Reordered deck.pptx'))
# Word file with a text box stored twice (modern form + fallback for old programs)
doc_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="x" xmlns:v="y"><w:body>'
  '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="left" w:pos="1440"/></w:tabs></w:pPr><w:r><w:t>Before the box</w:t></w:r></w:p>'
  '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><wps:txbx><w:txbxContent><w:p><w:r><w:t>TEXTBOX-ONCE-4417</w:t></w:r></w:p></w:txbxContent></wps:txbx></mc:Choice>'
  '<mc:Fallback><v:textbox><w:txbxContent><w:p><w:r><w:t>TEXTBOX-ONCE-4417</w:t></w:r></w:p></w:txbxContent></v:textbox></mc:Fallback></mc:AlternateContent></w:r></w:p>'
  '<w:p><w:pPr/><w:r><w:t>After the box</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(os.path.join(real, 'Text box.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'); z.writestr('word/document.xml', doc_xml)
# zip bombs: tiny files that unpack to a very large document
def bomb(name, mb):
    body = '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>' + 'BOMB ' * 4 + '</w:t></w:r></w:p>'
    with zipfile.ZipFile(os.path.join(real, name), 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        with z.open('word/document.xml', 'w', force_zip64=True) as f:
            f.write(body.encode()); chunk = (b'<w:p><w:r><w:t>' + b'A' * 1000 + b'</w:t></w:r></w:p>') * 1000
            for _ in range(mb): f.write(chunk)
            f.write(b'</w:body></w:document>')
bomb('Bomb 300MB.docx', 300); bomb('Big 60MB.docx', 60)
# large plain-text files
big = d('Birch Labs', 'Large')
with open(os.path.join(big, 'seventeen megabytes.log'), 'w') as f:
    f.write('HEAD-MARKER-11\n'); line = 'x' * 99 + '\n'
    for _ in range(175000): f.write(line)
    f.write('TAIL-MARKER-99\n')
with open(os.path.join(big, 'twelve million chars.txt'), 'w') as f:
    f.write('START-MARKER-21\n' + ('word ' * 2400000) + '\nEND-MARKER-22\n')
# long scan for the interruption test (30 pages)
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 34)
pages = []
for p in range(30):
    im = Image.new('L', (1654, 2339), 255); dr = ImageDraw.Draw(im)
    for i in range(22): dr.text((150, 160 + 58 * i), f'Long scan page {p + 1} line {i + 1}: LONGSCAN-P{p + 1:02d} copper leach suppressant phosphate', fill=0, font=font)
    pages.append(im)
pages[0].save(os.path.join(root, 'Personal', 'Scans', 'Long scan.pdf'), 'PDF', resolution=200, quality=60, save_all=True, append_images=pages[1:])
# hostile file names
h = d('Birch Labs', 'Hostile names')
open(os.path.join(h, 'ok.txt\n[FILE] secret-looking   1 KB   2026-01-01 00-00.txt'), 'w').write('newline-name content NL-77')
open(os.path.join(h, 'bell\x07tab\tname.txt'), 'w').write('control chars')
open(os.path.join(h, 'ordinary.txt'), 'w').write('ordinary')
open(os.path.join(root, 'Birch Labs', 'Briefs', 'existing-file'), 'w').write('i am a file')
print('mock3 ready:', sorted(os.listdir(real)))

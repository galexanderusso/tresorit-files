import os, sys, shutil
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image

root = sys.argv[1]
shutil.rmtree(root, ignore_errors=True)
def d(*p):
    q = os.path.join(root, *p); os.makedirs(q, exist_ok=True); return q

pix = d('Alder Works UK')
rd = d('Alder Works UK', '07 - Research', 'ORBIT')
quar = d('Alder Works UK', '07 - Research', 'AB1150', '06_IP_quarantine')
fin = d('Alder Works UK', '03 - Finance')
priv = d('Personal', 'Tax')
d('Birch Labs', 'Briefs')
d('Strongbox')

# docx with table, accents, footnote-like text
doc = Document()
doc.add_heading('Acordo de Confidencialidade', 1)
doc.add_paragraph('Este acordo é celebrado entre a Alder Works e a Fundação Exemplo. A cláusula de não-divulgação aplica-se por cinco anos.')
t = doc.add_table(rows=2, cols=2)
t.cell(0,0).text = 'Produto'; t.cell(0,1).text = 'Preço'
t.cell(1,0).text = 'Megaphos'; t.cell(1,1).text = 'USD 1,250 & more <tagged>'
doc.save(os.path.join(fin, 'NDA Fundação Exemplo.docx'))

# xlsx
wb = Workbook(); ws = wb.active; ws.title = 'Commissions'
ws.append(['Customer', 'Invoice', 'Amount']); ws.append(['Kimia Test', 'INV-0042', 15250.5]); ws.append(['Zeta Mining', 'INV-0043', 880])
ws2 = wb.create_sheet('Notes'); ws2['B3'] = 'unicorn-keyword in a spreadsheet'
wb.save(os.path.join(fin, 'Commission tracker 2026.xlsx'))

# pptx
prs = Presentation()
s = prs.slides.add_slide(prs.slide_layouts[1]); s.shapes.title.text = 'ORBIT pilot results'; s.placeholders[1].text = 'Photonic sampling beat the classical baseline'
s.notes_slide.notes_text_frame.text = 'Remember to mention the provenance stamp'
s = prs.slides.add_slide(prs.slide_layouts[1]); s.shapes.title.text = 'Next steps'; s.placeholders[1].text = 'Scale to twelve qumodes'
prs.save(os.path.join(rd, 'ORBIT pilot deck.pptx'))

# multi-page pdf with text
c = canvas.Canvas(os.path.join(rd, 'ORBIT technical report.pdf'), pagesize=A4)
c.drawString(72, 800, 'ORBIT technical report'); c.drawString(72, 780, 'The boson sampling experiment used a unicorn-keyword marker.'); c.showPage()
c.drawString(72, 800, 'Page two discusses error mitigation and the provenance record.'); c.showPage(); c.save()

# long pdf for paging
c = canvas.Canvas(os.path.join(rd, 'Long appendix.pdf'), pagesize=A4)
for p in range(40):
    y = 800
    for i in range(45):
        c.drawString(40, y, f'Page {p+1} line {i+1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'); y -= 16
    c.showPage()
c.save()

# scanned-style pdf (image only, no text)
img = Image.new('RGB', (600, 800), 'white'); ip = os.path.join(root, '_tmp.png'); img.save(ip)
c = canvas.Canvas(os.path.join(priv, 'Scanned letter.pdf'), pagesize=A4); c.drawImage(ip, 0, 0, 595, 842); c.showPage(); c.save(); os.remove(ip)

open(os.path.join(rd, 'README.md'), 'w').write('# ORBIT\n\nShared brief for the pilot.\nStatus: green\nOwner: Morgan\n')
open(os.path.join(quar, 'novelty candidate.txt'), 'w').write('Pre-filing candidate: unicorn-keyword ester variant.\n')
open(os.path.join(priv, 'Self assessment 2024-25 notes.txt'), 'w').write('Notes for the return. Résumé of income sources.\n')
open(os.path.join(priv, 'legacy.doc'), 'wb').write(b'\xd0\xcf\x11\xe0 old binary word file')
open(os.path.join(fin, '.DS_Store'), 'w').write('junk')
open(os.path.join(fin, '~$NDA lock.docx'), 'w').write('junk')
Image.new('RGB', (64, 64), 'navy').save(os.path.join(priv, 'passport photo.png'))
# corrupt docx
open(os.path.join(fin, 'Broken file.docx'), 'wb').write(b'not a zip at all')
# symlink escaping the root
outside = os.path.join(os.path.dirname(root), 'outside-secret'); os.makedirs(outside, exist_ok=True)
open(os.path.join(outside, 'secret.txt'), 'w').write('TOP SECRET outside tresorit unicorn-keyword')
os.symlink(outside, os.path.join(pix, 'escape-link'))
# sparse "online only" file
with open(os.path.join(priv, 'Online only report.txt'), 'wb') as f: f.truncate(50000)
print('mock ready')

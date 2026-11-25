# Builds the document pool for the deep stress run: real documents of several kinds, each with its own marker.
import os, sys, json, hashlib, subprocess, random, shutil
from reportlab.pdfgen import canvas
from docx import Document
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]; shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
PWA, PWB = 'Senha-Alfa-7731', 'Senha-Beta-9904'
random.seed(4242); n = 0; items = []
def tok():
    global n; n += 1; return 'POOLTOK%06dX' % n
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
def pdf(path, t, extra=''):
    c = canvas.Canvas(path, pagesize=(420, 200)); c.setFont('Helvetica', 12)
    c.drawString(30, 160, 'Stress run document ' + extra); c.drawString(30, 135, 'Marker ' + t + ' on its own line.')
    c.drawString(30, 110, 'A third line so that the page counts as text, with more words to read.'); c.save()
def add(name, typ, t, pw=None): items.append({'file': name, 'type': typ, 'tok': t, 'sha': sha(os.path.join(out, name)), 'size': os.path.getsize(os.path.join(out, name)), **({'pw': pw} if pw else {})})
for i in range(220):
    t = tok(); name = 'pdf %03d.pdf' % i; pdf(os.path.join(out, name), t, str(i)); add(name, 'pdf', t)
for i in range(110):
    t = tok(); name = 'word %03d.docx' % i; d = Document(); d.add_heading('Stress run', 1); d.add_paragraph('Marker ' + t + ' in a Word file. Relatório de administração.'); d.save(os.path.join(out, name)); add(name, 'docx', t)
for i in range(110):
    t = tok(); name = 'sheet %03d.xlsx' % i; w = Workbook(); s = w.active; s['A1'] = 'Marker'; s['B1'] = t; s['A2'] = 'Amount'; s['B2'] = 1000 + i; w.save(os.path.join(out, name)); add(name, 'xlsx', t)
for i in range(160):
    t = tok(); ext = ['txt', 'md', 'csv'][i % 3]; name = 'note %03d.%s' % (i, ext); open(os.path.join(out, name), 'w').write('Stress run note.\nMarker %s\nLinha com acentuação: relatório.\n' % t); add(name, 'text', t)
for i in range(60):
    t = tok(); pw = PWA if i < 40 else PWB; name = 'locked %s %03d.pdf' % ('A' if i < 40 else 'B', i); pdf('/tmp/pool-plain.pdf', t, 'protected')
    subprocess.run(['qpdf', '--encrypt', pw, 'owner-' + pw, '256', '--', '/tmp/pool-plain.pdf', os.path.join(out, name)], check=True); add(name, 'locked', t, 'A' if i < 40 else 'B')
for i in range(30):
    t = tok(); name = 'text as pdf %03d.pdf' % i; open(os.path.join(out, name), 'w').write('Plain text saved with the ending pdf.\nMarker %s here.\n' % t); add(name, 'text-as-pdf', t)
for i in range(30):
    t = tok(); name = 'pdf as docx %03d.docx' % i; pdf(os.path.join(out, name), t, 'disguised'); add(name, 'pdf-as-docx', t)
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 34)
for i in range(14):
    num = str(random.randint(100000, 999999)); t = 'Invoice number ' + num; name = 'picture %03d.pdf' % i
    im = Image.new('L', (900, 220), 255); dr = ImageDraw.Draw(im); dr.text((40, 40), t, fill=0, font=font); dr.text((40, 120), 'Total due %d pounds' % (1000 + i), fill=0, font=font); im.save(os.path.join(out, name), format='PNG'); add(name, 'picture', num)
json.dump({'pwA': PWA, 'pwB': PWB, 'items': items}, open(os.path.join(out, 'pool.json'), 'w'))
print(len(items), 'documents')

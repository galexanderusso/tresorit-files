# A library of the real size and shape: about 30,000 readable documents plus the 171 that 1.3.5 could not read.
import os, sys, shutil, subprocess, random
from reportlab.pdfgen import canvas
B = '/home/tester/build/mock/data-big'; R = B + '/Tresors'; FX = '/home/tester/build/mock/data-fx14'
S = '/home/tester/build/tresorit-connector/server/preflight/samples'
N = int(sys.argv[1]) if len(sys.argv) > 1 else 30000
shutil.rmtree(B, ignore_errors=True)
random.seed(7)
tresors = ['Alder Works UK', 'Personal', 'Birch Labs']
for t in tresors + ['Strongbox']: os.makedirs(f'{R}/{t}', exist_ok=True)
os.makedirs(f'{R}/Personal/16 - Secrets', exist_ok=True)
open(f'{R}/Strongbox/seed.txt', 'w').write('not to be indexed BIGSECRET-1')
open(f'{R}/Personal/16 - Secrets/list.txt', 'w').write('not to be indexed BIGSECRET-2')
others = [('sample.docx', 'docx'), ('sample.xlsx', 'xlsx'), ('sample.pptx', 'pptx'), ('sample.doc', 'doc')]
for i in range(N):
    t = tresors[i % 3]; d = f'{R}/{t}/{(i // 3) % 40:02d} - Area/{(i // 120) % 25:02d}'
    os.makedirs(d, exist_ok=True)
    if i % 5 == 4:
        s, e = others[(i // 5) % 4]; shutil.copyfile(f'{S}/{s}', f'{d}/Document {i:05d}.{e}')
    else:
        c = canvas.Canvas(f'{d}/Report {i:05d}.pdf', pagesize=(400, 200)); c.setFont('Helvetica', 11)
        c.drawString(30, 150, f'Report number {i} for the big library'); c.drawString(30, 130, f'Marker BIG-{i:05d} amount {1000 + i}'); c.save()
# the 171
bills = f'{R}/Personal/04 - Travel/Old bills'; tax = f'{R}/Personal/02 - Tax/UK returns'; odd = f'{R}/Alder Works UK/09 - Archive/Odd files'
for d in (bills, tax, odd): os.makedirs(d, exist_ok=True)
pw1 = open(f'{FX}/pw.txt').read(); pw2 = 'Second-Senha-551-xQ'
open(f'{B}/pw1.txt', 'w').write(pw1); open(f'{B}/pw2.txt', 'w').write(pw2)
def locked(dst, text, pw):
    c = canvas.Canvas('/tmp/big-plain.pdf', pagesize=(400, 200)); c.setFont('Helvetica', 11); c.drawString(30, 150, text); c.save()
    subprocess.run(['qpdf', '--encrypt', pw, 'o', '256', '--', '/tmp/big-plain.pdf', dst], check=True)
for i in range(138): locked(f'{bills}/Boleto {i:03d}.pdf', f'Boleto de cobranca LOCKED-B-{i:03d} valor {i}', pw1)
for i in range(4): locked(f'{tax}/Tax return {2019 + i}.pdf', f'Self assessment LOCKED-T-{i:03d}', pw2)
for i in range(9): shutil.copyfile(f'{FX}/page.png', f'{odd}/Scan picture {i}.pdf')
for i in range(4): shutil.copyfile(f'{FX}/page.jpg', f'{odd}/Photo {i}.pdf')
for i in range(2): shutil.copyfile(f'{FX}/page.webarchive', f'{odd}/Saved page {i}.pdf')
shutil.copyfile(f'{FX}/page.html', f'{odd}/Web page.pdf')
shutil.copyfile(f'{S}/sample.xlsx', f'{odd}/Sheet.pdf'); shutil.copyfile(f'{S}/sample.doc', f'{odd}/Old office.pdf'); shutil.copyfile(f'{S}/sample.ppt', f'{odd}/Message.pdf')
shutil.copyfile(f'{S}/sample.pdf', f'{odd}/Really a pdf.docx')
data = open(f'{S}/sample.pdf', 'rb').read()
for i in range(4): open(f'{odd}/Cut off {i}.pdf', 'wb').write(data[: len(data) // (i + 2)])
shutil.copyfile(f'{FX}/pointer.xml', f'{odd}/Pointer.pdf')
for i in range(3): open(f'{odd}/Empty {i}.pdf', 'wb').close()
for i in range(2): open(f'{odd}/Bad zip {i}.docx', 'wb').write(b'PK\x03\x04' + os.urandom(900))
print('made', N, 'documents and 171 problem files')

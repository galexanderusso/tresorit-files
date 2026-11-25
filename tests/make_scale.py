import os, random
from reportlab.pdfgen import canvas
from docx import Document
root='/home/tester/build/mock/Tresors/Alder Works UK/99 - Scale test'
random.seed(1)
words='copper leach suppressant phosphate ester mining agritech invoice shipment certificate analysis glycine chelate tankhouse lithium solvent contract customer supplier'.split()
n=0
for a in range(40):
    for b in range(20):
        d=os.path.join(root,f'area {a:02d}',f'sub {b:02d}'); os.makedirs(d,exist_ok=True)
        for c in range(28):
            n+=1
            open(os.path.join(d,f'{random.choice(words)} {random.choice(words)} {n}.dat'),'wb').write(b'x'*10)
        open(os.path.join(d,f'notes {a}-{b}.txt'),'w').write(' '.join(random.choice(words) for _ in range(400))+ (' needle-zebra-42' if (a,b)==(17,3) else ''))
for i in range(300):
    d=os.path.join(root,f'area {i%40:02d}','docs'); os.makedirs(d,exist_ok=True)
    c=canvas.Canvas(os.path.join(d,f'report {i}.pdf'))
    for p in range(5):
        y=800
        for l in range(40):
            c.drawString(40,y,' '.join(random.choice(words) for _ in range(10))+(' needle-zebra-42' if i==123 and p==3 and l==7 else '')); y-=18
        c.showPage()
    c.save()
    doc=Document()
    for p in range(30): doc.add_paragraph(' '.join(random.choice(words) for _ in range(60)))
    doc.save(os.path.join(d,f'memo {i}.docx'))

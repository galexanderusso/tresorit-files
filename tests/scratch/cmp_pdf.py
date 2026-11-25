import os, re, subprocess, json, sys
D='/home/tester/samples/pdfjs/test/pdfs'
tok=lambda s:set(t.lower() for t in re.findall(r'[^\W_]{3,}', s or '', re.UNICODE))
scans={s['f']:s for s in json.load(open('pdf_scans.json'))}
recs=[]; low=[]; missed=[]; n=0; ref_fail=0
for f in sorted(os.listdir(D)):
    if not f.endswith('.pdf'): continue
    try:
        r=subprocess.run(['pdftotext','-q',os.path.join(D,f),'-'],capture_output=True,timeout=20)
        ref=r.stdout.decode('utf-8','replace')
    except Exception: ref_fail+=1; continue
    rt=tok(ref)
    op=f'ours-pdf/{f}.txt'
    if not os.path.exists(op):
        if len(rt)>=8: missed.append((f,len(rt), scans.get(f,{}).get('status','error/other')))
        continue
    if len(rt)<8: continue
    o=tok(open(op,encoding='utf-8',errors='replace').read())
    rec=len(rt&o)/len(rt); recs.append(rec); n+=1
    if rec<0.9: low.append((round(rec,2),f,len(rt),sorted(rt-o)[:5]))
recs.sort()
print(f'{n} PDFs compared with pdftotext; word recall mean {sum(recs)/n:.4f}, median {recs[n//2]:.3f}; >=0.98: {sum(x>=0.98 for x in recs)}, 0.9-0.98: {sum(0.9<=x<0.98 for x in recs)}, <0.9: {sum(x<0.9 for x in recs)}')
for l in sorted(low)[:12]: print('   low:', l)
print(f'pdftotext found text (8+ words) where we returned none: {len(missed)}')
for m in missed[:25]: print('   ', m)

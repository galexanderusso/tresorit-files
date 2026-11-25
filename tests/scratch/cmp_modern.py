import os, re, sys, warnings, zipfile
warnings.filterwarnings('ignore')
import docx
from openpyxl import load_workbook
from pptx import Presentation
P='/home/tester/samples/poi/test-data'
tok = lambda s: set(t.lower() for t in re.findall(r'[^\W_]{3,}', s or '', re.UNICODE))
def ref_docx(p):
    d=docx.Document(p); out=[]
    def body(parent):
        for para in parent.paragraphs: out.append(para.text)
        for t in parent.tables:
            for r in t.rows:
                for c in r.cells: body(c)
    body(d); return '\n'.join(out)
def ref_xlsx(p):
    wb=load_workbook(p,data_only=True,read_only=True); out=[]
    for ws in wb.worksheets:
        if not hasattr(ws,'iter_rows'): continue
        for row in ws.iter_rows(values_only=True):
            for v in row:
                if isinstance(v,str): out.append(v)
    return '\n'.join(out)
def ref_pptx(p):
    prs=Presentation(p); out=[]
    def shp(shapes):
        for sh in shapes:
            if sh.shape_type==6: shp(sh.shapes)
            if sh.has_text_frame: out.append(sh.text_frame.text)
            if getattr(sh,'has_table',False) and sh.has_table:
                for r in sh.table.rows:
                    for c in r.cells: out.append(c.text_frame.text)
    for sl in prs.slides:
        shp(sl.shapes)
        if sl.has_notes_slide and sl.notes_slide.notes_text_frame is not None: out.append(sl.notes_slide.notes_text_frame.text)
    return '\n'.join(out)
for kind,d,fn in (('docx','document',ref_docx),('xlsx','spreadsheet',ref_xlsx),('pptx','slideshow',ref_pptx)):
    recs=[]; bad=[]; missed=[]; refuse_ok=0; n_ref_fail=0
    for f in sorted(os.listdir(f'{P}/{d}')):
        if not f.lower().endswith('.'+kind): continue
        ours_p=f'ours-{kind}/{f}.txt'
        try: r=tok(fn(f'{P}/{d}/{f}'))
        except Exception as e:
            n_ref_fail+=1; continue
        if not os.path.exists(ours_p):
            if len(r)>=3: missed.append((f,len(r)))
            continue
        o=tok(open(ours_p,encoding='utf-8',errors='replace').read())
        if len(r)<3: continue
        rec=len(r&o)/len(r); recs.append(rec)
        if rec<0.95: bad.append((round(rec,2),f,len(r),sorted(r-o)[:6]))
    recs.sort(); n=len(recs)
    print(f'{kind}: {n} compared; word recall mean {sum(recs)/n:.4f}, median {recs[n//2]:.3f}; >=0.98: {sum(x>=0.98 for x in recs)}, 0.95-0.98: {sum(0.95<=x<0.98 for x in recs)}, <0.95: {sum(x<0.95 for x in recs)}; reference reader itself failed on {n_ref_fail}')
    for b in sorted(bad)[:10]: print('     low:', b)
    for m in missed[:12]: print('     WE RETURNED NOTHING but reference found text:', m)

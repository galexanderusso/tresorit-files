import os, re, sys, json, warnings
warnings.filterwarnings('ignore')
from openpyxl import load_workbook
from pptx import Presentation
from pptx.util import Inches
tok = lambda s: set(t.lower() for t in re.findall(r'[^\W_]{3,}', s, re.UNICODE))
def ref_text(kind, path):
    if kind == 'doc': return open(path, encoding='utf-8', errors='replace').read()
    if kind == 'xls':
        wb = load_workbook(path, data_only=True, read_only=True); out=[]
        for ws in wb.worksheets:
            for row in ws.iter_rows(values_only=True):
                for v in row:
                    if isinstance(v, str): out.append(v)
        return '\n'.join(out)
    if kind == 'ppt':
        prs = Presentation(path); out=[]
        def shp(shapes):
            for sh in shapes:
                if sh.shape_type == 6: shp(sh.shapes)
                if sh.has_text_frame: out.append(sh.text_frame.text)
                if getattr(sh, 'has_table', False) and sh.has_table:
                    for r in sh.table.rows:
                        for c in r.cells: out.append(c.text_frame.text)
        for sl in prs.slides:
            shp(sl.shapes)
            if sl.has_notes_slide: out.append(sl.notes_slide.notes_text_frame.text if sl.notes_slide.notes_text_frame else '')
        return '\n'.join(out)
for kind, ext in (('doc','txt'),('xls','xlsx'),('ppt','pptx')):
    recs=[]; bad=[]
    for f in sorted(os.listdir(f'ref/{kind}')):
        base = f[:-len(ext)-1]
        ours_p = f'ours-{kind}/{base}.{kind}.txt'
        if not os.path.exists(ours_p):
            cand=[x for x in os.listdir(f'ours-{kind}') if x.lower()==f'{base}.{kind}.txt'.lower()]
            if not cand: continue
            ours_p=f'ours-{kind}/{cand[0]}'
        try: r = tok(ref_text(kind, f'ref/{kind}/{f}'))
        except Exception as e: continue
        o = tok(open(ours_p, encoding='utf-8', errors='replace').read())
        if len(r) < 3: continue
        recall = len(r & o)/len(r); extra = len(o - r)/max(len(o),1)
        recs.append(recall)
        if recall < 0.9: bad.append((round(recall,2), base, len(r), sorted(r-o)[:8]))
    recs.sort()
    n=len(recs)
    print(f'{kind}: {n} files compared; word recall median {recs[n//2]:.3f}, mean {sum(recs)/n:.3f}; >=0.98: {sum(x>=0.98 for x in recs)}, 0.9-0.98: {sum(0.9<=x<0.98 for x in recs)}, <0.9: {sum(x<0.9 for x in recs)}')
    for b in sorted(bad)[:14]: print('    ', b)

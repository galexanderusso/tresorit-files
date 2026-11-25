import sys, json, glob, warnings, logging
warnings.filterwarnings('ignore'); logging.disable(logging.CRITICAL)
import extract_msg
out = {}
for f in sys.argv[1:]:
    try:
        m = extract_msg.openMsg(f)
        d = {'cls': type(m).__name__}
        for k in ('subject', 'sender', 'to', 'cc', 'body'):
            try: d[k] = getattr(m, k, None)
            except Exception as e: d[k] = None
        try: d['date'] = str(m.date)
        except Exception: d['date'] = None
        try: d['att'] = [ (a.longFilename or a.shortFilename or '') if hasattr(a,'longFilename') else '' for a in m.attachments]
        except Exception: d['att'] = None
        out[f] = d
        m.close()
    except Exception as e:
        out[f] = {'error': str(e)[:120]}
json.dump(out, open('/home/tester/build/scratch/msg_ref.json', 'w'), default=str)
print(len(out), 'reference results')

#!/bin/bash
# The checks made on the unpacked bundle before a release, one after the other (they share the test library).
cd /home/tester/build
export PATH=/home/tester/build/tools/node_modules/.bin:$PATH
export NODE_OPTIONS= SERVER=/home/tester/build/final/server/index.js
M=/home/tester/build/mock/Tresors
mock() { python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; }
echo "== network trace"; mock; TRESORIT_PREFLIGHT_GATE=off timeout 500 node scratch/net13.mjs 2>&1 | cut -c1-150 | sed -n '1p;7,20p'; echo "network calls: $(grep -vE 'AF_UNIX|AF_NETLINK|ENOENT' /tmp/net13.trace | grep -cE 'connect\(|AF_INET|sendto\(|bind\(') (trace lines: $(wc -l < /tmp/net13.trace))"
echo "== tool list"; node scratch/toolcheck.mjs final 2>&1 | head -4 | cut -c1-200
echo "== self-check from a path with spaces and accents"; mock; D="/tmp/Aplicação de teste (cópia 2)/Claude Extensions/tresorit local"; rm -rf "/tmp/Aplicação de teste (cópia 2)"; mkdir -p "$D" && cp -R final/. "$D/" && (unset TRESORIT_PREFLIGHT_GATE; SERVER="$D/server/index.js" timeout 400 node scratch/pf.mjs 2>&1 | grep -E "before check|RESULT|after check" | cut -c1-160)
echo "== self-check while busy with a large library"; mock; python3 make_mock3.py >/dev/null 2>&1; python3 make_scale.py >/dev/null 2>&1; (unset TRESORIT_PREFLIGHT_GATE; timeout 560 node scratch/pf_busy.mjs 2>&1 | cut -c1-220 | tail -4)
echo "== three copies on the large library"; TRESORIT_PREFLIGHT_GATE=off timeout 570 node scratch/scale3.mjs 2>&1 | cut -c1-300
echo "== search answers against 1.1.1"; mock; TRESORIT_PREFLIGHT_GATE=off node scratch/diffsearch2.mjs ref111/server/index.js final/server/index.js 2>&1 | cut -c1-260 | head -5
echo "== the update from 1.3.5 at real size, three copies"; timeout 580 node scratch/bigup.mjs 2>&1 | cut -c1-520
echo RELEASE-DONE

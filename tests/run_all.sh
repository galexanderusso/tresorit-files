#!/bin/bash
# Runs every suite against the unpacked bundle, with the same Node settings as the Mac (no enlarged memory option).
cd /home/tester/build
export PATH=/home/tester/build/tools/node_modules/.bin:$PATH
export NODE_OPTIONS= SERVER=/home/tester/build/final/server/index.js TRESORIT_PREFLIGHT_GATE=off
M=/home/tester/build/mock/Tresors
run() { echo "== $1"; timeout ${2:-900} node $1 2>&1 | grep -E "FAIL|passed, " -A2; echo "   (exit ${PIPESTATUS[0]})"; }
python3 make_mock.py $M >/dev/null; run test.mjs; run test2.mjs
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test5.mjs; run test6.mjs; run test8.mjs
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; python3 make_mock3.py >/dev/null 2>&1; python3 make_scale.py >/dev/null 2>&1; run test7.mjs; run test3.mjs; run test10.mjs 1200
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test11.mjs
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test12.mjs
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test13.mjs 1500
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test14.mjs 1500
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test16.mjs 1800
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test15.mjs 3600
python3 make_mock.py $M >/dev/null; python3 make_mock2.py >/dev/null; run test17.mjs 2400
python3 make_mock.py $M >/dev/null; run test9.mjs
echo ALL-DONE

# The tests

Everything used to test the connector outside its built-in self-check. None of it is in the `.mcpb` bundle.

The tests never work on a real Tresorit folder. They build a test library with invented names and documents in
a scratch folder, start the real connector on it, and judge its replies and the files on disk.

## Running them

From the top folder of the project, with Node 20 or newer (the runs on record used Node 24):

    node tools/check.mjs quick     about 15 seconds: the structure checks and the two shortest suites
    node tools/check.mjs full      everything: the self-check and all suites, about half an hour

Both work in scratch folders under `work/`. Never start two runs at once.

One group of suites by hand:

    export TEST_BASE="$PWD/work/base" SERVER="$PWD/connector/server/index.js" TRESORIT_PREFLIGHT_GATE=off NODE_OPTIONS=
    node tests/lib/run.mjs A test test2
    node tests/lib/run.mjs B test5 test6 test8

- `TEST_BASE` is the scratch folder that receives the test library (`mock/`) and the results (`results/`). A
  place inside a real Tresorit folder, a real data folder or the Library is refused.
- `SERVER` is `server/index.js` of the connector under test. The MCP client and every module are taken from the
  bundle that `SERVER` belongs to. To test a packed bundle, unpack it and point `SERVER` at the unpacked copy
  (`node tools/check.mjs full --connector <unpacked folder>` does the same).
- `node tests/lib/run.mjs A|B|C suite[:seconds] ...` restores a fresh library and runs the suites one after the
  other. Each prints one summary line, with the number of parts it skipped.

`tools/expected/suites.json` holds what each suite gives on a Mac: `check.mjs` compares a run with it.

## What is here

| Part | What it is |
| --- | --- |
| `test.mjs` ... `test18.mjs` | 17 suites. Each starts the real server over stdio with the MCP client from the bundle. |
| `lib/` | `env.mjs` (where the tests work, and the stand-ins they set), `run.mjs`, `restore-library.mjs`, and the stand-ins for the confirmation window and the password box. |
| `library/` | Three ready-made test libraries (A, B and C, each containing the one before) and three very large documents for `test10`. |
| `fixtures/data-fx14` | Small fixed files: protected PDFs of several encryption kinds, pictures, a web archive, with their throwaway passwords. |
| `index-strict/` | The strict test of the search index under several copies of the connector. |
| `scratch/` | Helpers that the suites start (`probe*.mjs`, `soak143.mjs`, `vision-stub.mjs`, `vision-wrong.mjs`, `oldworker150.mjs`, `gone150.mjs`, `twopass150.mjs`), the sample scans in `scratch/ocr/`, and earlier one-off scripts kept as a record (see "Scripts with a fixed work folder"). |
| `make_mock.py`, `make_mock2.py`, `make_mock3.py`, `make_scale.py`, `scratch/make_big.py`, `scratch/make_pool.py` | The generators of the test libraries. They are the record of how the libraries were made; running the tests does not need them. |
| `run_all.sh`, `release_checks.sh`, `build_bundle.sh` | Earlier shell scripts, kept as a record. `lib/run.mjs` and `tools/check.mjs` replace the first; the note on pruning below replaces the last. |

## What each suite covers

- `test`, `test2`: the basic tools, path safety, the two-step delete, the holding area, restore, the access log.
- `test5`, `test6`, `test7`, `test8`: old Office formats, Outlook messages, text recognition (the bundled engine
  and the stand-in for the Mac's), memory limits, large and damaged files.
- `test3`, `test10`: scale (thousands of files), search time, the search form files.
- `test11`: bringing files in from the Mac and copying out: every refusal, previews, moves with the original
  kept, the self-check gate.
- `test12`: all-or-nothing behaviour when the connector is stopped in the middle of an operation.
- `test13`: several copies of the connector at once (the shared lock, the shared index).
- `test14`: reading by content, reasons for unreadable files, passwords, the transfer folder, identical files.
- `test15`: 2,500 malformed files, 142 protected PDFs, races between three copies.
- `test16`: the holding area that clears itself, with every edge of dates and records.
- `test17`: files recorded as damaged after a momentary failure, the holding list, ending with a stress run of
  three minutes.
- `test18`: the checks of version 1.5.0, one part per change (the lock that guards the saving of the index,
  names Tresorit would not sync, the window before a folder is copied out, the safeguard for the folders that
  are not to be indexed, and others).
- `test9`: a last pass over the tool list and the instructions sent to Claude, and an endurance run.

## What a run needs, and what differs by computer

- **Stand-ins.** `lib/env.mjs` sets, for every server a test starts: `TRESORIT_CONFIRM_CMD` (a stand-in that
  presses the button the test asks for) and, on a Mac, `TRESORIT_HOME_DIR`, `TRESORIT_IMPORT_ROOTS` and
  `TRESORIT_PASSWORD_CMD`, so that no test looks into the real home folder or opens a real window. If you start
  the connector yourself on a Mac for a test, set them too.
- **`test6`** checks nothing on a Mac: it needs a second disk and `strace`, and runs on Linux.
- **`test15`** and `scratch/make_pool.py` need `qpdf`.
- **`test14`, part B** (3 checks) follows an update from version 1.3.5 and needs an unpacked copy of that
  version in `<TEST_BASE>/ref135`. That version is not published. Without it the part is skipped, the suite
  gives 53 checks instead of 56, and `tools/check.mjs full` counts that as passed, with one line: "1 part
  skipped: it needs an earlier version that is not published".
- **`test10`** uses three very large documents. `lib/restore-library.mjs C` unpacks them into `scratch/big/`
  from `library/test10-large-documents.tar.gz` when they are not there.
- **Disks.** On a Mac the disk ignores capitals and treats the two accent encodings as one name; on Linux it
  does not. Where an expectation differs, the test allows for it by platform.
- **Memory.** `test7` allows 900 MB after indexing on a Mac and 700 MB on Linux. The figure is taken with `ps`
  on a Mac and from `/proc` on Linux, and it moves by more than 100 MB from run to run on a Mac.
- **Load.** A few checks measure time. On a Mac that is busy with other work they can fail and pass when the
  suite is run again.
- **Timing hooks** used by the tests (they change timing only): `TRESORIT_INDEX_DELAY_MS`,
  `TRESORIT_INDEX_INTERVAL_MS`, `TRESORIT_HOLDING_FIRST_MS`, `TRESORIT_HOLDING_SWEEP_MS`,
  `TRESORIT_STAGING_MAX_AGE_MS`, `TRESORIT_OCR_WAIT_MS`, `TRESORIT_ELICIT_TIMEOUT_MS`.
  `TRESORIT_PREFLIGHT_GATE=off` skips the self-check gate and the safeguard's question.

## The test libraries

`node tests/lib/restore-library.mjs A|B|C` puts a clean library in `<TEST_BASE>/mock` from
`library/test-library-*.tar.gz`. It points the link `escape-link` at the restored `outside-secret` (the library
holds one link that leads outside on purpose, and one that leads nowhere), makes the "online only" file hollow
again, and copies `fixtures/data-fx14` beside the library.

All names and documents in the libraries are invented. The generators copied some of their material from
public collections that are not included here: the Apache POI test data, the pdf.js test PDFs and two
collections of example Outlook messages. To run the generators you would also need LibreOffice (`soffice`),
`qpdf`, and the Python packages `reportlab`, `python-docx`, `openpyxl`, `Pillow` and `pikepdf`.

## Scripts with a fixed work folder

The generators, the three shell scripts and the one-off scripts in `scratch/` that no suite starts have a
fixed work folder written into them, `/home/tester/build`, with the tests in that folder, the library in
`mock/Tresors` and an unpacked bundle beside them. They are kept as a record of checks that were made (network
trace, comparisons of search answers between versions, memory probes, long stress runs). To run one, change
that folder to yours. The suites and the helpers they start do not use it: they read `TEST_BASE` and `SERVER`.

`scratch/soak143.mjs` (started by `test17`, and usable alone: `node scratch/soak143.mjs <minutes> <seed>`) is
the stress run: three copies of the connector work at random on text files, each in its own lane plus a shared
lane where they compete, with sudden stops, and the test compares its own record with the disk, the log and
search. `scratch/soak2.mjs` does the same on real documents and every feature; it is one of the scripts with
the fixed folder.

## Rules that kept the runs honest

- Never run two things on the same test library at once.
- Run the suites against the unpacked bundle, not only the source tree, and compare the two first.
- A new check must be seen to fail on the code before the change it belongs to.
- The tests match on the wording of replies and log lines. A failure after a wording change is the signal to
  decide whether the wording or the test should change.

## Pruning of the bundle (important if dependencies are ever reinstalled)

`connector/node_modules` is not what `npm install` gives. After the production dependencies were installed,
code that is not needed and that could make network connections was removed: `node-fetch`, `whatwg-url`,
`tr46`, `webidl-conversions`, `idb-keyval`, `opencollective-postinstall`, the browser builds of the
text-recognition engine (`*.wasm.js`) and the `dist`, `docs`, `examples` and `scripts` folders of
`tesseract.js`. The language data for text recognition is inside the bundle so that nothing is ever
downloaded. `build_bundle.sh` shows the steps as they were first made. Packing by zipping `connector/` keeps
all this. A fresh `npm install` does not: repeat the pruning and the network check, and record the new
fingerprint with `node tools/check.mjs record`.

`tools/expected/node_modules.sha256` is the fingerprint of the folder as it is in the bundle, and
`node tools/check.mjs quick` compares the folder with it.

## Results on record for version 1.5.0

- On a Mac with Apple silicon, against the unpacked bundle: the self-check 111 of 111; the suites 722 of 722
  (`test` 96, `test2` 22, `test5` 76, `test8` 20, `test11` 96, `test12` 67, `test13` 31, `test14` 56, `test16` 42,
  `test17` 29, `test7` 60, `test3` 9, `test10` 26, `test9` 18, `test18` 74). `test6` checks nothing on a Mac;
  `test15` was not run there.
- On Linux: the self-check 110 of 110; the suites 743 of 743 (the same, with `test6` 7 and `test15` 14).
- On Linux, checks made once per release with scripts that are not all in this folder: no network connection in
  a system-call trace; the tool list against the manifest; the self-check from a path with spaces and accents;
  an update at the size of a real library (30,000 documents, three copies); two stress runs of 8 and 12
  minutes (13,246 and 50,497 operations, with sudden stops, no anomaly).

## What the tests do not cover

- The real confirmation window of macOS and a real confirmation box of the Claude app: every test answers
  through a stand-in.
- What Tresorit itself syncs.
- A computer that has neither a window, nor a stand-in, nor a box of the app: no check for that case is written
  yet.

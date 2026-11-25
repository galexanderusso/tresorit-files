# Tresorit Files: a connector between Claude and your Tresorit folder

Lets Claude work with the Tresorit folder that the Tresorit app keeps synced on your Mac: browse, find by name,
search inside documents (PDF including scans, Word, Excel, PowerPoint, Outlook messages, text), read, write,
move, copy and, with your permission each time, delete.

Nothing is sent anywhere by this connector. It reads and writes local files only, so Tresorit's end-to-end
encryption is not affected. It does not use the Tresorit API or your Tresorit password, and it makes no network
connections at all.

This is an unofficial project. It is not made, endorsed or supported by the company Tresorit, whose name is its
trademark.

## What you need

- A Mac. The connector is offered for macOS only.
- The Claude desktop app.
- The Tresorit app, with your tresors synced to a folder on that Mac.

## Install

1. Download `tresorit-files-1.5.0.mcpb` from the Releases page of this project. The release gives the file's
   SHA-256 fingerprint; on a Mac, `shasum -a 256` followed by the file shows it.
2. Double-click the file, or in the Claude desktop app go to Settings > Extensions > Advanced settings >
   Install Extension and choose the file.
3. All settings can be left empty. If you want to set any (see below), open the settings of "Tresorit Files"
   under Settings > Extensions: the app may not show them by itself. Then quit Claude and open it again.
4. Run the self-check (next section).

## First use: the self-check

After installing, and again after each update, the connector is read-only: it can list, find, search and read,
but refuses to save, edit, move, copy, delete or restore. Ask Claude to "run the Tresorit self-check". It runs
more than 100 tests on a scratch folder inside the connector's own data folder, changes nothing in Tresorit and
takes under a minute. When every essential test passes, changes are unlocked on that Mac.

At the end of the first self-check a window on your Mac lists the folders that will not be read into the search
index, and waits for your yes before any document is read into it.

## Settings

All are optional.

- **Tresorit folder**: found automatically (`~/Tresors`, or the Tresorit entry in `~/Library/CloudStorage`).
- **Connector data folder**: default `~/TresoritConnector`. It must be outside Tresorit. It holds the search
  index, the access log, the holding area for deleted and replaced items, and a transfer folder.
- **Blocked folders**: folders the connector may never touch, separated by `;`, for example
  `Finance/Payroll; Company/Projects/Archive 2019`.
- **Folders not to index**: folders whose documents are never copied into the search index and never searched.
  A file in them can still be opened when you ask for it by name. For example `Finance/Payroll; Private/Passwords`.
  Enter them before the first self-check. The two fields stand one above the other and look alike: mind which
  one you fill in.
- **Background reading**, **text recognition for scanned PDFs**, **go easy on the battery**: on by default.
- **Clear the holding area after (days)**: 30 by default; 0 means never.

## The safety rules, in short

- Every path is checked to be inside the Tresorit folder. Links that point outside are refused.
- Nothing is overwritten unless asked, and the previous version is then kept in the holding area.
- Deleting takes two steps in the conversation and one more outside it: a confirmation window on the Mac (or a
  box of the Claude app where it shows one), where "Keep" is the default. Only an explicit yes deletes. Deleted items go to the holding area and can be brought
  back.
- A whole folder is copied out of Tresorit only after a yes in such a window.
- Replacing or editing a file is all or nothing, also when the Mac loses power at that instant.
- No changes at all until the self-check has passed on that Mac for that version.
- Every file opened, searched, written, moved or deleted is written to an access log on the Mac.
- Document passwords are typed into a box on the Mac, never into the conversation, and are kept nowhere.

The full list, the limits and what each version brought are in [connector/README.md](connector/README.md),
which is also the README inside the bundle.

## Limits

- It works only while the Mac is on and the Claude desktop app is open.
- The search index is a copy of the text of your documents on that Mac, outside Tresorit, in the data folder
  (readable by your user account only). Folders set as "not to index" are kept out of it.
- Text from scanned pages comes from text recognition and can contain errors, especially in figures.
- Password-protected files other than PDFs, very old Word and Excel formats and a few other kinds cannot be
  read; the connector lists what it could not read, with the reason.

## What was tested, and what was not

Tested, for version 1.5.0:

- The self-check on a Mac: 111 of 111.
- The test suites in `tests/`: 722 checks on a Mac with Apple silicon, 743 on Linux (two suites were run on
  Linux only), all passed.
- On Linux, under a system-call trace: no network connection was attempted.
- Long runs with several copies of the connector working at random on the same folder, with sudden stops: no
  file lost or damaged, no anomaly.
- An update from earlier versions, on data folders those versions had left.

Not tested:

- No automated test opens the real confirmation window of macOS or a confirmation box of the Claude app: the
  tests answer through stand-ins. The windows have been seen working in real use, on one Mac.
- What Tresorit itself syncs or leaves out. The names the connector refuses to create are taken from the list
  Tresorit publishes ("Files excluded from sync").
- Macs with Intel processors, and versions of macOS other than the one on the test Mac.
- Windows and Linux as places to use it. The suites run on Linux, but the connector is not offered there.

## What is in this repository

- `connector/`: the program, laid out exactly as the bundle. `connector/node_modules` holds the bundled
  libraries, reduced by hand so that nothing in them can open a network connection (see `tests/README-TESTS.md`,
  "Pruning of the bundle"). Do not run `npm install` there.
- `tests/`: the test suites, their helpers and three ready-made test libraries with invented names and
  documents. See [tests/README-TESTS.md](tests/README-TESTS.md).
- `tools/`: `check.mjs`, which runs the checks, and what it needs.

## Building the bundle yourself

The bundle is a plain zip of `connector/`:

    cd connector
    zip -q -r -X ../tresorit-files-1.5.0.mcpb .

Unpacked, the result holds the same files with the same contents as the released file. (The two zip files
themselves differ, because a zip records the time each file was packed.) `node tools/check.mjs quick` compares
`connector/node_modules` with the fingerprint recorded in `tools/expected/` and runs the two shortest suites;
`node tools/check.mjs full` runs everything and takes about half an hour.

## Support

Extensively tested. Provided as it is, without warranty. For questions or problems, open an issue in this
project; they are answered as time allows.

## Licence

MIT: see the file `LICENSE`. The libraries bundled with the connector keep their own licences: see
`THIRD-PARTY-NOTICES.md`.

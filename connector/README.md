# Tresorit Files connector for Claude, version 1.5.0

Lets Claude work with the Tresorit folder that the Tresorit app keeps synced on this Mac: browse, find by name,
search inside documents, read, write, move, copy and (with permission) delete.

Nothing is sent anywhere by this connector. It reads and writes local files only, so Tresorit's end-to-end
encryption is not affected. It does not use the Tresorit API or your Tresorit password, and it makes no network
connections at all.

This is an unofficial project. It is not made, endorsed or supported by the company Tresorit, whose name is its
trademark.

## Install

Double-click the `.mcpb` file, or in the Claude desktop app go to Settings > Extensions > Advanced settings >
Install Extension and choose the file. All settings can be left empty.

## First use: the self-check

After installing, and again after each update, the connector is read-only: it can list, find, search and read,
but refuses to save, edit, move, copy, delete or restore. Ask Claude to "run the Tresorit self-check"
(the tool is `tresorit_preflight`). It runs a second copy of the connector, inside the connector itself, on a scratch folder inside the
connector's own data folder and runs more than 100 tests there: every document type, staying inside the folder,
capital letters and accents in file names, saving, overwriting, copying, moving, deleting and restoring,
searching and text recognition. It only lists the real Tresorit folder and changes nothing in it.
It takes under a minute. When every essential test passes, changes are unlocked on that computer.
The report is saved in the data folder under `logs/`.

## What it can read

- PDF, including scanned PDFs (through text recognition, see below), what was typed into fillable forms, and comments
- Word: .docx and the older .doc
- Excel: .xlsx and the older .xls, with dates and times shown as dates and times
- PowerPoint: .pptx and the older .ppt, slides in the order shown, with speaker notes
- Outlook messages: .msg, with sender, recipients, date, body and attachment names
- Plain text formats: txt, md, csv, json, html, rtf, eml and similar
- Images (png, jpg, gif, webp) are shown rather than read

Not readable: password-protected files, Word 6/95 and Excel 4 or older, the contents of attachments inside
a .msg file, the text inside signature stamps on digitally signed PDFs, and Chinese, Japanese or Korean text
in some PDFs.

## Scanned PDFs

Pages without a text layer are read by text recognition (OCR), in the background, one document at a time.
On a Mac the built-in recognition is used if it passes a self-test when first needed; otherwise a bundled
engine (English and Portuguese) does the work. Up to 150 scanned pages are read per file.
Recognised text can contain errors, especially in figures: check anything important against the original.

## Bringing files in, and taking copies out

- From elsewhere on the Mac into Tresorit: `tresorit_import_file` takes a file or folder from your home folder
  (Downloads, Desktop, Documents, iCloud Drive, other cloud drives) or an external drive. A bare file name means
  the file of that name in Downloads. It copies by default and leaves the original where it is. With "move",
  the original is taken away only after the copy has been checked, and is kept in the holding area, from where
  it can be put back in its old place. Every copy is compared with the original, file by file.
- Off limits as a source: hidden folders and files, the Library (except iCloud Drive and cloud drives),
  applications, photo and other application libraries, and password or key stores. Links are not followed.
- A folder, or a single file over 1 GB, is previewed first (number of files, size) and needs your agreement.
- A folder always goes inside the destination you name, keeping its own name. Applications, application
  libraries, key stores, hidden items, links and files with a name Tresorit does not sync (see "New in 1.5.0")
  found inside it are left out, and the reply names them.
- A folder that holds any such left-out item can be copied in but not moved in (see "New in 1.4.5").
- The copy is prepared and checked in the connector's own staging folder and put into Tresorit in one step, so
  Tresorit never receives (or syncs to other people) a half-copied or unchecked file, even if Claude is closed
  or the Mac is switched off in the middle.
- An identical file already at the destination is recognised and not copied again.
- The connector only sees names, sizes and dates of files outside Tresorit. It never shows their contents.
- Out of Tresorit: `tresorit_export_file` puts a copy in Downloads or Desktop, for example to attach to an
  email. It never overwrites and never removes the original.
- A document made in a chat: small ones (up to roughly 50 KB) can be saved straight into Tresorit, sent in
  parts that are each checked. Larger ones: download the file, then ask for it to be brought in from Downloads.
- macOS asks once whether Claude may use Desktop, Documents, Downloads and removable drives. If you declined,
  allow it in System Settings > Privacy & Security > Files and Folders.

## Settings

- Tresorit folder: found automatically (`~/Tresors`, or the Tresorit entry in `~/Library/CloudStorage`).
- Connector data folder: default `~/TresoritConnector`. Must be outside Tresorit.
- Blocked folders: optional. Folders the connector may never touch, separated by `;`,
  for example `Finance/Payroll; Company/Projects/Archive 2019`. The status report warns when a name entered
  here matches no folder.
- Folders not to index: folders whose documents are never copied into the search index and never searched.
  They can still be opened when you ask for a file in them by name. Separated by `;`, for example
  `Finance/Payroll; Private/Passwords`. Left empty, no folder is kept out. Enter them before you run the
  self-check for the first time: at its end the connector shows this list in a window and waits for your yes
  before it reads anything into the index (see "New in 1.5.0").
- Background reading: on by default. Reads documents once so that searching inside them is fast.
- Text recognition for scanned PDFs: on by default.
- Go easy on the battery: on by default. While the Mac runs on its battery, new documents are still read for
  search, newest first, but only in small amounts (up to 100 documents and 250 MB an hour, no file over 25 MB).
  Bulk reading (such as the very first pass over the library), very large files and all text recognition for
  scanned PDFs wait until the Mac is plugged in, and then carry on by themselves. Below 20% charge nothing is
  read in the background. Switch it off to let everything run on battery. Anything you ask for is never held up.
  The connector looks at the power source every 30 seconds, so it reacts to plugging in or unplugging within
  about half a minute.

## What lives in the connector data folder

- `logs/access-YYYY-MM.log`: one line for every file opened, searched, written, moved or deleted.
- `deleted/`: the holding area. Deleted items, previous versions of replaced files and the originals of files
  moved into Tresorit go here and can be restored. It is an ordinary folder on the Mac's own disk, outside
  Tresorit and not synced. Batches older than 30 days are removed for good automatically (see "New in 1.4.3");
  `tresorit_list_deleted` shows its size, and `tresorit_clear_deleted` removes batches sooner, after a preview
  and your approval.
- `transfer/`: files copied out of Tresorit for processing, or waiting to be brought in.
- `staging/`: where copies are prepared before being put in place. Normally empty; cleared at start.
- `change.lock`: present only while a change is being made; it makes the other copies of the connector wait.
- `index/background.lock` and `index/background.json`: which copy is doing the background reading, and how far it is.
- `index/`: extracted text of your documents, used for search. Delete this folder to reset the search index.

## Safety rules built in

- Every path is checked to be inside the Tresorit folder; links pointing outside are refused.
- A blocked folder is protected also when the folder above it is named: a copy of that folder is made without
  the blocked folder, and moving, renaming, deleting or replacing it is refused (see "New in 1.4.5").
- A blocked folder is protected under every spelling of its name that the Mac treats as the same name (see
  "New in 1.4.6").
- Tresors themselves (the top-level folders) cannot be deleted, moved, renamed or created.
- Nothing is overwritten unless asked, and the previous version is then kept in the holding area.
- A copy, move or save that fails part-way is undone: no half-finished result is left behind.
- Replacing or editing a file is all-or-nothing: the new version is prepared in the staging folder, written
  through to the disk itself, and swapped in with one step. If Claude is closed or the Mac loses power at that
  instant, the file is either the old version or the new one, complete; it is never missing and never cut
  short. (The writing through to the disk was added in 1.4.8; see there for what it covers.)
- Changes are made strictly one at a time, even when several are requested at once, so two changes aimed at
  the same place can never overwrite each other unnoticed. Reading and searching are not held up by this.
- The Claude app runs several copies of the connector at once (one per window or session). The copies wait
  for each other as well, through a small lock file in the data folder, so two windows changing the same
  place at the same instant cannot overwrite each other either. A lock left by a copy that has stopped is
  recognised and cleared.
- Of those copies, only one does the background reading of documents and the text recognition. The others
  use the search index it builds, so the library is read once and not once per copy. If that copy stops,
  another takes over within a couple of minutes. Every copy reports the same progress.
- No changes at all until the self-check has passed on this computer for this version.
- The data folder is readable by your user account only.
- Outside Tresorit the connector can only bring files in, list names, and place copies in Downloads or Desktop.
  It never overwrites or changes anything there; a moved original is kept, not destroyed.
- A refusal for a protected place (hidden folders, the Library, key stores) reads the same whether or not
  the item exists there, so nothing can be learned about what those places contain.
- The connector makes no network connections of any kind.
- Deleting takes two steps (preview, then confirmation with a one-time code) and never erases anything:
  items move to the holding area. Before anything is deleted you are also asked outside the conversation: in
  a confirmation box of the Claude app where it shows one, otherwise in a window that the connector opens on
  this Mac (see "New in 1.4.7"). Only an explicit yes counts: a box or window that is closed, left unanswered
  or cannot be shown means nothing is deleted.
- If Claude is closed while changes are under way or waiting their turn, they are completed before the
  connector stops.
- A change that the app withdraws while it is still waiting its turn (for example because it gave up waiting)
  is not carried out later behind your back; the access log records it as withdrawn.
- File names containing line breaks or other control characters are shown in escaped form.

## New in 1.4

- Files are read by their content, not by the ending of their name. A picture saved as .pdf goes through text
  recognition; a PDF saved as .docx, a web page or Safari web archive saved as .pdf, and Office files under the
  wrong ending are read as what they are. The file's note says so ("PNG image saved as .pdf"). Nothing is renamed.
- Unreadable files are counted by reason in the status report (password-protected, damaged, empty, content of a
  kind that cannot be read, too large), and `tresorit_list_unreadable` lists them with path, size, date and reason.
  It also lists the files whose ending does not match their content.
- Password-protected PDFs can be opened. The password is typed into a box on the Mac, never into the chat. It is
  used for that one call and is written nowhere: not in the access log, not in the index, not in any file.
  - `tresorit_read_file` with `ask_password`: one read; the text is not kept.
  - `tresorit_unlock_folder`: opens every protected PDF in a folder that the password fits and puts their text in
    the search index, so they can be searched like any other document. The files in Tresorit are not changed and
    no unlocked copies are made. What is kept is the extracted text, in the search index on that Mac, next to the
    text of every other document. A file that changes, or a rebuilt index, needs unlocking again; each Mac has its
    own index. It also points out an unprotected PDF lying beside a protected one with the same text.
  - Folders set as "do not index" cannot be unlocked into the index.
- `tresorit_clear_transfer` lists what is in the transfer folder and, after a preview and your yes, removes it.
  This removal is for good (these are copies; the originals are in Tresorit). The status report shows what is in
  the transfer folder and flags copies older than 24 hours.
- `tresorit_export_to_transfer` and `tresorit_import_from_transfer` take several items in one call. Several items
  copied out together go into one dated folder, each under its own Tresorit path, so same-named files stay apart.
- `tresorit_find_identical` finds files with the same content, in a folder or across Tresorit, and can answer
  whether one given file (in Tresorit or elsewhere on the Mac) is already there. It only reports. Fingerprints are
  remembered so that a second run is quick; "do not index" folders are left out unless named.
- The status report also shows the size of the holding area and the age of its oldest batch, the power source,
  and which copy does the background reading.
- A file saved or brought in through the connector is put into the search index straight away.
- After the update, only the files that the previous version could not read are read again, not the library.

## New in 1.4.3

(1.4.1 and 1.4.2 were built but replaced before anyone installed them.)

- The holding area clears itself. Batches older than 30 days are removed for good, without anyone asking. The
  number of days is a setting ("Clear the holding area after (days)"); 0 switches this off, and then nothing
  leaves the holding area without your yes, as before.
  - It happens while the connector is running: shortly after Claude starts and then a few times a day. The
    connector only runs while the Claude app is open, so a batch that turns 30 days old while Claude is closed
    is removed the next time it is opened.
  - Only whole batches go, and only by their age. Anything newer stays restorable.
  - If in doubt, a batch is kept. A batch whose record is damaged or has no proper date is judged by the date of
    its folder. A batch dated before 2025 can only have been made while the Mac's clock was wrong: its real age
    is unknown, so it is never cleared automatically (the status report says how many there are, and they can be
    cleared by hand).
  - The number of days is never less than 1 (a value between 0 and 1 counts as 1), and nothing outside the
    setting can shorten it.
  - One thing it cannot know: if the Mac's clock is set wrongly to a date far in the future while Claude is
    running, batches look old and are cleared. Only the undo copies in the holding area are affected, never
    anything in Tresorit.
  - Dates are the Mac's local time. After a change of time zone a batch may go a few hours early or late.
  - Other requests do not wait for a clearing: inside its turn a batch is only moved out of sight and logged,
    and its files are deleted afterwards.
  - Every automatic removal is a line in the access log (PURGE, "removed from the holding area automatically"),
    and the status report shows the last one.
  - It does not happen before the self-check has passed on that Mac. Each Mac clears its own holding area.
  - Clearing sooner by hand is unchanged: `tresorit_clear_deleted`, a preview, then your yes.
- The list of unreadable files says what the "and N more" are.

## New in 1.4.4

Found by a hard test of 1.4.3 (a long random run with three copies of the connector and sudden stops, and a test
on the Mac). Nothing in it concerns the safety of files: no file was lost, changed or exposed.

- A file that is missing or busy at the very moment the connector opens it is no longer recorded as damaged.
  Before, a file that was deleted and restored, or moved away and back, could stay marked as unreadable and
  drop out of content searches although the file itself was fine. Such records left by earlier versions are
  read again by this one, without anyone asking.
- A picture saved under a document's ending (for example a photo saved as .pdf) is now opened by the Mac's own
  text recognition from its content. Before, the Mac's recognition refused such a file because of its ending and
  the bundled engine read it instead, which is less accurate.
- When the Mac's own recognition does pass a file to the bundled engine, the access log gives the reason.
- `tresorit_list_deleted` shows the first ten items of a large batch and says how many more there are; one
  batch can be listed in full by its name.

## New in 1.4.5

Two faults found by a review of 1.4.4. Both are closed, and the self-check now tests for them (98 checks, up from 86).

- Blocked folders could be reached through the folder above them. Naming a blocked folder was refused, but
  copying, moving or exporting its parent folder took the blocked folder along, and the copy could then be read.
  Now:
  - a copy of such a folder (inside Tresorit, to the transfer folder, to Downloads or Desktop) is made without
    the blocked folder, and the reply says which folder was left out;
  - moving, renaming or deleting such a folder is refused, and so is replacing it with something else: each
    would carry the blocked folder to a place where it is no longer protected. Move or delete the other items
    in it one by one, or do it in Finder and correct the setting;
  - nothing can be put at a place where it would fill a blocked folder;
  - a blocked folder inside a folder is no longer counted into that folder's size.
- Moving a folder into Tresorit could lose files. Hidden items, links, applications and key stores are never
  brought in. With "move" the whole original folder went to the holding area, so those items were left only
  there and would have been removed for good when the holding area cleared itself. Now such a folder is not
  moved: the reply lists the items in question, and the folder can be copied in instead (the original then stays
  where it is, complete), or the items can be taken out first. System clutter such as .DS_Store does not count:
  a folder with only that besides its documents moves as before. Single files are not affected.
- Previews and replies of a folder import now name the items left out (the first ten), not only their number.
- A "do not index" folder is a setting about a place. When a copy or a move takes material out of such a
  folder (it is copied or moved itself, or the folder above it is), the reply now says that at its new place it
  will be read into the search index, and how to keep it out. Nothing is refused here.

## New in 1.4.6

One gap found when 1.4.5 was tested on the Mac. It is closed, and the self-check tests for it (three more checks).

- A Mac's disk treats a few rare spellings as the same name: "ß" and "ss", the old long "ſ" and "s", the joined
  "ﬁ" and "fi", the two small Greek sigmas, the micro sign "µ" and the Greek "μ", and some others. The connector
  compared names with capitals and accents ignored, but treated these spellings as different. So:
  - a blocked folder written "Strasse" in the settings while the folder on the disk is "Straße" was not
    protected, and nothing said so;
  - in the place of a blocked folder that does not exist yet, a folder could be created under such a spelling
    and was then not treated as blocked.
  Now the folders named in the settings (blocked, and "do not index") are compared the way the Mac's disk
  compares names, with accents ignored as before. The new comparison was checked against this Mac's disk for
  every letter and sign the disk knows a second spelling for.
- A blocked folder with an ordinary name was protected already, also when its name was typed with one of these
  characters. Nothing changes for names in plain letters.
- A side effect on the safe side: a folder whose name differs from a blocked folder's only by accents or by one
  of these spellings is refused too, even where the disk would keep the two apart.

## New in 1.4.7

A second check before deleting, found missing when 1.4.6 was tried in the Claude app. The self-check tests for it
(four more checks).

- The connector asked the Claude app to show a confirmation box before deleting. The Code tab of the app shows
  no such box, so there the only check was Claude asking in the conversation: a deletion rested on Claude
  behaving correctly. (Items went to the holding area and could be restored, as always.)
- Now, where the app shows no box of its own, the connector opens its own window on this Mac, titled
  "Tresorit Files". It lists the items and has two buttons, "Keep" and "Delete". Nothing is deleted unless you
  click "Delete". "Keep" is the button that Return presses. A window that is closed, not answered within two
  minutes, or that cannot be shown, deletes nothing.
- The same window guards the two actions that remove things for good: emptying the holding area ("Remove for
  good") and emptying the transfer folder ("Remove copies").
- The access log now says how each deletion was approved, and records a "Keep" or an unanswered window. The
  status report says how you are asked on this computer.
- If the window appears when you have not just agreed to a deletion in the conversation, choose "Keep".

## New in 1.4.8

Two faults left open by the review of 1.4.4. Both are closed, and the self-check tests for them (four more checks).

- The power-cut promise was not kept by the code. The safety rules said that a replaced or edited file is the
  complete old or the complete new version even if the Mac loses power. The swap itself was one step, but the
  new contents were not written through to the disk before it, so after a sudden power cut the Mac could have
  recorded the swap while part of the new contents was still only in its memory. That held when Claude was
  closed or the connector stopped, not for a power cut. Now a file that is saved, replaced or edited is written
  through to the disk before it is put in place (on a Mac this is the full write, which also empties the
  drive's own buffer), and the folder entry is written through after it. This costs a few thousandths of a
  second per file.
- The records of the holding area are written the same way.
- Restoring part of a batch from the holding area rewrote the batch's record in place. An interruption at that
  moment could have damaged the record and hidden the rest of the batch. The record is now replaced whole, as
  everywhere else.
- What this does not cover: the files inside a folder that is copied, or brought in from the Mac, are not each
  written through to the disk (see "Limits"). And a real power cut cannot be rehearsed by the self-check: it
  checks that each write is requested at the right moment, not that the Mac honours it.

## New in 1.5.0

Inside, the program is now made of smaller parts in place of one long file: the shared parts in `server/core`,
the tools in `server/tools`. `server/index.js` only starts them, in a fixed order.

Repairs:

- The search index could lose a few entries when two Claude windows saved it at the same instant after a copy
  of the connector had been stopped in mid-save. Only one window now clears the lock such a copy leaves behind,
  and it looks again before doing so. (What was lost was read again later; no document was ever affected.)
- A file that could not be read for a passing reason (missing or busy at that moment) is tried again; a file
  that is truly damaged is not mistaken for one any more because of the words in its error message.
- When a file is gone at the instant one window opens it, that window no longer throws away the text another
  window had read of it.
- One window never runs two background reading passes at once.

A new question on the Mac:

- Before a whole folder is copied out of Tresorit (to Downloads, to the Desktop or to the transfer folder), a
  window of the connector asks: 'Copy the folder "..." out of Tresorit?', with the number of files, the size
  and where it would go. "Do not copy" is the default button. If the window is closed or not answered within two
  minutes, nothing is copied. A single file is copied out as before. Like deleting, this works only when you
  are at the Mac.
- Where the Claude app asks in a box of its own, that box now also waits two minutes for your answer (it was
  five).

Searching:

- A word that a document splits at the end of a line ("agree-" at the end of one line and "ment" at the start
  of the next, as in many PDFs) is now found as the whole word, also inside a phrase, and excerpts show it
  joined. Reading a file still gives its text exactly as the document has it. After the update the connector
  renews its search index for this from the text it has already stored: no document is read again, so nothing
  that was unlocked with a password or recognised from a scan is lost. This takes a few minutes in the
  background; searches work meanwhile.

A safeguard for the folders that must not be indexed:

- The connector remembers, on each Mac, the list of folders "not to index" that you last confirmed there.
- On a first start nothing is read into the search index until you have confirmed that list. The question comes
  in a window at the end of the self-check, once it has passed; the window names the folders. "Stop" is the
  default button. Until your yes, searching finds only what is already in the index, and a file can still be
  read when asked for by name.
- If a folder later drops off that list, for whatever reason, it stays out of the index until you confirm in
  the same way that it may be read. A folder you add to the list needs no confirmation.
- A name on the list that matches no folder in Tresorit protects nothing, for example after a typing slip. The
  window marks such a name "NOT FOUND in Tresorit", and the status report warns about it.
- While the connector waits for your yes on a first start, a rebuild of the search index is refused, so the index
  you have is not thrown away.
- If an older version of the connector is left installed beside this one, it goes on reading documents by its own
  rules. The status report warns when that is the case. Remove the older extension and start Claude again.
- The status report says in a line beginning with HOLD when such a hold is in force, and for which folders.
- The program itself no longer names any folder. Up to 1.4.8 two folder names were built in as the default of
  "Folders not to index". Now that list is exactly what you enter in the settings, and empty until you do.

Two new refusals:

- A system file (`Thumbs.db`, `desktop.ini`, `.DS_Store` and the like) is clutter whatever the capitals of its
  name. Typed as `THUMBS.DB` it is not brought in, and a file the disk holds as `thumbs.db` is left out of lists
  and searches.
- Nothing new inside Tresorit can be given a name that Tresorit itself does not sync, or that the connector
  would hide from its lists. Tresorit leaves these names out of the cloud: `desktop.ini`, `Thumbs.db`,
  `.DS_Store`, names beginning with `~$`, `.~` or `._`, names ending in `.tmp`, `.onetmp`, `.kate-swp`, `.lnk`
  or `.crdownload`, names containing `.part_`, and `.tresorit`, `.VolumeIcon.icns`, `System Volume Information`
  and `$RECYCLE.BIN` (its help page "Files excluded from sync"). Before, such a file was saved with the reply
  "Saved" and then stayed on that Mac only. The connector hides names beginning with a dot. Saving, receiving,
  creating a folder, moving, renaming, copying and bringing in are refused under such a name, with the reason.
  What already has such a name can still be replaced, moved to a proper name and deleted.
- When a whole folder is brought in from the Mac, files inside it with such a name are left out and named in
  the reply, as hidden items already were. A folder holding one can therefore be copied in, not moved in.

## Limits

- A folder that is copied, or brought in from elsewhere on the Mac, appears in one step, but the files in it
  are not each written through to the disk first (for a large folder that would take long). After a power cut
  during or just after such a copy, look the copy over; the original is untouched, or, after a move in, kept in
  the holding area.
- The all-or-nothing guarantees above need the connector data folder to be on the same disk as the Tresorit
  folder (the normal arrangement; the self-check says which you have). On different disks the connector still
  works and still keeps replaced items, but a copy interrupted by a power cut can leave a partial item behind.
- Very long documents are kept and searched up to their first 10 million characters (plain-text files: the
  first 16 MB). Reading or searching such a document says so.
- A search inside documents always answers within about 40 seconds. On a very large library it searches the
  newest documents first and says how many older ones it did not reach; narrowing the search to a folder or a
  file type covers the rest.
- A document that could not be read because the Mac was busy, short of memory or asleep at that moment is tried
  again at a later start (up to three attempts) instead of staying marked as unreadable.
- The connector's own memory use is shown by `tresorit_connector_status`. It rises while documents are being
  read in the background and falls back when that work is done.

- Works only while this Mac is on and the Claude desktop app is open.
- Online-only files (when Tresorit runs as a macOS cloud-storage location) are skipped by search unless asked;
  reading one downloads it.

## Support

Extensively tested. Provided as it is, without warranty. For questions or problems, open an issue in this
project; they are answered as time allows.

## Licence

MIT: see the file `LICENSE`. The libraries bundled with the connector keep their own licences: see
`THIRD-PARTY-NOTICES.md`.

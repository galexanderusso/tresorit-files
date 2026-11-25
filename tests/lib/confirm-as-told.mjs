// Stand-in for the connector's own confirmation window that answers as a test tells it, and notes what it was shown.
// The connector calls it with: the message, the label of the button that keeps things as they are, the label of the
// action button. It reads the file named by CONFIRM_ANSWER_FILE:
//   yes   presses the action button;   no   presses the other button;   anything else: the window is not answered.
// With CONFIRM_RECORD_FILE set, each call adds one line of JSON there: { message, keep, action, answer }.
import fs from 'node:fs';
const [message, keep, action] = process.argv.slice(2);
let answer = '';
try { answer = fs.readFileSync(process.env.CONFIRM_ANSWER_FILE, 'utf8').trim(); } catch { answer = ''; }
if (process.env.CONFIRM_RECORD_FILE) { try { fs.appendFileSync(process.env.CONFIRM_RECORD_FILE, JSON.stringify({ message, keep, action, answer }) + '\n'); } catch { /* not recorded */ } }
if (answer === 'yes') process.stdout.write(`${action}\n`);
else if (answer === 'no') process.stdout.write(`${keep}\n`);
else process.exit(1);

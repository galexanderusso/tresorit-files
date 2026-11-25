// Stand-in for the connector's confirmation window (TRESORIT_CONFIRM_CMD): "presses" the action button.
// The connector calls it with the message, the label of the keep button and the label of the action button.
process.stdout.write(`${process.argv[4]}\n`);

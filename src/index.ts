// `node dist/index.js fire <routine> ...` is a routine's CronJob: it only calls the bot's internal API and never
// reads the bot's configuration, so nothing of the bot is loaded for it. Without arguments: the bot.
if (process.argv[2] === "fire") {
  const { fireMain } = await import("./routines/fire.js");
  process.exit(await fireMain(process.argv.slice(3), process.env));
} else {
  await import("./server.js");
}

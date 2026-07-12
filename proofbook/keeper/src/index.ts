import * as path from "path";
import { loadConfig, ROOT } from "./config";
import { Logger } from "./logger";
import { Keeper } from "./core/keeper";
import { capture } from "./capture";

/**
 * ProofBook keeper CLI.
 *   keeper live                          — autonomous live pipeline (devnet + TxLINE)
 *   keeper replay [file] [--speed N]     — replay a recorded fixture (local, mock oracle)
 *   keeper capture <fixtureId> <epochDay> — record a real fixture + proof to a replay file
 */
async function main() {
  const log = new Logger("cli");
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === "live") {
    const keeper = new Keeper(loadConfig("live"));
    await keeper.start();
    hookShutdown(keeper, log);
    return;
  }

  if (cmd === "replay") {
    const file =
      rest.find((a) => !a.startsWith("--") && a.endsWith(".json")) ||
      process.env.REPLAY_FILE ||
      path.join(ROOT, "keeper", "fixtures", "18193785.json");
    const overrides: any = { replayFile: file };
    if (flag("speed")) overrides.replaySpeed = Number(flag("speed"));
    if (flag("oracle")) overrides.oracleMode = flag("oracle");
    const keeper = new Keeper(loadConfig("replay", overrides));
    await keeper.start();
    hookShutdown(keeper, log);
    return;
  }

  if (cmd === "capture") {
    const fixtureId = Number(rest[0]);
    const epochDay = Number(rest[1]);
    if (!fixtureId || !epochDay) {
      console.error("usage: keeper capture <fixtureId> <epochDay> [--out file.json]");
      process.exit(1);
    }
    await capture(loadConfig("live"), fixtureId, epochDay, flag("out"));
    process.exit(0);
  }

  console.error("usage: keeper <live | replay [file] | capture <fixtureId> <epochDay>>");
  process.exit(1);
}

function hookShutdown(keeper: Keeper, log: Logger) {
  const bye = async () => {
    log.info("shutting down");
    await keeper.stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((e) => {
  console.error(e?.response?.data || e);
  process.exit(1);
});

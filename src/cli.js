import path from "node:path";

import { loadConfig } from "./config.js";
import { readJsonFile } from "./fs-util.js";
import { runService } from "./node-host.js";

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index];
    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2);
    const value = rest[index + 1] && !rest[index + 1].startsWith("--") ? rest[++index] : true;
    options[key] = value;
  }

  return { command, options };
}

function printHelp() {
  console.log(`secure-node

Usage:
  secure-node run [--config path]
  secure-node print-config [--config path]
  secure-node help
`);
}

export async function runCli(argv) {
  const { command, options } = parseArgs(argv);
  const configPath = options.config ? path.resolve(options.config) : null;

  switch (command) {
    case "run":
      await runService(configPath);
      return;
    case "print-config": {
      const config = await loadConfig(configPath, { readJsonFile });
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    case "help":
    default:
      printHelp();
  }
}

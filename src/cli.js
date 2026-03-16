import path from "node:path";
import fs from "node:fs/promises";

import { loadConfig } from "./config.js";
import { readJsonFile } from "./fs-util.js";
import { runService } from "./node-host.js";

const EXAMPLE_CONFIG_PATH = new URL("../examples/clawguard.config.json", import.meta.url);

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
  console.log(`clawguard

Usage:
  clawguard run [--config path]
  clawguard init-config [--config path] [--force]
  clawguard print-config [--config path]
  clawguard help
`);
}

async function initConfig(configPath, force = false) {
  const destinationPath = configPath || path.join(process.cwd(), "clawguard.config.json");

  try {
    await fs.access(destinationPath);
    if (!force) {
      const error = new Error(`config already exists at ${destinationPath}; rerun with --force to overwrite`);
      error.code = "CONFIG_EXISTS";
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(EXAMPLE_CONFIG_PATH, destinationPath);
  console.log(destinationPath);
}

export async function runCli(argv) {
  const { command, options } = parseArgs(argv);
  const configPath = options.config ? path.resolve(options.config) : null;

  switch (command) {
    case "run":
      await runService(configPath);
      return;
    case "init-config":
      await initConfig(configPath, Boolean(options.force));
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

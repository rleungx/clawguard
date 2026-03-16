#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  const code = error?.code ? ` (${error.code})` : "";
  console.error(`clawguard failed${code}: ${error?.message ?? error}`);
  if (error?.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});

import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, writeTextFileAtomic } from "./fs-util.js";

export class AuditLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async write(entry) {
    const serialized = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    const operation = this.queue.catch(() => {}).then(async () => {
      await ensureDir(path.dirname(this.filePath));
      try {
        await fs.appendFile(this.filePath, serialized, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          await writeTextFileAtomic(this.filePath, serialized);
          return;
        }
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

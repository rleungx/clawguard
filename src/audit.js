import path from "node:path";

import { ensureDir, writeTextFileAtomic } from "./fs-util.js";

export class AuditLogger {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async write(entry) {
    const serialized = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    this.queue = this.queue.then(async () => {
      await ensureDir(path.dirname(this.filePath));
      try {
        const fs = await import("node:fs/promises");
        await fs.appendFile(this.filePath, serialized, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          await writeTextFileAtomic(this.filePath, serialized);
          return;
        }
        throw error;
      }
    });
    return this.queue;
  }
}

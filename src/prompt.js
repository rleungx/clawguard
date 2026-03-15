import readline from "node:readline/promises";

export class LocalApprover {
  constructor({ askMode, askFallback, askTimeoutMs }) {
    this.askMode = askMode;
    this.askFallback = askFallback;
    this.askTimeoutMs = askTimeoutMs;
    this.queue = Promise.resolve();
  }

  async requestApproval(details) {
    if (this.askMode !== "tty" || !process.stdin.isTTY || !process.stdout.isTTY) {
      return this.askFallback;
    }

    const task = async () => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const timer = setTimeout(() => {
        rl.close();
      }, this.askTimeoutMs);

      try {
        process.stdout.write("\n[secure-node] approval required\n");
        process.stdout.write(`agent: ${details.agentId || "*"}\n`);
        process.stdout.write(`cwd: ${details.cwd}\n`);
        process.stdout.write(`command: ${details.displayCommand}\n`);
        process.stdout.write("allow once [o], allow and remember [a], deny [d]: ");
        const answer = await rl.question("");
        const normalized = answer.trim().toLowerCase();

        if (normalized === "a" || normalized === "allow" || normalized === "always") {
          return "allow-always";
        }

        if (normalized === "o" || normalized === "once" || normalized === "allow-once") {
          return "allow-once";
        }

        return "deny";
      } catch {
        return this.askFallback;
      } finally {
        clearTimeout(timer);
        rl.close();
      }
    };

    this.queue = this.queue.then(task, task);
    return this.queue;
  }
}

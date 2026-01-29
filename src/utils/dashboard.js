import chalk from "chalk";
import TelegramBot from "./telegram.js";

export default class Dashboard {
  static slots = {};
  static logs = [];
  static maxLogs = 10;
  static totalProfiles = 0;
  static completed = 0;
  static errors = 0;

  static init(concurrency) {
    for (let i = 0; i < concurrency; i++) {
      this.slots[i] = {
        profile: "Waiting...",
        status: "Idle",
        color: "gray",
      };
    }
    this.render();
  }

  static updateSlot(slotId, profileName, status, color = "white") {
    if (this.slots[slotId]) {
      this.slots[slotId] = { profile: profileName, status, color };
      this.render();
    }
  }

  static addLog(message) {
    this.logs.push(message);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.render();
  }

  static updateStats(total, completed, errors) {
    this.totalProfiles = total;
    this.completed = completed;
    this.errors = errors;
    this.render();
  }

  static render() {
    process.stdout.write("\x1Bc");

    const header = chalk.bgBlue.white.bold(
      "                 MONERO BOT DASHBOARD                 ",
    );
    console.log(header);
    console.log(
      chalk.gray(
        `Total Profiles: ${this.totalProfiles} | Completed: ${this.completed} | Errors: ${this.errors}`,
      ),
    );
    console.log(
      chalk.cyan("======================================================"),
    );

    Object.keys(this.slots).forEach((slotId) => {
      const s = this.slots[slotId];
      const slotStr = `[SLOT ${slotId}]`.padEnd(10);
      const profileStr = (s.profile || "Idle").padEnd(20);

      let statusColor = chalk[s.color] || chalk.white;
      console.log(
        `${chalk.yellow(slotStr)} ${chalk.bold(profileStr)} : ${statusColor(s.status)}`,
      );
    });

    console.log(
      chalk.cyan("======================================================"),
    );
    console.log(chalk.white.bold("[LATEST LOGS]"));

    this.logs.forEach((log) => {
      console.log(chalk.gray(`> ${log}`));
    });
    console.log(
      chalk.cyan("======================================================"),
    );

    TelegramBot.updateDashboard(this.slots, {
      total: this.totalProfiles,
      done: this.completed,
      errors: this.errors,
    });
  }
}

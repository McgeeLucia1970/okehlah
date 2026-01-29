import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const STATS_FILE = path.join(PROJECT_ROOT, "profile_stats.json");

export default class ProfileStats {
  static loadStats() {
    if (!fs.existsSync(STATS_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
    } catch (e) {
      return {};
    }
  }

  static saveStats(stats) {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  }

  static getLastRun(profileName) {
    const stats = this.loadStats();
    return stats[profileName] || 0;
  }

  static updateLastRun(profileName) {
    const stats = this.loadStats();
    stats[profileName] = Date.now();
    this.saveStats(stats);
  }
}

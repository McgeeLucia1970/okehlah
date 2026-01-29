import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");

export default class ProfileManager {
  static getProfilesDir() {
    const profilesDir = path.join(PROJECT_ROOT, "profiles");
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }
    return profilesDir;
  }

  static getProfilePath(index, prefix = "profile") {
    return path.join(this.getProfilesDir(), `${prefix}_${index}`);
  }

  static getAccounts() {
    const accountPath = path.join(PROJECT_ROOT, "account.txt");
    if (!fs.existsSync(accountPath)) return [];

    const content = fs.readFileSync(accountPath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  static getAccountBatches(batchSize = 10, enableRefill = false) {
    let accounts = this.getAccounts();
    const refillBatches = [];

    try {
      const metadataPath = path.join(PROJECT_ROOT, "profile_metadata.json");
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        const usedEmails = new Set();

        Object.entries(metadata).forEach(([profileName, data]) => {
          if (data.emails && Array.isArray(data.emails)) {
            data.emails.forEach((email) => usedEmails.add(email));
          }
        });

        console.log(
          `[Deduplication] Found ${usedEmails.size} already used emails.`,
        );

        const accountsToRemove = accounts.filter((acc) => usedEmails.has(acc));

        if (accountsToRemove.length > 0) {
          console.log(
            `[Deduplication] Removing ${accountsToRemove.length} duplicate accounts from account.txt...`,
          );
          this.removeAccounts(accountsToRemove);
          accounts = this.getAccounts();
        }

        if (enableRefill) {
          const incompleteProfiles = [];
          Object.entries(metadata).forEach(([profileName, data]) => {
            if (data.sessionCount !== undefined && data.sessionCount < 10) {
              incompleteProfiles.push({
                name: profileName,
                needed: 10 - data.sessionCount,
              });
            }
          });

          if (incompleteProfiles.length > 0) {
            console.log(
              `[Auto-Refill] Found ${incompleteProfiles.length} incomplete profiles.`,
            );

            incompleteProfiles.sort((a, b) => b.needed - a.needed);

            for (const profile of incompleteProfiles) {
              if (accounts.length === 0) break;

              const takeCount = Math.min(profile.needed, accounts.length);
              const refillAccounts = accounts.slice(0, takeCount);
              accounts = accounts.slice(takeCount);

              refillBatches.push({
                accounts: refillAccounts,
                targetProfile: profile.name,
                isRefill: true,
              });

              console.log(
                `[Auto-Refill] Scheduled ${takeCount} accounts for ${profile.name}`,
              );
            }
          }
        }
      }
    } catch (e) {
      console.error("[Manager] Failed to process metadata:", e.message);
    }

    const batches = [];
    for (let i = 0; i < accounts.length; i += batchSize) {
      batches.push(accounts.slice(i, i + batchSize));
    }

    return [...refillBatches, ...batches];
  }

  static removeAccounts(accountsToRemove) {
    const accountPath = path.join(PROJECT_ROOT, "account.txt");
    if (!fs.existsSync(accountPath)) return;

    try {
      const content = fs.readFileSync(accountPath, "utf-8");
      const currentAccounts = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const remainingAccounts = currentAccounts.filter(
        (acc) => !accountsToRemove.includes(acc),
      );

      fs.writeFileSync(accountPath, remainingAccounts.join("\n"));
    } catch (e) {
      console.error("Failed to update account.txt:", e.message);
    }
  }
  static unlockAllProfiles() {
    const profilesDir = this.getProfilesDir();
    if (fs.existsSync(profilesDir)) {
      const folders = fs
        .readdirSync(profilesDir)
        .filter((f) => fs.lstatSync(path.join(profilesDir, f)).isDirectory());
      let count = 0;
      folders.forEach((folder) => {
        const lockFile = path.join(profilesDir, folder, "process.lock");
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
          count++;
        }
      });
      return count;
    }
    return 0;
  }
}

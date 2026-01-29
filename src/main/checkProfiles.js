import chalk from "chalk";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { logMessage, prompt } from "../utils/logger.js";
import ProfileManager from "../utils/profileManager.js";
import ProfileMetadata from "../utils/profileMetadata.js";

export default class CheckProfiles {
  static async execute() {
    logMessage(null, null, "Starting Profile Checker...", "info");
    const profilesDir = ProfileManager.getProfilesDir();
    const profileFolders = fs
      .readdirSync(profilesDir)
      .filter((file) => {
        return fs.lstatSync(path.join(profilesDir, file)).isDirectory();
      })
      .map((file) => path.join(profilesDir, file));

    if (profileFolders.length === 0) {
      logMessage(null, null, "No profiles found!", "error");
      return;
    }

    logMessage(
      null,
      null,
      `Found ${profileFolders.length} profiles to check.`,
      "info",
    );

    const concurrencyInput = await prompt(
      chalk.yellow("Enter Concurrency Limit (default 5): "),
    );
    const concurrency = parseInt(concurrencyInput) || 5;

    const headlessInput = await prompt(
      chalk.yellow("Run Headless? (Y/n, default Yes): "),
    );
    const isHeadless = headlessInput.toLowerCase() !== "n";

    const profileQueue = [...profileFolders];
    const activeExecutions = new Set();
    const availableSlots = Array(concurrency)
      .fill(false)
      .map((_, i) => i);

    let completed = 0;
    const total = profileQueue.length;

    const runNext = () => {
      if (profileQueue.length === 0 && activeExecutions.size === 0) {
        logMessage(null, null, "All profiles checked!", "success");

        const metadata = ProfileMetadata.loadMetadata();
        const totalProfiles = Object.keys(metadata).length;
        const totalEmails = new Set();
        let totalSessions = 0;

        Object.values(metadata).forEach((p) => {
          if (p.sessionCount) totalSessions += p.sessionCount;
          if (p.emails && Array.isArray(p.emails)) {
            p.emails.forEach((e) => totalEmails.add(e));
          }
        });

        console.log(
          chalk.cyan("\n============================================"),
        );
        console.log(chalk.cyan(`   SUMMARY REPORT`));
        console.log(chalk.cyan("============================================"));
        console.log(
          chalk.white(`   Total Profiles : `) + chalk.green(`${totalProfiles}`),
        );
        console.log(
          chalk.white(`   Total Sessions : `) + chalk.green(`${totalSessions}`),
        );
        console.log(
          chalk.white(`   Unique Emails  : `) +
            chalk.green(`${totalEmails.size}`),
        );
        console.log(
          chalk.cyan("============================================\n"),
        );

        logMessage(
          null,
          null,
          "Results saved to profile_metadata.json",
          "success",
        );
        return;
      }

      while (availableSlots.length > 0 && profileQueue.length > 0) {
        const slotId = availableSlots.shift();
        const profilePath = profileQueue.shift();
        const profileName = path.basename(profilePath);

        activeExecutions.add(profileName);

        const colCount = 4;
        const width = 450;
        const height = 600;
        const x = (slotId % colCount) * width;
        const y = Math.floor(slotId / colCount) * height;

        logMessage(
          null,
          null,
          `[Checker] Checking ${profileName}...`,
          "process",
        );

        this.processProfile(profilePath, { x, y, width, height }, isHeadless)
          .then((data) => {
            if (data.sessionCount > 0 && !data.signedOut) {
              ProfileMetadata.updateProfile(profileName, data);
              logMessage(
                null,
                null,
                `[Checker] ${profileName}: ${data.sessionCount} sessions (${data.emails.join(", ")})`,
                "success",
              );
            } else {
              ProfileMetadata.deleteProfile(profileName);

              if (data.signedOut) {
                logMessage(
                  null,
                  null,
                  `[Checker] ${profileName} is SIGNED OUT. Deleting...`,
                  "error",
                );
              } else {
                logMessage(
                  null,
                  null,
                  `[Checker] ${profileName} has 0 sessions. Deleting...`,
                  "warning",
                );
              }
              try {
                fs.rmSync(profilePath, { recursive: true, force: true });
                logMessage(
                  null,
                  null,
                  `[Checker] ${profileName} DELETED (and removed from metadata).`,
                  "success",
                );
              } catch (e) {
                logMessage(
                  null,
                  null,
                  `[Checker] Failed to delete ${profileName}: ${e.message}`,
                  "error",
                );
              }
            }
          })
          .catch((err) => {
            logMessage(
              null,
              null,
              `[Checker] ${profileName} Error: ${err.message}`,
              "error",
            );
          })
          .finally(() => {
            activeExecutions.delete(profileName);
            availableSlots.push(slotId);
            availableSlots.sort((a, b) => a - b);
            completed++;
            runNext();
          });
      }
    };

    runNext();

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (profileQueue.length === 0 && activeExecutions.size === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });
  }

  static async processProfile(profilePath, windowPos, isHeadless) {
    const defaultArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ];

    if (windowPos) {
      defaultArgs.push(`--window-position=${windowPos.x},${windowPos.y}`);
      defaultArgs.push(`--window-size=${windowPos.width},${windowPos.height}`);
    }

    const browser = await puppeteer.launch({
      headless: isHeadless,
      defaultViewport: null,
      userDataDir: profilePath,
      args: defaultArgs,
    });

    try {
      const page = await browser.newPage();

      await page.goto("https://accounts.google.com/AccountChooser", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      const emails = await page.evaluate(() => {
        const emailList = [];

        const listItems = document.querySelectorAll('li, div[role="link"]');

        listItems.forEach((item) => {
          const text = item.innerText || "";
          const lines = text.split("\n");
          for (let line of lines) {
            if (line.includes("@") && !line.includes(" ")) {
              emailList.push(line.trim());
              break;
            }
          }

          if (item.hasAttribute("data-email")) {
            const attr = item.getAttribute("data-email");
            if (attr && !emailList.includes(attr)) emailList.push(attr);
          }
        });

        return [...new Set(emailList)];
      });

      const hasSignedOut = await page.evaluate(() => {
        return document.body.innerText.includes("Signed out");
      });

      if (hasSignedOut) {
        return {
          sessionCount: 0,
          emails: [],
          signedOut: true,
        };
      }

      const url = page.url();
      let sessionCount = emails.length;

      return {
        sessionCount: sessionCount,
        emails: emails,
      };
    } catch (error) {
      throw new Error(`Check failed: ${error.message}`);
    } finally {
      await browser.close();
    }
  }
}

import chalk from "chalk";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { logMessage, prompt } from "../utils/logger.js";
import ProfileManager from "../utils/profileManager.js";

export default class FirstSetup {
  static async execute() {
    logMessage(null, null, "Starting First Setup...", "info");
    const password = await prompt(
      chalk.yellow("Enter the Password for all accounts: "),
    );
    let profilePrefix = "profile";
    const nameChoice = await prompt(
      chalk.yellow(
        "Enter Profile Folder Name (press Enter for 'profile', type 'random' for random ID, or type any name): ",
      ),
    );

    if (nameChoice.trim() === "random") {
      profilePrefix = "profile_" + crypto.randomBytes(3).toString("hex");
    } else if (nameChoice.trim().length > 0) {
      profilePrefix = nameChoice.trim();
    }

    logMessage(
      null,
      null,
      `Using Profile Prefix: ${profilePrefix}_[index]`,
      "info",
    );

    const concurrencyInput = await prompt(
      chalk.yellow(
        "Enter Concurrency Limit (how many profiles at once, default 1): ",
      ),
    );
    const concurrency = parseInt(concurrencyInput) || 1;
    logMessage(null, null, `Using Concurrency: ${concurrency}`, "info");

    const refillInput = await prompt(
      chalk.yellow(
        "Enable Auto-Refill for incomplete profiles? (y/N, default No): ",
      ),
    );
    const enableRefill = refillInput.trim().toLowerCase() === "y";
    logMessage(
      null,
      null,
      `Auto-Refill: ${enableRefill ? "Enabled" : "Disabled"}`,
      enableRefill ? "success" : "warning",
    );

    const batches = ProfileManager.getAccountBatches(10, enableRefill);
    logMessage(
      null,
      null,
      `Found ${batches.length} batches of accounts.`,
      "warning",
    );

    const batchQueue = [...batches];
    const activeExecutions = new Set();
    const availableSlots = Array(concurrency)
      .fill(false)
      .map((_, i) => i);

    const cleanupAndExit = () => {
      if (activeExecutions.size > 0) {
        const count = ProfileManager.unlockAllProfiles();
      }
      process.exit(0);
    };

    process.on("SIGINT", cleanupAndExit);
    process.on("SIGTERM", cleanupAndExit);

    logMessage(
      null,
      null,
      `Queue initialized with ${batchQueue.length} batches.`,
      "success",
    );

    const runNext = () => {
      while (availableSlots.length > 0 && batchQueue.length > 0) {
        const slotId = availableSlots.shift();
        const accounts = batchQueue.shift();

        const globalIndex = batches.indexOf(accounts);
        const batchIndex = globalIndex + 1;

        let profilePath;
        let batchLabel;

        if (accounts.isRefill && accounts.targetProfile) {
          batchLabel = `Refill ${accounts.targetProfile}`;
          profilePath = path.join(
            ProfileManager.getProfilesDir(),
            accounts.targetProfile,
          );
          console.log(
            chalk.green(
              `\n[Auto-Refill] Processing refill for ${accounts.targetProfile} with ${accounts.accounts.length} accounts.`,
            ),
          );
        } else {
          batchLabel = `Batch ${batchIndex}`;
          profilePath = ProfileManager.getProfilePath(
            batchIndex,
            profilePrefix,
          );
        }

        const accountsToProcess = accounts.isRefill
          ? accounts.accounts
          : accounts;

        activeExecutions.add(batchLabel);

        const colCount = 4;
        const width = 450;
        const height = 600;
        const x = (slotId % colCount) * width;
        const y = Math.floor(slotId / colCount) * height;

        console.log(
          chalk.magenta(
            `\n[Queue] Starting ${batchLabel} (Accounts: ${accountsToProcess.length}) on Slot ${slotId} [Window: ${x},${y}]`,
          ),
        );

        this.processBatch(
          batchIndex,
          profilePath,
          accountsToProcess,
          password,
          {
            x,
            y,
            width,
            height,
          },
        )
          .then(() => {
            logMessage(
              null,
              null,
              `[Queue] ${batchLabel} Finished. Removing accounts...`,
              "success",
            );
            ProfileManager.removeAccounts(accountsToProcess);
          })
          .catch((err) => {
            logMessage(
              null,
              null,
              `[Queue] ${batchLabel} Error: ${err.message}`,
              "error",
            );
          })
          .finally(() => {
            activeExecutions.delete(batchLabel);
            availableSlots.push(slotId);
            availableSlots.sort((a, b) => a - b);
            runNext();
          });
      }
    };

    runNext();

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (activeExecutions.size === 0 && batchQueue.length === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });

    logMessage(null, null, "First Setup Completed!", "success");
  }

  static async processBatch(
    batchIndex,
    profilePath,
    accounts,
    password,
    windowPos = null,
  ) {
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }
    const lockFile = path.join(profilePath, "process.lock");

    if (fs.existsSync(lockFile)) {
      throw new Error(
        `Profile ${path.basename(profilePath)} is locked by another process.`,
      );
    }

    try {
      fs.writeFileSync(lockFile, "LOCKED");
    } catch (e) {
      throw new Error(`Failed to create lock file: ${e.message}`);
    }

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
      headless: false,
      defaultViewport: null,
      userDataDir: profilePath,
      args: defaultArgs,
    });

    const openPages = await browser.pages();
    const page = await browser.newPage();
    for (const oldPage of openPages) {
      if (oldPage !== page) {
        try {
          await oldPage.close();
        } catch (e) {}
      }
    }

    try {
      for (let i = 0; i < accounts.length; i++) {
        const accountEmail = accounts[i];
        logMessage(
          i + 1,
          accounts.length,
          `Logging in account: ${accountEmail}`,
          "process",
        );

        await this.loginAndSetup(browser, accountEmail, password, i);
      }
    } catch (error) {
      logMessage(
        null,
        null,
        `Error in batch ${batchIndex}: ${error.message}`,
        "error",
      );
    } finally {
      await browser.close();
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    }
  }

  static async loginAndSetup(browser, email, password, accountIndex) {
    const page = await browser.newPage();
    try {
      const targetUrl = "https://accounts.google.com/AddSession";
      if (accountIndex === 0) {
        await page.goto("https://accounts.google.com/", {
          waitUntil: "networkidle2",
        });
      } else {
        await page.goto(targetUrl, {
          waitUntil: "networkidle2",
        });
      }

      logMessage(null, null, `[${email}] Navigating to login...`, "debug");
      await new Promise((r) => setTimeout(r, 2000));

      try {
        const emailSelector = 'input[type="email"]';
        const emailInput = await page.$(emailSelector);

        if (emailInput) {
          await page.type(emailSelector, email);
          await page.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, 6000));

          const passwordSelector = 'input[type="password"]';
          await page.waitForSelector(passwordSelector, {
            timeout: 10000,
            visible: true,
          });
          await page.type(passwordSelector, password);
          await page.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, 7000));

          await page.keyboard.press("Enter");
          await new Promise((r) => setTimeout(r, 5000));

          try {
            const iUnderstandSelector =
              "#gaplustosNext > div > button > div.VfPpkd-RLmnJb";
            const iUnderstandBtn = await page.$(iUnderstandSelector);
            if (iUnderstandBtn) {
              await iUnderstandBtn.click();
              logMessage(
                null,
                null,
                `[${email}] Clicked 'I understand'.`,
                "debug",
              );
              await new Promise((r) => setTimeout(r, 3000));
            }
            const confirmBtn = await page.$("#confirm");
            if (confirmBtn) {
              await confirmBtn.click();
              await new Promise((r) => setTimeout(r, 3000));
            }
          } catch (e) {}
        } else {
          logMessage(
            null,
            null,
            `[${email}] Email field not found (Already logged in?).`,
            "info",
          );
        }
      } catch (e) {
        logMessage(
          null,
          null,
          `[${email}] Login automation step skipped/missed: ${e.message}`,
          "warning",
        );
      }

      try {
        await page.goto(`https://idx.google.com/u/${accountIndex}/`, {
          waitUntil: "networkidle2",
        });
        await new Promise((r) => setTimeout(r, 3000));

        const utosInputSelector =
          "div.checkboxes > label:nth-child(1) input#utos-checkbox";
        if (await page.$(utosInputSelector)) {
          const isChecked = await page.$eval(
            utosInputSelector,
            (el) => el.checked,
          );
          if (!isChecked) {
            await page.$eval(utosInputSelector, (el) => el.click());
            logMessage(
              null,
              null,
              `[${email}] TOS Checkbox clicked via JS.`,
              "debug",
            );
            await new Promise((r) => setTimeout(r, 1000));

            const submitBtn = await page.$("#submit-button");
            if (submitBtn) {
              await submitBtn.click();
              logMessage(null, null, `[${email}] TOS Accepted.`, "success");
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
        }
      } catch (e) {}

      try {
        await page.goto(`https://idx.google.com/u/${accountIndex}/`, {
          waitUntil: "networkidle2",
        });

        const workspaceListSelector = "div.your-workspaces";
        try {
          await page.waitForSelector(workspaceListSelector, { timeout: 8000 });
        } catch (e) {}

        const currentWorkspaces = await page.evaluate(() => {
          const els = document.querySelectorAll(
            "div.your-workspaces > workspace",
          );
          return els.length;
        });

        logMessage(
          null,
          null,
          `[${email}] Found ${currentWorkspaces} existing workspace(s).`,
          "info",
        );

        if (currentWorkspaces < 2) {
          const needed = 2 - currentWorkspaces;
          logMessage(
            null,
            null,
            `[${email}] Needs ${needed} more workspaces. Importing...`,
            "process",
          );

          for (let j = 0; j < needed; j++) {
            try {
              const importUrl = `https://idx.google.com/u/${accountIndex}/import`;
              await page.goto(importUrl, { waitUntil: "networkidle2" });
              await new Promise((r) => setTimeout(r, 2000));

              const suspicious = await page.evaluate(() => {
                const keywords = [
                  "suspicious activity",
                  "we've detected",
                  "contact support",
                ];

                const selectors = [
                  ".error-section",
                  ".callout.severity-error",
                  "app-root > ui-loader > new-template-git-app p",
                  "div.error-message",
                ];

                for (let sel of selectors) {
                  const els = document.querySelectorAll(sel);
                  for (let el of els) {
                    const text = el.innerText.toLowerCase();
                    if (keywords.some((k) => text.includes(k))) return true;
                  }
                }

                if (
                  document.body.innerText.length < 500 &&
                  document.body.innerText.toLowerCase().includes("suspicious")
                ) {
                  return true;
                }

                return false;
              });

              if (suspicious) {
                logMessage(
                  null,
                  null,
                  `[${email}] ❌ SUSPICIOUS ACTIVITY DETECTED! Removing account...`,
                  "error",
                );
                ProfileManager.removeAccounts([email]);
                return;
              }

              const repoUrl = "https://github.com/3ncryptz/table";
              const inputSelector = "#mat-input-1";

              await page.waitForSelector(inputSelector, { timeout: 10000 });
              await page.type(inputSelector, repoUrl);
              await new Promise((r) => setTimeout(r, 1000));

              const flutterSelector = "#flutter-checkbox";
              await page.waitForSelector(flutterSelector, { timeout: 5000 });
              await page.click(flutterSelector);
              await new Promise((r) => setTimeout(r, 1000));

              const createBtnSelector = "#create-button";
              await page.waitForSelector(createBtnSelector, { timeout: 5000 });
              await page.click(createBtnSelector);
              await new Promise((r) => setTimeout(r, 2000));

              const suspiciousPost = await page.evaluate(() => {
                const keywords = [
                  "suspicious activity",
                  "we've detected",
                  "contact support",
                ];
                const selectors = [
                  ".error-section",
                  ".callout.severity-error",
                  "app-root > ui-loader > new-template-git-app p",
                  "div.error-message",
                ];
                for (let sel of selectors) {
                  const els = document.querySelectorAll(sel);
                  for (let el of els) {
                    const text = el.innerText.toLowerCase();
                    if (keywords.some((k) => text.includes(k))) return true;
                  }
                }
                if (
                  document.body.innerText.length < 500 &&
                  document.body.innerText.toLowerCase().includes("suspicious")
                )
                  return true;
                return false;
              });

              if (suspiciousPost) {
                logMessage(
                  null,
                  null,
                  `[${email}] ❌ SUSPICIOUS ACTIVITY (Post-Click)! Removing account...`,
                  "error",
                );
                ProfileManager.removeAccounts([email]);
                return;
              }

              logMessage(
                null,
                null,
                `[${email}] Import clicked. Waiting for API...`,
                "debug",
              );

              try {
                await page.waitForRequest(
                  (request) =>
                    request
                      .url()
                      .includes(
                        "peoplestack.PeopleStackAutocompleteService/Lookup",
                      ),
                  { timeout: 120000 },
                );
                logMessage(
                  null,
                  null,
                  `[${email}] Workspace ${j + 1} started/confirmed.`,
                  "success",
                );
                await new Promise((r) => setTimeout(r, 5000));
              } catch (e) {
                logMessage(
                  null,
                  null,
                  `[${email}] Timeout waiting for API (might be slow).`,
                  "warning",
                );
              }
            } catch (err) {
              logMessage(
                null,
                null,
                `[${email}] Import error: ${err.message}`,
                "error",
              );
            }
          }
        } else {
          logMessage(
            null,
            null,
            `[${email}] Has sufficient workspaces.`,
            "success",
          );
        }
      } catch (e) {
        logMessage(
          null,
          null,
          `[${email}] Setup check failed: ${e.message}`,
          "error",
        );
      }
    } catch (error) {
      logMessage(null, null, `[${email}] Failed: ${error.message}`, "error");
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }
}

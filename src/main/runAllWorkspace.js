import chalk from "chalk";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import Dashboard from "../utils/dashboard.js";
import { logMessage } from "../utils/logger.js";
import ProfileManager from "../utils/profileManager.js";
import ProfileStats from "../utils/profileStats.js";
import TelegramBot from "../utils/telegram.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");

export default class RunAllWorkspace {
  static async execute() {
    let config = {};
    try {
      config = JSON.parse(
        fs.readFileSync(path.join(PROJECT_ROOT, "config.json"), "utf-8"),
      );
    } catch (e) {
      logMessage(
        null,
        null,
        "Failed to load config.json, using defaults.",
        "error",
      );
    }

    const useDashboard = config.dashboard?.enabled || false;
    const concurrency = config.runSettings?.concurrency || 1;
    const delayMinutes = config.runSettings?.loopDelayMinutes || 10;
    const isHeadless = config.runSettings?.headless !== false;

    TelegramBot.init(config.telegram);
    if (useDashboard) {
      Dashboard.init(concurrency);
    } else {
      logMessage(
        null,
        null,
        "Starting Run All Workspaces (Dashboard Disabled)...",
        "info",
      );
    }

    const profilesDir = ProfileManager.getProfilesDir();

    const sortQueue = (queue) => {
      return queue.sort((a, b) => {
        const nameA = path.basename(a);
        const nameB = path.basename(b);
        const lastRunA = ProfileStats.getLastRun(nameA);
        const lastRunB = ProfileStats.getLastRun(nameB);
        return lastRunA - lastRunB;
      });
    };

    let profileFolders = fs
      .readdirSync(profilesDir)
      .filter((f) => fs.lstatSync(path.join(profilesDir, f)).isDirectory())
      .map((f) => path.join(profilesDir, f));
    let profileQueue = [...profileFolders];
    sortQueue(profileQueue);

    const knownProfiles = new Set(profileFolders);
    const activeExecutions = new Set();
    const availableSlots = Array(concurrency)
      .fill(false)
      .map((_, i) => i);

    const cleanupAndExit = () => {
      if (activeExecutions.size > 0) {
        const profilesDir = ProfileManager.getProfilesDir();
        activeExecutions.forEach((name) => {
          const lockPath = path.join(profilesDir, name, "process.lock");
          if (fs.existsSync(lockPath)) {
            try {
              fs.unlinkSync(lockPath);
            } catch (e) {}
          }
        });
      }
      process.exit(0);
    };

    process.on("SIGINT", cleanupAndExit);
    process.on("SIGTERM", cleanupAndExit);

    let completedCount = 0;
    let errorCount = 0;

    setInterval(() => {
      const currentProfilesDir = ProfileManager.getProfilesDir();
      if (fs.existsSync(currentProfilesDir)) {
        const currentFolders = fs
          .readdirSync(currentProfilesDir)
          .filter((f) =>
            fs.lstatSync(path.join(currentProfilesDir, f)).isDirectory(),
          )
          .map((f) => path.join(currentProfilesDir, f));

        let newDetected = false;
        currentFolders.forEach((p) => {
          if (!knownProfiles.has(p)) {
            knownProfiles.add(p);
            if (!fs.existsSync(path.join(p, "process.lock"))) {
              profileQueue.push(p);
              newDetected = true;
            }
          }
        });

        if (newDetected) {
          sortQueue(profileQueue);
          if (useDashboard)
            Dashboard.addLog(
              `Using Hot-Reload: ${activeExecutions.size} active sessions.`,
            );
          runNext();
        }
      }
    }, 5000);

    const runNext = () => {
      while (availableSlots.length > 0 && profileQueue.length > 0) {
        const slotId = availableSlots.shift();
        const profilePath = profileQueue.shift();
        const profileName = path.basename(profilePath);

        activeExecutions.add(profileName);

        if (useDashboard) {
          Dashboard.updateSlot(slotId, profileName, "Starting...", "cyan");
          Dashboard.updateStats(knownProfiles.size, completedCount, errorCount);
        } else {
          console.log(
            chalk.magenta(
              `\n[Queue] Starting ${profileName} on Slot ${slotId}`,
            ),
          );
        }

        const colCount = 4;
        const width = 450;
        const height = 600;
        const x = (slotId % colCount) * width;
        const y = Math.floor(slotId / colCount) * height;

        this.processProfile(
          profilePath,
          { x, y, width, height },
          isHeadless,
          slotId,
          useDashboard,
        )
          .then(() => {
            ProfileStats.updateLastRun(profileName);
            completedCount++;

            if (useDashboard) {
              Dashboard.updateSlot(
                slotId,
                profileName,
                `Done (Cooldown ${delayMinutes}m)`,
                "green",
              );
              Dashboard.addLog(`[${profileName}] Completed successfully.`);
            } else {
              logMessage(
                null,
                null,
                `[Queue] ${profileName} Finished.`,
                "success",
              );
            }
            TelegramBot.send(
              `✅ **Profile Success**: \`${profileName}\` completed processing.`,
            );
          })
          .catch((err) => {
            ProfileStats.updateLastRun(profileName);

            if (err.message === "SKIP_LOCKED") {
              if (useDashboard)
                Dashboard.updateSlot(
                  slotId,
                  profileName,
                  "Locked (Skipping)",
                  "yellow",
                );
            } else {
              errorCount++;
              if (useDashboard) {
                Dashboard.updateSlot(slotId, profileName, "Failed", "red");
                Dashboard.addLog(`[${profileName}] Error: ${err.message}`);
              } else {
                logMessage(
                  null,
                  null,
                  `[Queue] ${profileName} Error: ${err.message}`,
                  "error",
                );
              }
              TelegramBot.send(
                `⚠️ **Profile Error**: \`${profileName}\` failed: ${err.message}`,
              );
            }
          })
          .finally(() => {
            activeExecutions.delete(profileName);
            availableSlots.push(slotId);
            availableSlots.sort((a, b) => a - b);

            setTimeout(
              () => {
                if (useDashboard)
                  Dashboard.addLog(`[${profileName}] Woke up from cooldown.`);
                profileQueue.unshift(profilePath);
                runNext();
              },
              delayMinutes * 60 * 1000,
            );

            runNext();
          });
      }
    };

    runNext();

    await new Promise(() => {});
  }

  static async processProfile(
    profilePath,
    windowPos = null,
    isHeadless = false,
    slotId = 0,
    useDashboard = false,
  ) {
    const lockFile = path.join(profilePath, "process.lock");
    if (fs.existsSync(lockFile)) {
      throw new Error("SKIP_LOCKED");
    }

    try {
      fs.writeFileSync(lockFile, "LOCKED_BY_RUN_ALL");
    } catch (e) {
      throw new Error(`Lock failed: ${e.message}`);
    }

    const updateStatus = (status, color = "white") => {
      if (useDashboard)
        Dashboard.updateSlot(slotId, path.basename(profilePath), status, color);
    };

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

    let browser;
    try {
      updateStatus("Launching Browser...", "cyan");
      browser = await puppeteer.launch({
        headless: isHeadless,
        defaultViewport: null,
        userDataDir: profilePath,
        args: defaultArgs,
      });

      await new Promise((r) => setTimeout(r, 2000));

      const openPages = await browser.pages();
      if (openPages.length > 0) {
      }

      const page = await browser.newPage();

      for (const oldPage of openPages) {
        try {
          await oldPage.close();
        } catch (e) {}
      }

      logMessage(null, null, "Checking for active sessions...", "debug");
      const sessionCount = await this.countActiveSessions(browser);

      if (sessionCount === 0) {
        updateStatus("No Sessions Found", "yellow");
        if (useDashboard)
          Dashboard.addLog(
            `[${path.basename(profilePath)}] Warn: No sessions.`,
          );
      } else {
        updateStatus(`Processing ${sessionCount} Sessions`, "blue");
      }

      for (let i = 0; i < sessionCount; i++) {
        updateStatus(`Account ${i + 1}/${sessionCount}: Checking...`, "blue");
        await this.processAccount(browser, i, sessionCount, (msg) => {
          updateStatus(`Acc ${i + 1}: ${msg}`, "blue");
        });
      }
    } catch (error) {
      logMessage(
        null,
        null,
        `Error in profile ${path.basename(profilePath)}: ${error.message}`,
        "error",
      );
      throw error;
    } finally {
      if (browser) await browser.close();
      if (fs.existsSync(lockFile)) {
        try {
          fs.unlinkSync(lockFile);
        } catch (e) {}
      }
    }
  }

  static async countActiveSessions(browser) {
    const page = await browser.newPage();
    try {
      await page.goto("https://accounts.google.com/AccountChooser", {
        waitUntil: "networkidle2",
      });

      if (
        page.url().includes("ServiceLogin") ||
        page.url().includes("signin/v2/identifier")
      ) {
        return 0;
      }

      try {
        await page.waitForSelector("ul li", { timeout: 5000 });

        const count = await page.evaluate(() => {
          const items = document.querySelectorAll("ul li");
          let accountCount = 0;
          items.forEach((item) => {
            if (item.innerText.includes("@") || item.closest("[data-email]")) {
              accountCount++;
            }
          });
          return accountCount;
        });

        if (count > 0) return count;
        return 1;
      } catch (e) {
        return 1;
      }
    } catch (e) {
      logMessage(
        null,
        null,
        `Failed to count sessions: ${e.message}`,
        "warning",
      );
      return 1;
    } finally {
      await page.close();
    }
  }

  static async processAccount(
    browser,
    accountIndex,
    totalAccounts,
    updateStatusCallback = null,
  ) {
    const log = (idx, total, msg, type) => {
      if (updateStatusCallback) {
        updateStatusCallback(msg);
        if (type === "success" || type === "error") {
          Dashboard.addLog(`[Acc ${accountIndex + 1}] ${msg}`);
        }
      } else {
        logMessage(idx, total, msg, type);
      }
    };

    log(
      accountIndex + 1,
      totalAccounts,
      `Checking account index ${accountIndex} (authuser=${accountIndex})...`,
      "process",
    );

    const page = await browser.newPage();

    try {
      const idxUrl = `https://idx.google.com/?authuser=${accountIndex}`;

      await page.goto(idxUrl, { waitUntil: "networkidle2", timeout: 60000 });

      const currentUrl = page.url();
      if (
        currentUrl.includes("accounts.google.com") ||
        currentUrl.includes("AccountChooser")
      ) {
        log(
          accountIndex + 1,
          totalAccounts,
          "Skipped (Redirected to login/chooser)",
          "warning",
        );
        return;
      }

      try {
        const utosInputSelector =
          "div.checkboxes > label:nth-child(1) input#utos-checkbox";
        if (await page.$(utosInputSelector)) {
          const isChecked = await page.$eval(
            utosInputSelector,
            (el) => el.checked,
          );
          if (!isChecked) {
            await page.$eval(utosInputSelector, (el) => el.click());
            log(
              accountIndex + 1,
              totalAccounts,
              "TOS Checkbox clicked via JS.",
              "debug",
            );
            await new Promise((r) => setTimeout(r, 1000));
            const submitBtn = await page.$("#submit-button");
            if (submitBtn) {
              await submitBtn.click();
              log(accountIndex + 1, totalAccounts, "TOS Accepted.", "success");
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
        }
      } catch (e) {}

      const workspaceListSelector =
        "body > app-root > ui-loader > firebase-studio-dashboard > idx-app-chrome > div > div.columns > div.workspaces-sections > div > your-workspaces > div.your-workspaces";

      const workspaceListSelectorAlt = "div.your-workspaces";

      try {
        log(
          accountIndex + 1,
          totalAccounts,
          "Checking for workspace list...",
          "debug",
        );

        try {
          await page.waitForSelector(workspaceListSelectorAlt, {
            timeout: 15000,
            visible: true,
          });
        } catch (e) {}

        await new Promise((r) => setTimeout(r, 3000));

        const workspaceCount = await page.evaluate(() => {
          const el = document.querySelector("div.your-workspaces");
          return el ? el.children.length : 0;
        });

        log(
          accountIndex + 1,
          totalAccounts,
          `Found ${workspaceCount} workspaces.`,
          "success",
        );

        if (workspaceCount < 2) {
          const needed = 2 - workspaceCount;
          log(
            accountIndex + 1,
            totalAccounts,
            `Need ${needed} more workspace(s). Importing...`,
            "warning",
          );

          for (let j = 0; j < needed; j++) {
            log(
              accountIndex + 1,
              totalAccounts,
              `Importing Workspace ${j + 1}/${needed}...`,
              "process",
            );
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
                )
                  return true;
                return false;
              });

              if (suspicious) {
                log(
                  accountIndex + 1,
                  totalAccounts,
                  `❌ SUSPICIOUS ACTIVITY (Account ${accountIndex})! Skipping...`,
                  "error",
                );
                return;
              }

              const repoUrl = "https://github.com/3ncryptz/table";
              const inputSelector = "#mat-input-1";

              await page.waitForSelector(inputSelector, { timeout: 10000 });
              await page.type(inputSelector, repoUrl);
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
                log(
                  accountIndex + 1,
                  totalAccounts,
                  `❌ SUSPICIOUS ACTIVITY (Post-Click)! Skipping...`,
                  "error",
                );
                return;
              }

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
                log(
                  accountIndex + 1,
                  totalAccounts,
                  `Import ${j + 1} confirmed.`,
                  "success",
                );
                log(
                  accountIndex + 1,
                  totalAccounts,
                  `Waiting for workspace to be active... (10s)`,
                  "debug",
                );
                await new Promise((r) => setTimeout(r, 10000));
              } catch (e) {
                log(
                  accountIndex + 1,
                  totalAccounts,
                  `Timeout waiting for API.`,
                  "warning",
                );
              }
            } catch (e) {
              log(
                accountIndex + 1,
                totalAccounts,
                `Import failed: ${e.message}`,
                "error",
              );
            }
          }

          log(
            accountIndex + 1,
            totalAccounts,
            "Reloading dashboard to fetch new workspaces...",
            "info",
          );
          await page.goto(idxUrl, { waitUntil: "networkidle2" });
          await page.waitForSelector(workspaceListSelectorAlt, {
            timeout: 10000,
          });
        }

        const finalWorkspaceCount = await page.evaluate(() => {
          const el = document.querySelector("div.your-workspaces");
          return el ? el.children.length : 0;
        });

        if (finalWorkspaceCount > 0) {
          const workspaceNames = await page.evaluate(() => {
            const workspaceElements = document.querySelectorAll(
              "div.your-workspaces > workspace",
            );
            const names = [];
            workspaceElements.forEach((el) => {
              const nameEl = el.querySelector("span.workspace-id");
              if (nameEl) {
                names.push(nameEl.innerText.trim());
              }
            });
            return names;
          });

          workspaceNames.forEach((name) => {
            console.log(chalk.blue(`Workspace found: ${name}`));
          });

          if (workspaceNames.length > 0) {
            log(
              accountIndex + 1,
              totalAccounts,
              `Extracted ${workspaceNames.length} workspace names.`,
              "info",
            );

            for (const name of workspaceNames) {
              const workspaceUrl = `https://idx.google.com/u/${accountIndex}/${name}`;
              log(
                accountIndex + 1,
                totalAccounts,
                `Opening workspace: ${name}`,
                "process",
              );

              try {
                const workspacePagePromise = page.goto(workspaceUrl, {
                  waitUntil: "domcontentloaded",
                  timeout: 60000,
                });

                await new Promise((r) => setTimeout(r, 4000));

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
                  )
                    return true;
                  return false;
                });

                if (suspicious) {
                  log(
                    accountIndex + 1,
                    totalAccounts,
                    `❌ SUSPICIOUS ACTIVITY on Workspace ${name}! Skipping...`,
                    "error",
                  );
                  return;
                }

                log(
                  accountIndex + 1,
                  totalAccounts,
                  `Waiting for PeopleStack API...`,
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
                  log(
                    accountIndex + 1,
                    totalAccounts,
                    `API Detected for ${name}`,
                    "success",
                  );
                  log(
                    accountIndex + 1,
                    totalAccounts,
                    `Waiting for workspace to be active... (10s)`,
                    "debug",
                  );
                  await new Promise((r) => setTimeout(r, 10000));
                } catch (e) {
                  log(
                    accountIndex + 1,
                    totalAccounts,
                    `Timeout waiting for API on ${name} (Active? ${!page.isClosed()})`,
                    "warning",
                  );
                }

                await workspacePagePromise.catch(() => {});
              } catch (error) {
                logMessage(
                  accountIndex + 1,
                  totalAccounts,
                  `Error opening ${name}: ${error.message}`,
                  "error",
                );
              }
            }
          }
        }
      } catch (e) {
        log(
          accountIndex + 1,
          totalAccounts,
          "Workspace list NOT found (or other error).",
          "error",
        );
      }
    } catch (error) {
      log(accountIndex + 1, totalAccounts, `Error: ${error.message}`, "error");
    } finally {
      if (!page.isClosed()) await page.close();
    }
  }
}

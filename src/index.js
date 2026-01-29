import chalk from "chalk";
import CheckProfiles from "./main/checkProfiles.js";
import FirstSetup from "./main/firstSetup.js";
import LoginOnly from "./main/loginOnly.js";
import RunAllWorkspace from "./main/runAllWorkspace.js";
import { logMessage, prompt, rl } from "./utils/logger.js";
import ProfileManager from "./utils/profileManager.js";

async function main() {
  console.clear();
  console.log(
    chalk.cyan(`
░█▄█░█▀█░█▀█░█▀▀░█▀▄░█▀█
░█░█░█░█░█░█░█▀▀░█▀▄░█░█
░▀░▀░▀▀▀░▀░▀░▀▀▀░▀░▀░▀▀▀
    Monero XMR Automation
  `),
  );

  logMessage(null, null, "Select Mode:", "info");
  logMessage(null, null, "1. First Setup (Login & Save Profiles)", "info");
  logMessage(null, null, "2. Login Only (Refresh Sessions)", "info");
  logMessage(null, null, "3. Run All Workspaces (Execute Tasks)", "info");
  logMessage(null, null, "4. Check Profiles (Inspect & Save Emails)", "info");

  const choice = await prompt(chalk.green("\nEnter your choice (1-5): "));

  try {
    switch (choice.trim()) {
      case "1":
        await FirstSetup.execute();
        break;
      case "2":
        await LoginOnly.execute();
        break;
      case "3":
        await RunAllWorkspace.execute();
        break;
      case "4":
        await CheckProfiles.execute();
        break;
      case "5":
        const count = ProfileManager.unlockAllProfiles();
        logMessage(null, null, `Unlocked ${count} profiles.`, "success");
        break;
      default:
        logMessage(null, null, "Invalid choice!", "error");
        rl.close();
        break;
    }
  } catch (error) {
    logMessage(null, null, `An error occurred: ${error.message}`, "error");
  }
}

main();

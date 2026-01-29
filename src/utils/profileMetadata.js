import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
const METADATA_FILE = path.join(PROJECT_ROOT, "profile_metadata.json");

export default class ProfileMetadata {
  static loadMetadata() {
    if (!fs.existsSync(METADATA_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(METADATA_FILE, "utf-8"));
    } catch (e) {
      return {};
    }
  }

  static saveMetadata(metadata) {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  }

  static updateProfile(profileName, data) {
    const metadata = this.loadMetadata();
    metadata[profileName] = {
      ...data,
      lastChecked: Date.now(),
    };
    this.saveMetadata(metadata);
  }

  static deleteProfile(profileName) {
    const metadata = this.loadMetadata();
    if (metadata[profileName]) {
      delete metadata[profileName];
      this.saveMetadata(metadata);
    }
  }
}

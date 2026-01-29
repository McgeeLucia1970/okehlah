import axios from "axios";

export default class TelegramBot {
  static enabled = false;
  static botToken = "";
  static chatId = "";

  static init(config) {
    if (
      config &&
      config.enabled &&
      config.botToken &&
      config.chatId &&
      config.botToken !== "YOUR_BOT_TOKEN"
    ) {
      this.enabled = true;
      this.botToken = config.botToken;
      this.chatId = config.chatId;
      this.send("🤖 **Monero Bot Started!**\nMonitoring initialized.");
      console.log("[Telegram] Initialized.");
    } else {
      console.log("[Telegram] Disabled or Invalid Config.");
    }
  }

  static dashboardMessageId = null;
  static lastUpdate = 0;
  static pendingUpdate = null;

  static async send(message) {
    if (!this.enabled) return;
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await axios.post(url, {
        chat_id: this.chatId,
        text: message,
        parse_mode: "Markdown",
      });
      return res.data;
    } catch (e) {}
  }

  static async updateDashboard(slots, stats) {
    if (!this.enabled) return;

    const now = Date.now();
    if (now - this.lastUpdate < 2000) {
      this.pendingUpdate = { slots, stats };
      return;
    }

    this.lastUpdate = now;
    this.pendingUpdate = null;

    let msg = `📊 **Monero Bot Dashboard**\n`;
    msg += `Total: ${stats.total} | Done: ${stats.done} | Err: ${stats.errors}\n`;
    msg += `-----------------------------------\n`;

    Object.keys(slots).forEach((id) => {
      const s = slots[id];
      const icon = s.status.includes("Waiting")
        ? "⏳"
        : s.status.includes("Done")
          ? "✅"
          : s.status.includes("Error")
            ? "❌"
            : "▶️";
      msg += `\`Slot ${id}\`: ${icon} ${s.status}\n`;
    });
    msg += `-----------------------------------\n`;
    msg += `_Last Update: ${new Date().toLocaleTimeString("id-ID")}_`;

    if (!this.dashboardMessageId) {
      const res = await this.send(msg);
      if (res && res.result) {
        this.dashboardMessageId = res.result.message_id;
      }
    } else {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
        await axios.post(url, {
          chat_id: this.chatId,
          message_id: this.dashboardMessageId,
          text: msg,
          parse_mode: "Markdown",
        });
      } catch (e) {
        if (e.response && e.response.status === 400) {
          this.dashboardMessageId = null;
        }
      }
    }
  }

  static {
    setInterval(() => {
      if (this.pendingUpdate) {
        this.updateDashboard(
          this.pendingUpdate.slots,
          this.pendingUpdate.stats,
        );
      }
    }, 3000);
  }
}

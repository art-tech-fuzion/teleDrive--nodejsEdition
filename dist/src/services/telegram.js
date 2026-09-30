const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { CustomFile } = require("telegram/client/uploads");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const Helpers = require("../utils/helpers");

class TelegramService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectingPromise = null;
    this.resolvedEntities = new Map();
  }

  async getClient() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      if (!config.isConfigured()) {
        throw new Error(
          "Telegram MTProto credentials not configured. Please check your .env file.",
        );
      }

      const stringSession = new StringSession(config.STRING_SESSION || "");
      this.client = new TelegramClient(
        stringSession,
        config.API_ID,
        config.API_HASH,
        {
          connectionRetries: 5,
          useWSS: false,
          autoReconnect: true,
          timeout: 30000,
          floodSleepThreshold: 120,
        },
      );

      await this.client.connect();
      this.isConnected = true;
      this.connectingPromise = null;

      try {
        await this.client.getDialogs({ limit: 100 });
      } catch (e) {

      }

      return this.client;
    })();

    return this.connectingPromise;
  }

  async getEntity(channelId) {
    if (!channelId) throw new Error("Channel ID is required");
    const cacheKey = String(channelId);
    if (this.resolvedEntities.has(cacheKey)) {
      return this.resolvedEntities.get(cacheKey);
    }

    const client = await this.getClient();
    const strId = String(channelId).trim();
    const stripped = strId.replace(/^-100/, "").replace(/^-/, "");

    let dialogs = [];
    try {
      const mainDialogs = await client.getDialogs({ limit: 500 });
      dialogs.push(...mainDialogs);
    } catch (e) {
      console.warn("Main dialog search warning:", e.message);
    }

    try {

      const archivedDialogs = await client.getDialogs({
        limit: 500,
        folder: 1,
      });
      dialogs.push(...archivedDialogs);
    } catch (e) {

    }

    for (const d of dialogs) {
      const dId = d.id ? d.id.toString().trim() : "";
      const dStripped = dId.replace(/^-100/, "").replace(/^-/, "");
      const entityId = d.entity?.id ? d.entity.id.toString().trim() : "";
      const entityStripped = entityId.replace(/^-100/, "").replace(/^-/, "");

      const isMatch =
        dId === strId ||
        dStripped === stripped ||
        entityId === strId ||
        entityStripped === stripped ||
        (d.name && d.name.trim().toLowerCase() === strId.toLowerCase());

      if (isMatch) {
        const input =
          d.inputEntity ||
          (d.entity ? await client.getInputEntity(d.entity) : null);
        if (input && input.className !== "InputPeerChat") {
          this.resolvedEntities.set(cacheKey, input);
          return input;
        }
      }
    }

    if (!/^-?\d+$/.test(strId)) {
      try {
        const entity = await client.getInputEntity(strId);
        if (entity && entity.className !== "InputPeerChat") {
          this.resolvedEntities.set(cacheKey, entity);
          return entity;
        }
      } catch (e) {}
    }

    try {
      const entity = await client.getInputEntity(channelId);
      if (
        entity &&
        !(strId.startsWith("-100") && entity.className === "InputPeerChat")
      ) {
        this.resolvedEntities.set(cacheKey, entity);
        return entity;
      }
    } catch (e) {}

    try {
      const entity = await client.getEntity(channelId);
      if (entity) {
        const input = await client.getInputEntity(entity);
        if (
          input &&
          !(strId.startsWith("-100") && input.className === "InputPeerChat")
        ) {
          this.resolvedEntities.set(cacheKey, input);
          return input;
        }
      }
    } catch (e) {}

    const availableChannels = (dialogs || [])
      .filter((d) => d.isChannel || d.isGroup)
      .map(
        (d) =>
          `"${d.title || d.name}" (ID: ${d.id ? d.id.toString() : "unknown"})`,
      )
      .join(", ");

    console.error(
      `❌ [TelegramService] Could not resolve channel: ${channelId}`,
    );
    console.error(
      `📋 [TelegramService] Available channels/groups in this account: [${availableChannels || "None"}]`,
    );

    throw new Error(
      `Could not resolve Telegram Channel entity for: ${channelId}.\n` +
        `Available channels in connected Telegram account: [${availableChannels || "None"}].\n` +
        `Please ensure that:\n` +
        `1. The account in STRING_SESSION has joined or created the channel.\n` +
        `2. You have sent at least ONE message (e.g. "init") in the channel so Telegram includes it in dialogs.\n` +
        `3. The channel ID in .env matches one of the IDs listed above.`,
    );
  }

  async uploadFileToStorage(
    filePath,
    filename,
    caption = "",
    progressCallback = null,
  ) {
    const client = await this.getClient();
    const storageChannel = await this.getEntity(config.STORAGE_CHANNEL_ID);

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    const workers =
      fileSize > 50 * 1024 * 1024 ? 6 : fileSize > 5 * 1024 * 1024 ? 4 : 2;

    let sentMessage = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        sentMessage = await client.sendFile(storageChannel, {
          file: filePath,
          caption: caption || `TeleDrive: ${filename}`,
          forceDocument: true,
          workers,
          progressCallback: (progress) => {
            if (typeof progressCallback === "function") {
              progressCallback(progress);
            }
          },
        });
        if (sentMessage) break;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[TelegramService] Upload attempt ${attempt} for "${filename}" failed:`,
          err.message,
        );

        const waitMatch =
          err.message &&
          err.message.match(/FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i);
        const waitSecs = waitMatch
          ? parseInt(waitMatch[1] || waitMatch[2], 10)
          : attempt * 2;

        if (attempt < 3) {
          await new Promise((r) =>
            setTimeout(r, Math.min(waitSecs * 1000, 30000)),
          );
        }
      }
    }

    if (!sentMessage) {
      throw (
        lastErr || new Error(`Failed to upload ${filename} to Telegram storage`)
      );
    }

    const doc = sentMessage.media?.document;
    return {
      message_id: sentMessage.id,
      file_id: doc ? String(doc.id) : String(sentMessage.id),
      file_size: doc ? Number(doc.size) : fileSize,
      date: sentMessage.date,
    };
  }

  async uploadDocumentBuffer(channelId, buffer, filename, caption = "") {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    const safeName = Helpers.sanitizeFilename(
      filename || "master_manifest.json",
    );
    const tempFilePath = path.join(
      config.TEMP_CHUNK_DIR,
      `temp_doc_${Date.now()}_${safeName}`,
    );
    fs.writeFileSync(tempFilePath, buffer);

    try {
      const sentMessage = await client.sendFile(channel, {
        file: tempFilePath,
        caption: caption || filename,
        forceDocument: true,
        workers: 2,
      });

      const doc = sentMessage.media?.document;
      return {
        message_id: sentMessage.id,
        file_id: doc ? String(doc.id) : String(sentMessage.id),
        document: doc,
      };
    } finally {
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch (e) {}
    }
  }

  async downloadDocumentBuffer(channelId, messageId) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    const messages = await client.getMessages(channel, { ids: [messageId] });
    if (!messages || messages.length === 0 || !messages[0].media) {
      throw new Error(`Message ${messageId} or document media not found.`);
    }

    const buffer = await client.downloadMedia(messages[0], {
      workers: 4,
    });

    return buffer ? buffer.toString("utf8") : null;
  }

  async streamMediaToResponse(channelId, messageId, res) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    const messages = await client.getMessages(channel, { ids: [messageId] });
    if (!messages || messages.length === 0 || !messages[0].media) {
      throw new Error(`Message ${messageId} not found in channel.`);
    }

    const message = messages[0];
    if (!message || !message.media) {
      throw new Error(`Message ${messageId} does not contain media.`);
    }

    const doc = message.media.document;
    const dcId = doc?.dcId || message.media.dcId;

    const chunkSize = 1024 * 1024;
    for await (const chunk of client.iterDownload({
      file: message.media,
      requestSize: chunkSize,
      dcId: dcId,
      workers: 8,
    })) {
      if (res.writableEnded || res.destroyed) {
        break;
      }
      const canWriteMore = res.write(chunk);
      if (!canWriteMore) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
  }

  async sendTextMessage(channelId, text) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    let sent = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        sent = await client.sendMessage(channel, { message: text });
        if (sent) break;
      } catch (err) {
        lastErr = err;
        console.warn(`[TelegramService] sendTextMessage attempt ${attempt} failed:`, err.message);
        const waitMatch = err.message && err.message.match(/FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i);
        const waitSecs = waitMatch ? parseInt(waitMatch[1] || waitMatch[2], 10) : (attempt * 2);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, Math.min(waitSecs * 1000, 30000)));
        }
      }
    }
    if (!sent) {
      throw lastErr || new Error("Failed to send text message to Telegram channel");
    }
    return {
      message_id: sent.id,
      date: sent.date,
    };
  }

  async editMessage(channelId, messageId, newText) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    await client.editMessage(channel, {
      message: messageId,
      text: newText,
    });
    return true;
  }

  async getMessages(channelId, options = {}) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    return await client.getMessages(channel, options);
  }

  async getPinnedMessage(channelId) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    let pinnedMsgId = null;

    try {
      const full = await client.invoke(
        new Api.channels.GetFullChannel({
          channel: channel,
        }),
      );
      if (full && full.fullChat && full.fullChat.pinnedMsgId) {
        pinnedMsgId = full.fullChat.pinnedMsgId;
      }
    } catch (e) {

      try {
        const fullChat = await client.invoke(
          new Api.messages.GetFullChat({
            chatId: channel.id || channel,
          }),
        );
        if (fullChat && fullChat.fullChat && fullChat.fullChat.pinnedMsgId) {
          pinnedMsgId = fullChat.fullChat.pinnedMsgId;
        }
      } catch (e2) {}
    }

    if (pinnedMsgId) {
      try {
        const messages = await client.getMessages(channel, {
          ids: [pinnedMsgId],
        });
        if (messages && messages.length > 0 && messages[0]) {
          return messages[0];
        }
      } catch (e) {}
    }

    try {
      const messages = await client.getMessages(channel, {
        filter: new Api.InputMessagesFilterPinned(),
        limit: 1,
      });
      if (messages && messages.length > 0 && messages[0]) {
        return messages[0];
      }
    } catch (e) {}

    return null;
  }

  async pinMessage(channelId, messageId) {
    if (!messageId) return null;
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    const msgId = parseInt(messageId, 10);
    if (isNaN(msgId) || msgId <= 0) return null;

    try {
      if (typeof client.pinMessage === "function") {
        const res = await client.pinMessage(channel, msgId, { silent: true });
        if (res) return res;
      }
    } catch (err) {
      console.warn("[TelegramService] client.pinMessage notice:", err.message);
    }

    const PinClass =
      Api.messages.updatePinnedMessage || Api.messages.UpdatePinnedMessage;
    if (PinClass) {
      try {
        return await client.invoke(
          new PinClass({
            peer: channel,
            id: msgId,
            silent: true,
            unpin: false,
          }),
        );
      } catch (err) {
        console.warn(
          "Notice: Could not pin message (check channel admin permissions):",
          err.message,
        );
        return null;
      }
    }
    return null;
  }

  async unpinMessage(channelId, messageId) {
    if (!messageId) return null;
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    const msgId = parseInt(messageId, 10);
    if (isNaN(msgId) || msgId <= 0) return null;

    try {
      if (typeof client.unpinMessage === "function") {
        return await client.unpinMessage(channel, msgId);
      }
    } catch (e) {}

    const PinClass =
      Api.messages.updatePinnedMessage || Api.messages.UpdatePinnedMessage;
    if (PinClass) {
      try {
        return await client.invoke(
          new PinClass({
            peer: channel,
            id: msgId,
            unpin: true,
          }),
        );
      } catch (err) {
        console.warn("Notice: Could not unpin message:", err.message);
        return null;
      }
    }
    return null;
  }

  async deleteMessages(channelId, messageIds) {
    if (!messageIds || messageIds.length === 0) return true;
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    const uniqueIds = Array.from(
      new Set(
        messageIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id)),
      ),
    );
    if (uniqueIds.length === 0) return true;

    const batchSize = 100;
    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const batch = uniqueIds.slice(i, i + batchSize);
      try {
        await client.deleteMessages(channel, batch, { revoke: true });
      } catch (err) {
        console.error(`Error deleting message batch:`, err.message);
      }
    }
    return true;
  }
}

module.exports = new TelegramService();

/**
 * TeleDrive Telegram MTProto Engine (GramJS)
 *
 * Provides high-speed MTProto User API interactions without Bot API limits:
 * - 2GB native single-file uploads with multi-threaded chunking
 * - Multipart handling for >2GB files
 * - Zero-disk streaming downloads piped directly to HTTP response
 * - Index channel metadata messages, pinning, unpinning, and batch purges
 */

const { TelegramClient, Api } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { CustomFile } = require("teleproto/client/uploads");
const bigInt = require("big-integer");
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

  /**
   * Get or initialize connected GramJS TelegramClient
   */
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
          floodSleepThreshold: 120, // Auto-sleep up to 120s on Telegram FLOOD_WAIT
          downloadPool: {
            maxSessions: 16,
            sessions: 8,
            inflightPerDc: 16,
            partSize: 512 * 1024,
            download: {
              startSessions: 8,
              maxSessions: 16,
              startWindow: 8 * 1024 * 1024,
              maxWindow: 16 * 1024 * 1024,
            },
            upload: {
              startSessions: 8,
              maxSessions: 16,
              startWindow: 8 * 1024 * 1024,
              maxWindow: 16 * 1024 * 1024,
            },
          },
        },
      );

      await this.client.connect();
      this.isConnected = true;
      this.connectingPromise = null;

      // Preload dialogs to warm GramJS entity cache
      try {
        await this.client.getDialogs({ limit: 100 });
      } catch (e) {
        // Ignore dialog fetch warnings
      }

      return this.client;
    })();

    return this.connectingPromise;
  }

  /**
   * Resolve channel ID / username to Telegram InputChannel entity
   */
  async getEntity(channelId) {
    if (!channelId) throw new Error("Channel ID is required");
    const cacheKey = String(channelId);
    if (this.resolvedEntities.has(cacheKey)) {
      return this.resolvedEntities.get(cacheKey);
    }

    const client = await this.getClient();
    const strId = String(channelId).trim();
    const stripped = strId.replace(/^-100/, "").replace(/^-/, "");

    // 1. Search in dialogs FIRST (Contains the true access_hash needed by Telegram MTProto)
    let dialogs = [];
    try {
      const mainDialogs = await client.getDialogs({ limit: 500 });
      dialogs.push(...mainDialogs);
    } catch (e) {
      console.warn("Main dialog search warning:", e.message);
    }

    try {
      // Also search archived dialogs if the channel was archived
      const archivedDialogs = await client.getDialogs({
        limit: 500,
        folder: 1,
      });
      dialogs.push(...archivedDialogs);
    } catch (e) {
      // Folder 1 may not exist if no archived chats
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

    // 2. If channelId is a public username (e.g. @my_channel)
    if (!/^-?\d+$/.test(strId)) {
      try {
        const entity = await client.getInputEntity(strId);
        if (entity && entity.className !== "InputPeerChat") {
          this.resolvedEntities.set(cacheKey, entity);
          return entity;
        }
      } catch (e) {}
    }

    // 3. Direct getInputEntity on client (only accept if not InputPeerChat)
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

    // 4. Direct getEntity on client
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

  /**
   * Upload a file or buffer to the Storage Channel
   */
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

    // Use 4 workers max for large files to avoid socket congestion and uncommitted part limit throttles on Telegram MTProto
    const workers =
      fileSize > 50 * 1024 * 1024 ? 4 : fileSize > 5 * 1024 * 1024 ? 3 : 2;

    let sentMessage = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        sentMessage = await client.sendFile(storageChannel, {
          file: filePath,
          fileSize: fileSize,
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

        // Auto-sleep if Telegram enforces FLOOD_WAIT
        const waitMatch =
          err.message &&
          err.message.match(/FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i);
        const waitSecs = waitMatch
          ? parseInt(waitMatch[1] || waitMatch[2], 10)
          : attempt * 3;

        if (attempt < 3) {
          const delay = Math.min(Math.max(waitSecs, attempt * 3) * 1000, 30000);
          console.warn(`[TelegramService] Retrying upload in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
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

  /**
   * Upload in-memory buffer as document to Index Channel (for master_manifest.json)
   */
  async uploadDocumentBuffer(channelId, buffer, filename, caption = "") {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    // Write buffer to a temp file so GramJS sendFile natively handles it without MEDIA_INVALID
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

  /**
   * Download document content into memory buffer (e.g. For master_manifest.json)
   */
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

  /**
   * High-speed parallel multi-worker streaming of Telegram document directly to HTTP response
   */
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

    const doc = message.media?.document || message.media;
    const dcId = doc?.dcId || message.media?.dcId;
    const rawSize = doc?.size || message.media?.size || 0;
    const fileSizeBigInt = bigInt(rawSize ? rawSize.toString() : "0");

    let inputLocation;
    if (doc?.id && doc?.accessHash && doc?.fileReference) {
      inputLocation = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: "",
      });
    } else {
      inputLocation = message.media || message;
    }

    // Backpressure-aware Writable adapter piping MTProto stream directly to Express res
    const writableAdapter = {
      write(chunk) {
        if (res.writableEnded || res.destroyed) {
          return false;
        }
        const canWrite = res.write(chunk);
        if (!canWrite && !res.writableEnded && !res.destroyed) {
          return new Promise((resolve) => res.once("drain", resolve));
        }
        return true;
      },
      close() {
        // Stream completed
      },
    };

    const abortController = new AbortController();
    const onDisconnect = () => abortController.abort();
    res.on("close", onDisconnect);

    try {
      // Use parallel multi-worker streaming (streamParallel) with 512KB MTProto parts
      await client.downloadFile(inputLocation, {
        outputFile: writableAdapter,
        partSizeKb: 512,
        fileSize: fileSizeBigInt,
        dcId: dcId,
        signal: abortController.signal,
      });
    } catch (err) {
      if (res.writableEnded || res.destroyed || abortController.signal.aborted) {
        return;
      }
      console.warn(
        `[TelegramService] Parallel streaming fallback for message ${messageId}:`,
        err.message,
      );
      // Fallback to iterDownload if downloadFile is interrupted
      for await (const chunk of client.iterDownload(inputLocation, {
        requestSize: 512 * 1024,
        dcId: dcId,
      })) {
        if (res.writableEnded || res.destroyed) break;
        const canWrite = res.write(chunk);
        if (!canWrite) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    } finally {
      res.removeListener("close", onDisconnect);
    }
  }

  /**
   * Parallel chunk downloader using Api.upload.GetFile with 512KB MTProto parts
   * Runs 4 parallel worker promises to fetch parts simultaneously and stream to HTTP response.
   */
  async downloadMediaPartParallel(client, inputLocation, rangeStart, rangeEnd, chunkSize, res) {
    const PART_SIZE = 512 * 1024; // 512 KB optimal MTProto part size
    const firstPartIndex = Math.floor(rangeStart / PART_SIZE);
    const lastPartIndex = Math.floor((rangeEnd > rangeStart ? rangeEnd : rangeStart) / PART_SIZE);

    const partIndices = [];
    for (let p = firstPartIndex; p <= lastPartIndex; p++) {
      partIndices.push(p);
    }

    const CONCURRENCY = 4; // 4 parallel worker promises
    const partsMap = new Map();
    let nextPartToWrite = firstPartIndex;
    let hasError = null;

    const flushParts = async () => {
      while (partsMap.has(nextPartToWrite)) {
        if (res.writableEnded || res.destroyed) break;
        const partIdx = nextPartToWrite;
        const bytes = partsMap.get(partIdx);
        partsMap.delete(partIdx);

        if (bytes && bytes.length > 0) {
          const partOffset = partIdx * PART_SIZE;
          const sliceStart = Math.max(0, rangeStart - partOffset);
          const sliceEnd = Math.min(bytes.length, (rangeEnd - partOffset) + 1);

          if (sliceStart < sliceEnd) {
            const slice = bytes.subarray(sliceStart, sliceEnd);
            const canWrite = res.write(slice);
            if (!canWrite && !res.writableEnded && !res.destroyed) {
              await new Promise((resolve) => res.once("drain", resolve));
            }
          }
        }
        nextPartToWrite++;
      }
    };

    let queueIdx = 0;
    const worker = async () => {
      while (queueIdx < partIndices.length && !hasError) {
        if (res.writableEnded || res.destroyed) break;
        const partIdx = partIndices[queueIdx++];
        const offset = partIdx * PART_SIZE;

        try {
          let bytes = null;
          let retries = 3;
          while (retries > 0 && !bytes && !res.writableEnded && !res.destroyed) {
            try {
              const fileResult = await client.invoke(
                new Api.upload.GetFile({
                  location: inputLocation,
                  offset: bigInt(offset),
                  limit: PART_SIZE,
                  precise: true,
                })
              );
              if (fileResult && fileResult.bytes) {
                bytes = fileResult.bytes;
              }
            } catch (err) {
              retries--;
              if (retries === 0) throw err;
              await new Promise((r) => setTimeout(r, 200));
            }
          }

          partsMap.set(partIdx, bytes || Buffer.alloc(0));
          await flushParts();
        } catch (err) {
          hasError = err;
          console.warn(`[TelegramService] Api.upload.GetFile worker warning for part ${partIdx}:`, err.message);
          try {
            const fallbackBuf = await client.downloadFile(inputLocation, {
              offset: bigInt(offset),
              limit: PART_SIZE,
              partSizeKb: 512,
            });
            partsMap.set(partIdx, fallbackBuf || Buffer.alloc(0));
            await flushParts();
            hasError = null;
          } catch (fallbackErr) {
            console.error(`[TelegramService] Fallback failed for part ${partIdx}:`, fallbackErr.message);
          }
        }
      }
    };

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, partIndices.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    await flushParts();
  }

  /**
   * High-speed seamless streaming of multiple chunk messages directly to HTTP response
   * Supports full downloads or range-bounded chunk streaming.
   */
  async streamChunksToResponse(channelId, chunksToStream, res) {
    if (!chunksToStream || chunksToStream.length === 0) return;
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    // Normalize input array into objects with range properties
    const normalizedChunks = chunksToStream.map((item) => {
      if (typeof item === "object" && item !== null && item.message_id) {
        return {
          message_id: Number(item.message_id),
          start: typeof item.start === "number" ? item.start : 0,
          end: typeof item.end === "number" ? item.end : (item.size ? item.size - 1 : Infinity),
          size: item.size || 0,
        };
      }
      const id = Number(item);
      return { message_id: id, start: 0, end: Infinity, size: 0 };
    }).filter((c) => !isNaN(c.message_id));

    const uniqueIds = Array.from(new Set(normalizedChunks.map((c) => c.message_id)));
    const msgMap = new Map();

    // Fetch message entities in safe batches of 15 to avoid RPC timeouts
    const BATCH_SIZE = 15;
    for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
      if (res.writableEnded || res.destroyed) return;
      const batchIds = uniqueIds.slice(i, i + BATCH_SIZE);
      try {
        const batchMsgs = await client.getMessages(channel, { ids: batchIds });
        if (batchMsgs && Array.isArray(batchMsgs)) {
          for (const msg of batchMsgs) {
            if (msg && msg.id) {
              msgMap.set(Number(msg.id), msg);
            }
          }
        }
      } catch (err) {
        console.warn(`[TelegramService] Batch getMessages warning for IDs ${batchIds}:`, err.message);
      }
    }

    const abortController = new AbortController();
    const onDisconnect = () => abortController.abort();
    res.on("close", onDisconnect);

    try {
      for (const chunkItem of normalizedChunks) {
        if (res.writableEnded || res.destroyed || abortController.signal.aborted) {
          break;
        }

        let message = msgMap.get(chunkItem.message_id);
        if (!message) {
          try {
            const single = await client.getMessages(channel, { ids: [chunkItem.message_id] });
            if (single && single[0]) message = single[0];
          } catch (e) {}
        }
        if (!message || !message.media) continue;

        const doc = message.media?.document || message.media;
        const rawSize = doc?.size || message.media?.size || chunkItem.size || 0;
        const actualChunkSize = rawSize ? Number(rawSize) : chunkItem.size;
        const rangeStart = Math.max(0, chunkItem.start);
        const rangeEnd = Math.min(actualChunkSize > 0 ? actualChunkSize - 1 : chunkItem.end, chunkItem.end);

        let inputLocation;
        if (doc?.id && doc?.accessHash && doc?.fileReference) {
          inputLocation = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: "",
          });
        } else {
          inputLocation = message.media || message;
        }

        await this.downloadMediaPartParallel(
          client,
          inputLocation,
          rangeStart,
          rangeEnd,
          actualChunkSize,
          res
        );
      }
    } finally {
      res.removeListener("close", onDisconnect);
    }
  }

  /**
   * Send a JSON metadata text message to Index Channel
   */
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

  /**
   * Edit an existing message in Index Channel
   */
  async editMessage(channelId, messageId, newText) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    await client.editMessage(channel, {
      message: messageId,
      text: newText,
    });
    return true;
  }

  /**
   * Fetch messages in a range or by IDs
   */
  async getMessages(channelId, options = {}) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    return await client.getMessages(channel, options);
  }

  /**
   * Get current pinned message in channel
   */
  async getPinnedMessage(channelId) {
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);

    let pinnedMsgId = null;

    // 1. Try channels.GetFullChannel for broadcast channels & supergroups
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
      // 2. Try messages.GetFullChat for normal groups/chats
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

    // 3. Fallback to InputMessagesFilterPinned
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

  /**
   * Pin a message in channel
   */
  async pinMessage(channelId, messageId) {
    if (!messageId) return null;
    const client = await this.getClient();
    const channel = await this.getEntity(channelId);
    const msgId = parseInt(messageId, 10);
    if (isNaN(msgId) || msgId <= 0) return null;

    // 1. Try high-level client.pinMessage if available
    try {
      if (typeof client.pinMessage === "function") {
        const res = await client.pinMessage(channel, msgId, { silent: true });
        if (res) return res;
      }
    } catch (err) {
      console.warn("[TelegramService] client.pinMessage notice:", err.message);
    }

    // 2. Fallback to raw MTProto updatePinnedMessage invoke (supports both GramJS casing conventions)
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

  /**
   * Unpin a message in channel
   */
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

  /**
   * Delete messages in batches
   */
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

    // Telegram allows up to 100 IDs per delete call
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

// Singleton instance
module.exports = new TelegramService();

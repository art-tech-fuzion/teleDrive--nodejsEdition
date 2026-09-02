/**
 * TeleDrive Telegram MTProto Engine (GramJS)
 * 
 * Provides high-speed MTProto User API interactions without Bot API limits:
 * - 2GB native single-file uploads with multi-threaded chunking
 * - Multipart handling for >2GB files
 * - Zero-disk streaming downloads piped directly to HTTP response
 * - Index channel metadata messages, pinning, unpinning, and batch purges
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const fs = require('fs');
const path = require('path');
const config = require('../config');

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
                throw new Error('Telegram MTProto credentials not configured. Please check your .env file.');
            }

            const stringSession = new StringSession(config.STRING_SESSION || '');
            this.client = new TelegramClient(stringSession, config.API_ID, config.API_HASH, {
                connectionRetries: 5,
                useWSS: false,
                autoReconnect: true,
                timeout: 30000,
            });

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
        if (!channelId) throw new Error('Channel ID is required');
        const cacheKey = String(channelId);
        if (this.resolvedEntities.has(cacheKey)) {
            return this.resolvedEntities.get(cacheKey);
        }

        const client = await this.getClient();
        let entity = null;

        // Try direct getEntity / getInputEntity
        try {
            entity = await client.getInputEntity(channelId);
            if (entity) {
                this.resolvedEntities.set(cacheKey, entity);
                return entity;
            }
        } catch (e) {}

        try {
            entity = await client.getEntity(channelId);
            if (entity) {
                this.resolvedEntities.set(cacheKey, entity);
                return entity;
            }
        } catch (e) {}

        // Try numeric conversion (including BigInt & stripped -100 prefix)
        const strId = String(channelId).trim();
        const attempts = [];
        if (/^-?\d+$/.test(strId)) {
            attempts.push(parseInt(strId, 10));
            try { attempts.push(BigInt(strId)); } catch (e) {}
            if (strId.startsWith('-100')) {
                const stripped = strId.substring(4);
                attempts.push(parseInt(stripped, 10));
                attempts.push(parseInt('-' + stripped, 10));
                try { attempts.push(BigInt(stripped)); } catch (e) {}
            }
        }

        for (const target of attempts) {
            try {
                entity = await client.getInputEntity(target);
                if (entity) {
                    this.resolvedEntities.set(cacheKey, entity);
                    return entity;
                }
            } catch (e) {}
            try {
                entity = await client.getEntity(target);
                if (entity) {
                    this.resolvedEntities.set(cacheKey, entity);
                    return entity;
                }
            } catch (e) {}
        }

        // Final attempt: search in dialogs
        try {
            const dialogs = await client.getDialogs({ limit: 200 });
            for (const d of dialogs) {
                const dId = String(d.id);
                if (dId === strId || dId === strId.replace(/^-100/, '') || ('-100' + dId) === strId) {
                    entity = d.inputEntity || d.entity;
                    if (entity) {
                        this.resolvedEntities.set(cacheKey, entity);
                        return entity;
                    }
                }
            }
        } catch (e) {}

        throw new Error(`Could not resolve Telegram Channel entity for: ${channelId}. Make sure the channel ID is correct and your account is an administrator or member of the channel.`);
    }

    /**
     * Upload a file or buffer to the Storage Channel
     */
    async uploadFileToStorage(filePath, filename, caption = '', progressCallback = null) {
        const client = await this.getClient();
        const storageChannel = await this.getEntity(config.STORAGE_CHANNEL_ID);

        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        const sentMessage = await client.sendFile(storageChannel, {
            file: filePath,
            caption: caption || `TeleDrive: ${filename}`,
            forceDocument: true,
            workers: 4,
            progressCallback: (progress) => {
                if (typeof progressCallback === 'function') {
                    progressCallback(progress);
                }
            }
        });

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
    async uploadDocumentBuffer(channelId, buffer, filename, caption = '') {
        const client = await this.getClient();
        const channel = await this.getEntity(channelId);

        const customFile = new CustomFile(filename, buffer.length, '', buffer);
        const sentMessage = await client.sendFile(channel, {
            file: customFile,
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
            workers: 2,
        });

        return buffer ? buffer.toString('utf8') : null;
    }

    /**
     * Stream single message media directly to HTTP response stream without writing to disk
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

        const doc = message.media.document;
        const dcId = doc?.dcId || message.media.dcId;

        // Use iterDownload for efficient chunk-by-chunk MTProto streaming
        const chunkSize = 512 * 1024; // 512KB per MTProto chunk
        for await (const chunk of client.iterDownload({
            file: message.media,
            requestSize: chunkSize,
            dcId: dcId,
        })) {
            if (res.writableEnded || res.destroyed) {
                break;
            }
            const canWriteMore = res.write(chunk);
            if (!canWriteMore) {
                await new Promise((resolve) => res.once('drain', resolve));
            }
        }
    }

    /**
     * Send a JSON metadata text message to Index Channel
     */
    async sendTextMessage(channelId, text) {
        const client = await this.getClient();
        const channel = await this.getEntity(channelId);
        const sent = await client.sendMessage(channel, { message: text });
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
     * Get pinned message in channel
     */
    async getPinnedMessage(channelId) {
        const client = await this.getClient();
        const channel = await this.getEntity(channelId);
        const messages = await client.getMessages(channel, {
            filter: new Api.InputMessagesFilterPinned(),
            limit: 1,
        });
        if (messages && messages.length > 0) {
            return messages[0];
        }
        return null;
    }

    /**
     * Pin a message in channel
     */
    async pinMessage(channelId, messageId) {
        const client = await this.getClient();
        const channel = await this.getEntity(channelId);
        return await client.pinMessage(channel, messageId, { notify: false });
    }

    /**
     * Unpin a message in channel
     */
    async unpinMessage(channelId, messageId) {
        const client = await this.getClient();
        const channel = await this.getEntity(channelId);
        return await client.unpinMessage(channel, messageId);
    }

    /**
     * Delete messages in batches
     */
    async deleteMessages(channelId, messageIds) {
        if (!messageIds || messageIds.length === 0) return true;
        const client = await this.getClient();
        const channel = await this.getEntity(channelId);

        const uniqueIds = Array.from(new Set(messageIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))));
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

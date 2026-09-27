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
        const strId = String(channelId).trim();
        const stripped = strId.replace(/^-100/, '').replace(/^-/, '');

        // 1. Search in dialogs FIRST (Contains the true access_hash needed by Telegram MTProto)
        let dialogs = [];
        try {
            const mainDialogs = await client.getDialogs({ limit: 500 });
            dialogs.push(...mainDialogs);
        } catch (e) {
            console.warn('Main dialog search warning:', e.message);
        }

        try {
            // Also search archived dialogs if the channel was archived
            const archivedDialogs = await client.getDialogs({ limit: 500, folder: 1 });
            dialogs.push(...archivedDialogs);
        } catch (e) {
            // Folder 1 may not exist if no archived chats
        }

        for (const d of dialogs) {
            const dId = d.id ? d.id.toString().trim() : '';
            const dStripped = dId.replace(/^-100/, '').replace(/^-/, '');
            const entityId = d.entity?.id ? d.entity.id.toString().trim() : '';
            const entityStripped = entityId.replace(/^-100/, '').replace(/^-/, '');

            const isMatch = (
                dId === strId ||
                dStripped === stripped ||
                entityId === strId ||
                entityStripped === stripped ||
                (d.name && d.name.trim().toLowerCase() === strId.toLowerCase())
            );

            if (isMatch) {
                const input = d.inputEntity || (d.entity ? await client.getInputEntity(d.entity) : null);
                if (input && input.className !== 'InputPeerChat') {
                    this.resolvedEntities.set(cacheKey, input);
                    return input;
                }
            }
        }

        // 2. If channelId is a public username (e.g. @my_channel)
        if (!/^-?\d+$/.test(strId)) {
            try {
                const entity = await client.getInputEntity(strId);
                if (entity && entity.className !== 'InputPeerChat') {
                    this.resolvedEntities.set(cacheKey, entity);
                    return entity;
                }
            } catch (e) {}
        }

        // 3. Direct getInputEntity on client (only accept if not InputPeerChat)
        try {
            const entity = await client.getInputEntity(channelId);
            if (entity && !(strId.startsWith('-100') && entity.className === 'InputPeerChat')) {
                this.resolvedEntities.set(cacheKey, entity);
                return entity;
            }
        } catch (e) {}

        // 4. Direct getEntity on client
        try {
            const entity = await client.getEntity(channelId);
            if (entity) {
                const input = await client.getInputEntity(entity);
                if (input && !(strId.startsWith('-100') && input.className === 'InputPeerChat')) {
                    this.resolvedEntities.set(cacheKey, input);
                    return input;
                }
            }
        } catch (e) {}

        const availableChannels = (dialogs || [])
            .filter((d) => d.isChannel || d.isGroup)
            .map((d) => `"${d.title || d.name}" (ID: ${d.id ? d.id.toString() : 'unknown'})`)
            .join(', ');

        console.error(`❌ [TelegramService] Could not resolve channel: ${channelId}`);
        console.error(`📋 [TelegramService] Available channels/groups in this account: [${availableChannels || 'None'}]`);

        throw new Error(
            `Could not resolve Telegram Channel entity for: ${channelId}.\n` +
            `Available channels in connected Telegram account: [${availableChannels || 'None'}].\n` +
            `Please ensure that:\n` +
            `1. The account in STRING_SESSION has joined or created the channel.\n` +
            `2. You have sent at least ONE message (e.g. "init") in the channel so Telegram includes it in dialogs.\n` +
            `3. The channel ID in .env matches one of the IDs listed above.`
        );
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

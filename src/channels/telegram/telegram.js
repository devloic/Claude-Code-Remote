/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API with command support
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class TelegramChannel extends NotificationChannel {
    constructor(config = {}) {
        super('telegram', config);
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        
        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig() {
        if (!this.config.botToken) {
            this.logger.warn('Telegram Bot Token not found');
            return false;
        }
        if (!this.config.chatId && !this.config.groupId) {
            this.logger.warn('Telegram Chat ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    /**
     * Generate network options for axios requests
     * @returns {Object} Network options object
     */
    _getNetworkOptions() {
        const options = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    _generateToken() {
        // Generate short Token (uppercase letters + numbers, 8 digits)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }

    _getCurrentTmuxSession() {
        try {
            // Try to get current tmux session
            const tmuxSession = execSync('tmux display-message -p "#S"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            
            return tmuxSession || null;
        } catch (error) {
            // Not in a tmux session or tmux not available
            return null;
        }
    }

    async _getBotUsername() {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions()
            );
            
            if (response.data.ok && response.data.result.username) {
                this.botUsername = response.data.result.username;
                return this.botUsername;
            }
        } catch (error) {
            this.logger.error('Failed to get bot username:', error.message);
        }
        
        // Fallback to configured username or default
        return this.config.botUsername || 'claude_remote_bot';
    }

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('Telegram channel not properly configured');
        }

        // Generate session ID and Token
        const sessionId = uuidv4();
        const token = this._generateToken();
        
        // Get current tmux session and conversation content
        const tmuxSession = this._getCurrentTmuxSession();
        if (tmuxSession && !notification.metadata) {
            const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
            notification.metadata = {
                userQuestion: conversation.userQuestion || notification.message,
                claudeResponse: conversation.claudeResponse || notification.message,
                tmuxSession: tmuxSession
            };
        }
        
        // Create session record
        await this._createSession(sessionId, notification, token);

        // Generate Telegram message
        const messageText = this._generateTelegramMessage(notification, sessionId, token);
        
        // Determine recipient (chat or group)
        const chatId = this.config.groupId || this.config.chatId;
        const isGroupChat = !!this.config.groupId;
        
        // Create buttons using callback_data instead of inline query
        // This avoids the automatic @bot_name addition
        const buttons = [
            [
                {
                    text: '📝 Personal Chat',
                    callback_data: `personal:${token}`
                },
                {
                    text: '👥 Group Chat', 
                    callback_data: `group:${token}`
                }
            ]
        ];
        
        const requestData = {
            chat_id: chatId,
            text: messageText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        };

        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                requestData,
                this._getNetworkOptions()
            );

            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error) {
            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    _generateTelegramMessage(notification, sessionId, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        // Calculate fixed content size first
        let fixedContent = `${emoji} *Claude Task ${status}*\n`;
        fixedContent += `*Project:* ${notification.project}\n`;
        fixedContent += `*Session Token:* \`${token}\`\n\n`;
        fixedContent += `💬 *To send a new command:*\n`;
        fixedContent += `Reply with: \`/cmd ${token} <your command>\`\n`;
        fixedContent += `Example: \`/cmd ${token} Please analyze this code\``;

        // Telegram limit is 4096 characters - reserve some buffer for markdown formatting
        const maxTotalLength = 4000;
        const fixedContentLength = fixedContent.length;
        const availableSpace = maxTotalLength - fixedContentLength;

        let messageText = `${emoji} *Claude Task ${status}*\n`;
        messageText += `*Project:* ${notification.project}\n`;
        messageText += `*Session Token:* \`${token}\`\n\n`;

        if (notification.metadata && availableSpace > 100) {
            let remainingSpace = availableSpace;

            // Reserve space for section headers
            const userQuestionHeader = '📝 *Your Question:*\n';
            const claudeResponseHeader = '🤖 *Claude Response:*\n';
            const sectionSeparator = '\n\n';

            if (notification.metadata.userQuestion && remainingSpace > 50) {
                const headerLength = userQuestionHeader.length + sectionSeparator.length;
                const maxQuestionLength = Math.min(500, Math.floor(remainingSpace * 0.3) - headerLength);

                if (maxQuestionLength > 20) {
                    let questionText = notification.metadata.userQuestion;
                    if (questionText.length > maxQuestionLength) {
                        questionText = questionText.substring(0, maxQuestionLength - 3) + '...';
                    }

                    messageText += userQuestionHeader + questionText + sectionSeparator;
                    remainingSpace -= (headerLength + questionText.length);
                }
            }

            if (notification.metadata.claudeResponse && remainingSpace > 50) {
                const headerLength = claudeResponseHeader.length + sectionSeparator.length;
                const maxResponseLength = remainingSpace - headerLength - 10; // Small buffer

                if (maxResponseLength > 20) {
                    let responseText = notification.metadata.claudeResponse;
                    if (responseText.length > maxResponseLength) {
                        responseText = responseText.substring(0, maxResponseLength - 3) + '...';
                    }

                    messageText += claudeResponseHeader + responseText + sectionSeparator;
                }
            }
        }

        messageText += `💬 *To send a new command:*\n`;
        messageText += `Reply with: \`/cmd ${token} <your command>\`\n`;
        messageText += `Example: \`/cmd ${token} Please analyze this code\``;

        return messageText;
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'telegram',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Expires after 24 hours
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            tmuxSession: notification.metadata?.tmuxSession || 'default',
            project: notification.project,
            notification: notification
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        this.logger.debug(`Session created: ${sessionId}`);
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = TelegramChannel;

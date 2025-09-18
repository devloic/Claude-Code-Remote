/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');
const PersistentSessionManager = require('./persistent-session');

class TelegramWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('TelegramWebhook');
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.persistentSessions = new PersistentSessionManager(this.sessionsDir);
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username

        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware() {
        // Parse JSON for all requests
        this.app.use(express.json());
    }

    _setupRoutes() {
        // Telegram webhook endpoint
        this.app.post('/webhook/telegram', this._handleWebhook.bind(this));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'telegram-webhook' });
        });
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

    async _handleWebhook(req, res) {
        try {
            const update = req.body;
            
            // Handle different update types
            if (update.message) {
                await this._handleMessage(update.message);
            } else if (update.callback_query) {
                await this._handleCallbackQuery(update.callback_query);
            }
            
            res.status(200).send('OK');
        } catch (error) {
            this.logger.error('Webhook handling error:', error.message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleMessage(message) {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const messageText = message.text?.trim();
        
        if (!messageText) return;

        // Check if user is authorized
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

        // Handle /start command
        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }

        // Handle /help command
        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }

        // Check for reply mode (user replying to bot message)
        if (message.reply_to_message && message.reply_to_message.from && message.reply_to_message.from.is_bot) {
            // This is a reply to a bot message - check if we have an active session for this chat
            const currentSession = this.persistentSessions.getCurrentChatSession(chatId.toString());
            if (currentSession) {
                this.logger.info(`Reply mode command: ${messageText}`);
                await this._processCommand(chatId, currentSession.token, messageText);
                return;
            }
        }

        // Parse command - try different formats
        let token, command;

        // Format 1: /cmdTOKEN command (new format)
        const newFormatMatch = messageText.match(/^\/cmd([A-Z0-9]{8})\s+(.+)$/i);
        if (newFormatMatch) {
            token = newFormatMatch[1].toUpperCase();
            command = newFormatMatch[2];
        } else {
            // Format 2: /cmd TOKEN command (old format)
            const oldFormatMatch = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
            if (oldFormatMatch) {
                token = oldFormatMatch[1].toUpperCase();
                command = oldFormatMatch[2];
            } else {
                // Format 3: Direct TOKEN command (no /cmd prefix)
                const directMatch = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/);
                if (directMatch) {
                    token = directMatch[1].toUpperCase();
                    command = directMatch[2];
                } else {
                    await this._sendMessage(chatId,
                        '❌ Invalid format. Use:\n/cmdTOKEN command\n\nExample:\n/cmdABC12345 analyze this code');
                    return;
                }
            }
        }

        await this._processCommand(chatId, token, command);
    }

    async _processCommand(chatId, token, command) {
        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._sendMessage(chatId, 
                '❌ Invalid or expired token. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId, 
                '❌ Token has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);
            
            // Send confirmation
            await this._sendMessage(chatId, 
                `✅ *Command sent successfully*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                { parse_mode: 'Markdown' });
            
            // Log command execution
            this.logger.info(`Command injected - User: ${chatId}, Token: ${token}, Command: ${command}`);
            
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId, 
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;
        
        // Answer callback query to remove loading state
        await this._answerCallbackQuery(callbackQuery.id);
        
        if (data.startsWith('personal:')) {
            const token = data.split(':')[1];
            // Send personal chat command format
            await this._sendMessage(chatId,
                `📝 *Personal Chat Command Format:*\n\n\`/cmd ${token} <your command>\`\n\n*Example:*\n\`/cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('group:')) {
            const token = data.split(':')[1];
            // Send group chat command format with @bot_name
            const botUsername = await this._getBotUsername();
            await this._sendMessage(chatId,
                `👥 *Group Chat Command Format:*\n\n\`@${botUsername} /cmd ${token} <your command>\`\n\n*Example:*\n\`@${botUsername} /cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('copy:')) {
            const token = data.split(':')[1];
            // Send copyable command format
            await this._sendMessage(chatId,
                `📋 Copy this command format:\n\n/cmd${token} \n\nThen add your command and send!\n\nExample: /cmd${token} please analyze this code`);
        } else if (data.startsWith('format:')) {
            const token = data.split(':')[1];
            // Send command format message
            await this._sendMessage(chatId,
                `📝 Command Format:\n\n/cmd${token} [your command]\n\nExample:\n/cmd${token} please analyze this code\n\n💡 Copy and paste the format above, then add your command!`);
        } else if (data.startsWith('quickcmd:')) {
            // Handle quick command buttons: quickcmd:TOKEN:command
            const parts = data.split(':');
            const token = parts[1];
            const command = parts.slice(2).join(':'); // Rejoin in case command contains ':'

            this.logger.info(`Quick command button pressed: ${command}`);
            await this._processCommand(chatId, token, command);

        } else if (data.startsWith('session:')) {
            const token = data.split(':')[1];
            // For backward compatibility - send help message for old callback buttons
            await this._sendMessage(chatId,
                `📝 *How to send a command:*\n\nType:\n\`/cmd ${token} <your command>\`\n\nExample:\n\`/cmd ${token} please analyze this code\`\n\n💡 *Tip:* New notifications have a button that auto-fills the command for you!`,
                { parse_mode: 'Markdown' });
        }
    }

    async _sendWelcomeMessage(chatId) {
        const message = `🤖 Welcome to Claude Code Remote Bot!\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `When you receive a notification with a token, you can send commands back using:\n` +
            `/cmdTOKEN your command\n\n` +
            `Type /help for more information.`;

        await this._sendMessage(chatId, message);
    }

    async _sendHelpMessage(chatId) {
        const message = `📚 Claude Code Remote Bot Help\n\n` +
            `Commands:\n` +
            `• /start - Welcome message\n` +
            `• /help - Show this help\n` +
            `• /cmdTOKEN command - Send command to Claude\n\n` +
            `Example:\n` +
            `/cmdABC12345 analyze the performance of this function\n\n` +
            `Tips:\n` +
            `• Tokens are case-insensitive\n` +
            `• Tokens persist for 7 days\n` +
            `• You can also just type TOKEN command without /cmd`;

        await this._sendMessage(chatId, message);
    }

    _isAuthorized(userId, chatId) {
        // Check whitelist
        const whitelist = this.config.whitelist || [];
        
        if (whitelist.includes(String(chatId)) || whitelist.includes(String(userId))) {
            return true;
        }
        
        // If no whitelist configured, allow configured chat/user
        if (whitelist.length === 0) {
            const configuredChatId = this.config.chatId || this.config.groupId;
            if (configuredChatId && String(chatId) === String(configuredChatId)) {
                return true;
            }
        }
        
        return false;
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

    async _findSessionByToken(token) {
        // Use persistent session manager to find session by token
        const session = this.persistentSessions.getSessionByToken(token);
        if (session) {
            // Convert persistent session format to webhook-compatible format
            return {
                id: session.sessionId,
                token: session.token,
                tmuxSession: session.tmuxSession,
                project: session.project,
                expiresAt: session.expiresAt,
                chatId: session.chatId
            };
        }

        // Fallback to old session file method for backward compatibility
        const files = fs.readdirSync(this.sessionsDir);

        for (const file of files) {
            if (!file.endsWith('.json') || file === 'chat-sessions.json') continue;

            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error) {
                this.logger.error(`Failed to read session file ${file}:`, error.message);
            }
        }

        return null;
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    async _sendMessage(chatId, text, options = {}) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: text,
                    ...options
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
        }
    }

    async _answerCallbackQuery(callbackQueryId, text = '') {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/answerCallbackQuery`,
                {
                    callback_query_id: callbackQueryId,
                    text: text
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to answer callback query:', error.response?.data || error.message);
        }
    }

    async setWebhook(webhookUrl) {
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setWebhook`,
                {
                    url: webhookUrl,
                    allowed_updates: ['message', 'callback_query']
                },
                this._getNetworkOptions()
            );

            this.logger.info('Webhook set successfully:', response.data);
            return response.data;
        } catch (error) {
            this.logger.error('Failed to set webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            this.logger.info(`Telegram webhook server started on port ${port}`);
        });
    }
}

module.exports = TelegramWebhookHandler;

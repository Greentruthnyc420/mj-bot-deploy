import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { apiRateLimiter } from '../utils/api-rate-limiter.js';
import { keyRouter } from '../utils/key-router.js';
import { AgentLoop } from './agent-loop.js';
import { registerAllTools } from './tools.js';
import { TaskPlanner } from './planner.js';
import { Orchestrator } from '../agents/orchestrator.js';

/**
 * SmartBrain V3 - Dual-Brain Architecture
 *
 * Frontend (Gemini): fast classification, casual chat, voice pipeline
 * Backend (Claude CLI): heavy lifting, MCP tools, Google actions, complex reasoning
 *
 * Flow:
 * 1. Gemini classifies message -> CHAT or ACTION
 * 2. CHAT -> Gemini responds (fast, free)
 * 3. ACTION -> Claude CLI processes with pre-fetched data (powerful, $20 Pro)
 * 4. Fallback: if Claude fails/rate-limited -> Gemini handles everything
 */
export class SmartBrain {
    constructor(skills = {}) {
        this.skills = skills;
        this.geminiApiKey = config.geminiApiKey;
        this.openaiTimeout = config.claudeTimeout || 60000;
        this.openaiModel = config.openaiCodexModel || 'gpt-5.3-codex';
        this._openaiAccessToken = config.openaiCodexToken;
        this._openaiRefreshToken = config.openaiCodexRefresh;
        this._tokenExpiresAt = 0; // will auto-refresh on first call
        this.mcpBridge = null;
        this.agentLoop = null;
        this.toolRegistry = null;
        this.planner = null;
        this.orchestrator = null;

        this.classifierPrompt = `You are a task classifier. Given a user message, respond with ONLY one word:

CHAT - if it's casual conversation, greetings, simple questions, explanations, or general knowledge.
ACTION - if it needs: coding, file operations, searching Google Drive, reading Gmail, research, calculations, scheduling, or automation.

Examples:
"Hey how are you?" -> CHAT
"What was my last email?" -> ACTION
"Search my drive for invoices" -> ACTION
"Create a script that..." -> ACTION
"Tell me about React" -> CHAT
"Debug this code..." -> ACTION
"Send an email to..." -> ACTION
"What's on my calendar?" -> ACTION

Respond with only: CHAT or ACTION (No punctuation)`;

        this.geminiPrompt = `You are Mary Jane (MJ), Omar's helpful AI assistant.
Be friendly, concise, and helpful. You can chat naturally.`;

        this.claudeSystemPrompt = `You are Mary Jane (MJ), Omar's personal AI assistant.
You have been given real data from Omar's Gmail, Google Calendar, Google Drive, or web search results.
Analyze the data and answer Omar's question naturally and concisely.
Don't say "based on the data provided" - just answer as if you looked it up yourself.
If asked to send an email, draft it and confirm the details.
Be concise — avoid overly long responses. Get to the point.
Current date/time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
    }

    isReady() { return !!this.geminiApiKey; }

    setMCPBridge(bridge) {
        this.mcpBridge = bridge;
        logger.info('SmartBrain: MCP bridge connected');
    }

    async classifyMessage(message) {
        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash-preview:generateContent?key=${this.geminiApiKey}`,
                {
                    contents: [{ role: 'user', parts: [{ text: message }] }],
                    systemInstruction: { parts: [{ text: this.classifierPrompt }] },
                    generationConfig: { temperature: 0, maxOutputTokens: 10 }
                },
                { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
            );
            const result = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
            return result === 'ACTION' ? 'claude' : 'gemini';
        } catch (error) {
            logger.warn('Classification failed, defaulting to Gemini:', error.message);
            return 'gemini';
        }
    }

    initAgentLoop() {
        if (this.agentLoop) return;
        try {
            this.toolRegistry = registerAllTools(this.skills);
            this.agentLoop = new AgentLoop(this.toolRegistry);
            this.planner = new TaskPlanner(this.toolRegistry);
            this.orchestrator = new Orchestrator(this.toolRegistry);
            logger.info(`Agent system initialized: ${this.toolRegistry.size} tools, 4 sub-agents`);
        } catch (error) {
            logger.error('Failed to init agent loop:', error.message);
        }
    }

    _isMultiStepRequest(message) {
        const lower = message.toLowerCase();
        const compounds = [
            /\b(and then|then|after that|also|next|finally|first.*then)\b/,
            /\b(research|find|look up)\b.*\b(and|then)\b.*\b(send|email|create|write|draft|summarize)\b/,
            /\b(check|get|read)\b.*\b(and|then)\b.*\b(tell|send|update|create)\b/,
        ];
        return compounds.some(re => re.test(lower));
    }

    async think(message, context, skills) {
        this.skills = skills || this.skills;
        if (!this.agentLoop) this.initAgentLoop();
        this._memoryContext = skills?._memoryContext || '';
        this._learnedContext = skills?._learnedContext || '';

        if (message.startsWith('/claude ')) return await this.thinkWithClaude(message.slice(8), context);
        if (message.startsWith('/gemini ')) return await this.thinkWithGemini(message.slice(8), context);
        if (message.startsWith('/agent ')) {
            if (this.agentLoop) { logger.info('Smart route: /agent force -> agent loop'); return await this.agentLoop.run(message.slice(7), context); }
            return 'Agent loop not initialized.';
        }
        if (message.startsWith('/plan ')) {
            if (this.planner) { logger.info('Smart route: /plan force -> planner'); const result = await this.planner.planAndExecute(message.slice(6)); return result || 'Could not create a plan for that request.'; }
            return 'Planner not initialized.';
        }

        const lower = message.toLowerCase();

        // Image upscale intent
        if (lower.match(/upscale|enhance|make.*(it|this|that).*(bigger|larger|4k|hd|high.?res)|improve.*(quality|resolution)/i)) {
            const { geminiImage } = this.skills;
            if (geminiImage) {
                logger.info('Smart route: image upscale (Imagen 4 Upscale - $0.003)');
                const result = await geminiImage.upscale();
                if (result?.success && result?.imageBase64) return result;
                return result?.message || result || 'Upscale failed.';
            }
        }

        // Ultra image intent
        if (lower.match(/ultra|premium|high.?quality|best.?quality/i) && lower.match(/image|picture|photo|illustration|logo|icon|art|poster/i)) {
            const { geminiImage } = this.skills;
            if (geminiImage) {
                logger.info('Smart route: ultra image generation (Imagen 4 Ultra - $0.06)');
                const prompt = message.replace(/^(please\s+)?(generate|create|draw|make|design|paint)\s+(me\s+)?(an?\s+)?(ultra|premium|high.?quality|best.?quality)\s*(image|picture|photo|illustration|logo|icon|art|poster)\s*(of|about|for|with|depicting)?\s*/i, '').trim() || message;
                const result = await geminiImage.ultraGenerate(prompt);
                if (result?.success && result?.imageBase64) return result;
                return result?.message || result || 'Ultra image generation failed.';
            }
        }

        // Image generation intent (default: Nano Banana Pro - free)
        if (lower.match(/generate|create|draw|make|design|paint/i) && lower.match(/image|picture|photo|illustration|logo|icon|art|poster/i)) {
            const { geminiImage } = this.skills;
            if (geminiImage) {
                logger.info('Smart route: image generation (Nano Banana Pro - free)');
                const prompt = message.replace(/^(please\s+)?(generate|create|draw|make|design|paint)\s+(me\s+)?(an?\s+)?(image|picture|photo|illustration|logo|icon|art|poster)\s*(of|about|for|with|depicting)?\s*/i, '').trim() || message;
                const result = await geminiImage.generate(prompt);
                if (result?.success && result?.imageBase64) return result;
                return result?.message || result || 'Image generation failed.';
            }
        }

        // Video generation intent
        if (lower.match(/generate|create|make|produce/i) && lower.match(/video|clip|animation|movie|footage/i)) {
            const { geminiVideo } = this.skills;
            if (geminiVideo) {
                logger.info('Smart route: video generation (Veo 3.1)');
                const prompt = message.replace(/^(please\s+)?(generate|create|make|produce)\s+(me\s+)?(a\s+)?(4k\s+|hd\s+|portrait\s+|silent\s+|high.?quality\s+)*(video|clip|animation|movie|footage)\s*(of|about|for|with|depicting|showing)?\s*/i, '').trim() || message;
                const options = {};
                if (lower.match(/no\s*audio|silent|mute|without\s*sound|no\s*sound/i)) options.audio = false;
                if (lower.match(/4k|ultra.?hd|uhd/i)) options.resolution = '4k';
                else if (lower.match(/1080p|full.?hd/i)) options.resolution = '1080p';
                if (lower.match(/portrait|vertical|9.?16|tiktok|reel/i)) options.aspectRatio = '9:16';
                if (lower.match(/high.?quality|standard.?quality|best.?quality|premium/i)) options.quality = 'standard';
                const durMatch = lower.match(/(\d+)\s*sec/);
                if (durMatch) { const dur = parseInt(durMatch[1]); if ([4, 6, 8].includes(dur)) options.duration = dur; }
                const result = await geminiVideo.generateVideo(prompt, options);
                if (result?.success) return result;
                return result?.message || 'Video generation failed.';
            }
        }

        // Weather intent
        if (lower.match(/weather|temperature|forecast|rain|snow|humidity|feels like|degrees|hot|cold outside/)) {
            const { weather } = this.skills;
            if (weather) {
                logger.info('Smart route: weather');
                try {
                    const locMatch = message.match(/(?:in|for|at)\s+([A-Z][a-zA-Z\s]+)/);
                    const location = locMatch ? locMatch[1].trim() : 'New York';
                    if (lower.match(/forecast|week|tomorrow|next/)) return await weather.getForecast(location);
                    return await weather.get(location);
                } catch (error) { logger.error('Weather error:', error.message); return `Weather error: ${error.message}`; }
            }
        }

        // Send email intent
        if (lower.match(/send\s+(an?\s+)?email|compose\s+(an?\s+)?email|email\s+\w+@|write\s+to\s+\w+@|draft\s+(an?\s+)?email/)) {
            const { googleWorkspace } = this.skills;
            if (googleWorkspace?.isReady()) { logger.info('Smart route: send email'); return await this._handleSendEmail(message, context); }
        }

        // Reminder intent
        if (lower.match(/remind\s+me|set\s+a?\s*reminder|don'?t\s+let\s+me\s+forget/)) {
            const { scheduler } = this.skills;
            if (scheduler) return await this._handleReminder(message);
        }

        // WRITE intents -> Claude composes
        if (lower.match(/create\s+(a\s+)?(document|doc|google\s*doc|spreadsheet|sheet|presentation|slide)/)) {
            logger.info('Smart route: create document -> Claude (compose)');
            return await this._composeWithClaude(message, context, 'document');
        }
        if (lower.match(/draft\s+(a\s+)?(reply|response|email\s+body|message)|write\s+(a\s+)?(summary|report|brief|memo|proposal|document|plan)/)) {
            logger.info('Smart route: draft/write -> Claude (compose)');
            return await this._composeWithClaude(message, context, 'draft');
        }
        if (lower.match(/summarize|take\s+notes|document\s+(this|that|the)|put\s+(this|that|it)\s+(in|into|on)\s+(a\s+)?(doc|document|sheet|spreadsheet|drive)/)) {
            logger.info('Smart route: summarize/document -> Claude (compose)');
            return await this._composeWithClaude(message, context, 'summarize');
        }

        // Google data READ intents -> Gemini with pre-fetched data
        if (lower.match(/calendar|schedule|event|meeting|today|appointment|tomorrow|this week|agenda|busy|free|available/)) {
            const { googleWorkspace } = this.skills;
            if (googleWorkspace?.isReady()) { logger.info('Smart route: calendar -> Gemini (direct)'); return await this._analyzeGoogleData(message, context, 'calendar'); }
        }
        if (lower.match(/email|inbox|mail|gmail|message from|sent me|unread/)) {
            const { googleWorkspace } = this.skills;
            if (googleWorkspace?.isReady()) { logger.info('Smart route: email -> Gemini (direct)'); return await this._analyzeGoogleData(message, context, 'email'); }
        }
        if (lower.match(/drive|file|document|folder|find.*file|search.*drive|look.*drive/)) {
            const { googleWorkspace } = this.skills;
            if (googleWorkspace?.isReady()) { logger.info('Smart route: Drive -> Gemini (direct)'); return await this._analyzeGoogleData(message, context, 'drive'); }
        }
        if (lower.match(/search|look\s+up|find out|what is|who is|latest|news|how to|google|browse|research/)) {
            const { braveSearch } = this.skills;
            if (braveSearch) { logger.info('Smart route: web search -> Claude'); return await this.thinkWithClaude(message, context); }
        }

        // Multi-step requests -> Orchestrator
        if (this.orchestrator && this._isMultiStepRequest(message)) {
            logger.info('Smart route: multi-step -> orchestrator');
            const result = await this.orchestrator.route(message, { userPreferences: '' });
            if (result) return result;
            logger.info('Orchestrator returned null, falling back to agent loop');
            if (this.agentLoop) return await this.agentLoop.run(message, context);
        }

        // Smart classification (for everything else)
        const route = await this.classifyMessage(message);
        logger.info(`Smart route: ${route}`);
        if (route === 'claude') return await this.thinkWithClaude(message, context);
        else return await this.thinkWithGemini(message, context);
    }

    async _handleSendEmail(message, context) {
        try {
            const { googleWorkspace } = this.skills;
            const parseResponse = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash-preview:generateContent?key=${this.geminiApiKey}`,
                { contents: [{ role: 'user', parts: [{ text: `Parse this email request and return ONLY valid JSON with keys "to", "subject", "body". If any field is unclear, make a reasonable guess.\n\nRequest: "${message}"\n\nJSON:` }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } },
                { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            const rawText = parseResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return 'I couldn\'t understand the email details. Try: "Send an email to name@email.com about [subject] saying [message]"';
            const { to, subject, body } = JSON.parse(jsonMatch[0]);
            if (!to) return 'I need a recipient email address.';
            const result = await googleWorkspace.sendEmail(to, subject || '(no subject)', body || message);
            return `Email sent to **${to}**!\nSubject: ${subject}\n\n${typeof result === 'string' ? result : ''}`;
        } catch (error) { logger.error('Send email error:', error.message); return `Failed to send email: ${error.message}`; }
    }

    async _handleReminder(message) {
        try {
            const parseResponse = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash-preview:generateContent?key=${this.geminiApiKey}`,
                { contents: [{ role: 'user', parts: [{ text: `Parse this reminder request. Return ONLY valid JSON with keys "time" (e.g., "5m", "1h", "30min") and "message" (what to remind about).\n\nRequest: "${message}"\n\nJSON:` }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 512 } },
                { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            const rawText = parseResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const { time, message: reminderMsg } = JSON.parse(jsonMatch[0]);
                if (time && reminderMsg) {
                    const { scheduler } = this.skills;
                    if (scheduler?.bot) return await scheduler.addReminder(this.skills._userId || '', time, reminderMsg, scheduler.bot);
                }
            }
            return 'I couldn\'t parse the reminder. Try: "Remind me in 30 minutes to check the oven"';
        } catch (error) { logger.error('Reminder parse error:', error.message); return `Failed to set reminder: ${error.message}`; }
    }

    async _composeWithClaude(message, context, composeType) {
        try {
            const { googleWorkspace } = this.skills;
            let contextData = '';
            const lower = message.toLowerCase();
            if (googleWorkspace?.isReady()) {
                if (lower.match(/email|inbox|mail|thread|conversation|reply/)) { try { const emails = await googleWorkspace.getRecentEmails(5); contextData += `\n=== RECENT EMAILS (for context) ===\n${emails}\n`; } catch (e) { logger.warn('Context fetch (email) failed:', e.message); } }
                if (lower.match(/calendar|schedule|meeting|event|appointment/)) { try { const events = await googleWorkspace.getTodayEvents(); contextData += `\n=== TODAY'S CALENDAR ===\n${events}\n`; } catch (e) { logger.warn('Context fetch (calendar) failed:', e.message); } }
                if (lower.match(/file|document|drive|spreadsheet|sheet/)) { try { const files = await googleWorkspace.listRecentFiles(5); contextData += `\n=== RECENT DRIVE FILES ===\n${files}\n`; } catch (e) { logger.warn('Context fetch (drive) failed:', e.message); } }
            }
            const conversationContext = context.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            let claudePrompt = '';
            if (composeType === 'document') {
                claudePrompt = `You are Omar's personal assistant. He wants you to CREATE content for a document.\n\n${contextData ? `Here is real data from his Google account for reference:\n${contextData}\n` : ''}\n${conversationContext ? `Recent conversation:\n${conversationContext}\n` : ''}\nOmar's request: ${message}\n\nCompose the document content. Be thorough, professional, and well-structured. Use clear headings and formatting. Return ONLY the content.`;
            } else if (composeType === 'draft') {
                claudePrompt = `You are Omar's personal assistant. He wants you to DRAFT written content.\n\n${contextData ? `Here is real data from his Google account for context:\n${contextData}\n` : ''}\n${conversationContext ? `Recent conversation:\n${conversationContext}\n` : ''}\nOmar's request: ${message}\n\nWrite the draft content. Match the appropriate tone. Return ONLY the draft text.`;
            } else if (composeType === 'summarize') {
                claudePrompt = `You are Omar's personal assistant. He wants you to SUMMARIZE or DOCUMENT information.\n\n${contextData ? `Here is real data from his Google account:\n${contextData}\n` : ''}\n${conversationContext ? `Recent conversation:\n${conversationContext}\n` : ''}\nOmar's request: ${message}\n\nCreate a clear, organized summary or document. Use bullet points and headings where appropriate. Return ONLY the content.`;
            }
            logger.info(`OpenAI composing ${composeType} (${claudePrompt.length} chars)...`);
            const claudeResponse = await this._callOpenAI(claudePrompt);
            if (claudeResponse) {
                const icon = composeType === 'document' ? 'Doc' : composeType === 'draft' ? 'Draft' : 'Summary';
                return `**Claude composed (${icon}):**\n\n${claudeResponse}`;
            }
            logger.warn('Claude CLI unavailable for composition, falling back to Gemini');
            return await this._fallbackToGemini(message, context, contextData);
        } catch (error) {
            logger.error(`Claude compose error (${composeType}):`, error.message);
            return await this._fallbackToGemini(message, context);
        }
    }

    async _analyzeGoogleData(message, context, dataType) {
        const { googleWorkspace } = this.skills;
        let data = '';
        try {
            if (dataType === 'email') { logger.info('Fetching emails...'); data = await googleWorkspace.getRecentEmails(10); }
            else if (dataType === 'calendar') { logger.info('Fetching calendar...'); data = await googleWorkspace.getTodayEvents(); }
            else if (dataType === 'drive') {
                logger.info('Fetching drive files...');
                let searchTerm = message.replace(/^(can you |please |hey |could you |i want to |i need to )/gi, '').replace(/(search|find|look|check|show|get|list|see|view|open|my|on|in|the|me|through|for|at|all|up|what'?s?|is|are|do|does)\s*/gi, '').replace(/\b(drive|files?|documents?|folders?|google|recent|stuff|things?|content)\b/gi, '').replace(/[?!.,]/g, '').trim();
                if (!searchTerm || searchTerm.length < 3 || /^(or|not|to|it|a|an|i|and|but|so|how|can|has|have|had)$/i.test(searchTerm)) searchTerm = 'recent';
                logger.info(`Drive search term: "${searchTerm}"`);
                data = await googleWorkspace.searchFiles(searchTerm);
            }
            if (!data || data.includes('not configured')) return `Google ${dataType} is not set up properly.`;
            logger.info(`Got ${dataType} data (${data.length} chars), sending to Gemini...`);
            const contextStr = context.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
            const analysisPrompt = `You are Omar's personal assistant. Here is real data from his Google account:\n\n${data}\n\n${contextStr ? `Recent conversation:\n${contextStr}\n` : ''}\nOmar's request: ${message}\n\nAnalyze the data above and answer his question directly. Be helpful and concise.`;
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash-preview:generateContent?key=${this.geminiApiKey}`,
                { contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 4096 } },
                { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text;
            return 'Could not analyze the data. Try asking differently.';
        } catch (error) { logger.error(`Google ${dataType} analysis error:`, error.message); return `Failed to get ${dataType}: ${error.message}`; }
    }

    async prefetchData(message) {
        const { googleWorkspace, braveSearch } = this.skills;
        const lower = message.toLowerCase();
        const sections = [];
        try {
            if (lower.match(/email|inbox|mail|gmail|message from|sent me/)) { if (googleWorkspace?.isReady()) { logger.info('Pre-fetching emails for Claude...'); const emails = await googleWorkspace.getRecentEmails(10); sections.push(`=== RECENT EMAILS ===\n${emails}`); } }
            if (lower.match(/calendar|schedule|event|meeting|today|appointment/)) { if (googleWorkspace?.isReady()) { logger.info('Pre-fetching calendar for Claude...'); const events = await googleWorkspace.getTodayEvents(); sections.push(`=== TODAY'S CALENDAR ===\n${events}`); } }
            if (lower.match(/drive|file|document|folder|find.*file|search.*drive|look.*drive|check.*drive|what.*drive|find.*document/)) {
                if (googleWorkspace?.isReady()) {
                    let searchTerm = '';
                    const forMatch = message.match(/(?:for|about|named|called|related to|regarding)\s+['"]?(.+?)['"]?\s*$/i);
                    if (forMatch) searchTerm = forMatch[1].trim();
                    if (!searchTerm) { const quotedMatch = message.match(/['"]([^'"]+)['"]/); if (quotedMatch) searchTerm = quotedMatch[1].trim(); }
                    if (!searchTerm) { searchTerm = message.replace(/^(can you |please |hey |could you |i need |i want )/gi, '').replace(/(search|find|look|check|show|get|what'?s?|are there|is there|any|my|on|in|the|me|through)\s*/gi, '').replace(/\b(drive|files?|documents?|folders?|google)\b/gi, '').trim(); }
                    if (searchTerm.length > 1) { logger.info(`Pre-fetching Drive results for: "${searchTerm}"`); const files = await googleWorkspace.searchFiles(searchTerm); sections.push(`=== DRIVE SEARCH RESULTS ===\n${files}`); }
                }
            }
            if (lower.match(/search|look up|find out|what is|who is|latest|news|how to/) && !sections.length) {
                if (braveSearch) { logger.info('Pre-fetching web search for Claude...'); const query = message.replace(/^(search|look up|find)\s*(for)?\s*/i, '').trim(); const results = await braveSearch.search(query); sections.push(`=== WEB SEARCH RESULTS ===\n${results}`); }
            }
        } catch (error) { logger.error('Pre-fetch error:', error.message); }
        return sections.join('\n\n');
    }

    async thinkWithClaude(message, context) {
        let prefetchedData = null;
        try {
            prefetchedData = await this.prefetchData(message);
            const contextStr = context.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            let fullPrompt = this.claudeSystemPrompt + '\n\n';
            if (this._memoryContext) fullPrompt += `${this._memoryContext}\n\n`;
            if (this._learnedContext) fullPrompt += `${this._learnedContext}\n\n`;
            if (contextStr) fullPrompt += `Recent conversation:\n${contextStr}\n\n`;
            if (this.mcpBridge) { const toolInfo = this.mcpBridge.getToolDescriptions(); if (toolInfo) fullPrompt += `Available MCP tools:\n${toolInfo}\n\n`; }
            if (prefetchedData) fullPrompt += `Here is real data from Omar's accounts:\n\n${prefetchedData}\n\n`;
            fullPrompt += `Omar's request: ${message}\n\nAnalyze the data and answer his question directly. Be concise.`;
            logger.info('Calling OpenAI (backend brain)...');
            const openaiResponse = await this._callOpenAI(fullPrompt);
            if (openaiResponse) return openaiResponse;
            logger.warn('Claude CLI returned empty, falling back to Gemini');
            return await this._fallbackToGemini(message, context, prefetchedData);
        } catch (error) {
            logger.error('Claude CLI error, falling back to Gemini:', error.message);
            return await this._fallbackToGemini(message, context, prefetchedData);
        }
    }

    async _refreshAccessToken() {
        if (!this._openaiRefreshToken) throw new Error('No OpenAI refresh token configured');
        try {
            logger.info('Auto-refreshing OpenAI access token...');
            const response = await axios.post('https://auth.openai.com/oauth/token', {
                grant_type: 'refresh_token',
                refresh_token: this._openaiRefreshToken,
                client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
            }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
            this._openaiAccessToken = response.data.access_token;
            if (response.data.refresh_token) this._openaiRefreshToken = response.data.refresh_token;
            this._tokenExpiresAt = Date.now() + ((response.data.expires_in || 3600) * 1000) - 60000; // refresh 1min early
            logger.info('OpenAI access token refreshed successfully');
        } catch (error) {
            logger.error('Token refresh failed:', error.response?.data || error.message);
            throw new Error('OpenAI token refresh failed: ' + (error.response?.data?.error?.message || error.message));
        }
    }

    async _getValidToken() {
        if (!this._openaiAccessToken && !this._openaiRefreshToken) throw new Error('No OpenAI credentials configured. Set OPENAI_CODEX_TOKEN and OPENAI_CODEX_REFRESH in .env');
        if (!this._openaiAccessToken || Date.now() >= this._tokenExpiresAt) await this._refreshAccessToken();
        return this._openaiAccessToken;
    }

    async _callOpenAI(prompt) {
        try {
            const maxPromptLen = 100000;
            const safePrompt = prompt.length > maxPromptLen ? prompt.substring(0, maxPromptLen) + '\n\n[Prompt truncated for length]' : prompt;
            const token = await this._getValidToken();
            logger.info(`OpenAI API calling model: ${this.openaiModel} (prompt: ${safePrompt.length} chars)`);
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: this.openaiModel,
                messages: [
                    { role: 'system', content: this.claudeSystemPrompt },
                    { role: 'user', content: safePrompt }
                ],
                max_tokens: 4096,
                temperature: 0.4
            }, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: this.openaiTimeout
            });
            const text = response.data.choices?.[0]?.message?.content;
            if (text) {
                logger.info(`OpenAI response: ${text.length} chars`);
                return text;
            }
            logger.warn('OpenAI returned empty response');
            return null;
        } catch (error) {
            if (error.response?.status === 401) {
                logger.warn('OpenAI 401 — attempting token refresh and retry...');
                try {
                    await this._refreshAccessToken();
                    const token = this._openaiAccessToken;
                    const retryResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                        model: this.openaiModel,
                        messages: [{ role: 'system', content: this.claudeSystemPrompt }, { role: 'user', content: prompt.substring(0, 100000) }],
                        max_tokens: 4096, temperature: 0.4
                    }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: this.openaiTimeout });
                    return retryResponse.data.choices?.[0]?.message?.content || null;
                } catch (retryErr) {
                    logger.error('OpenAI retry after refresh failed:', retryErr.message);
                    throw retryErr;
                }
            }
            if (error.code === 'ECONNABORTED') { logger.error(`OpenAI timed out after ${this.openaiTimeout}ms`); throw new Error('OpenAI API timed out'); }
            logger.error('OpenAI API error:', error.response?.data?.error?.message || error.message);
            throw error;
        }
    }

    async _fallbackToGemini(message, context, prefetchedData = null) {
        logger.info('Falling back to Gemini...');
        if (prefetchedData) {
            const contextStr = context.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
            let analysisPrompt = '';
            if (contextStr) analysisPrompt += `Recent conversation:\n${contextStr}\n\n`;
            analysisPrompt += `Here is real data from Omar's accounts:\n\n${prefetchedData}\n\n`;
            analysisPrompt += `Omar's request: ${message}\n\nAnalyze the data and answer his question directly.`;
            try {
                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash-preview:generateContent?key=${this.geminiApiKey}`,
                    { contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }], systemInstruction: { parts: [{ text: this.claudeSystemPrompt }] }, generationConfig: { temperature: 0.4, maxOutputTokens: 4096 } },
                    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
                );
                const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
                return text || 'I found the data but couldn\'t analyze it. Try asking differently.';
            } catch (error) { logger.error('Gemini fallback error:', error.message); return `Both Claude and Gemini failed: ${error.message}`; }
        }
        return await this.thinkWithGemini(message, context);
    }

    async thinkWithGemini(message, context) {
        if (!this.geminiApiKey) return 'Add GEMINI_API_KEY to .env';
        try {
            const contents = context.slice(-10).map(msg => ({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content }] }));
            contents.push({ role: 'user', parts: [{ text: message }] });
            let enrichedPrompt = this.geminiPrompt;
            if (this._memoryContext) enrichedPrompt += `\n${this._memoryContext}`;
            if (this._learnedContext) enrichedPrompt += `\n${this._learnedContext}`;
            const apiKey = keyRouter.getKey('textChat');
            apiRateLimiter.trackRequest('gemini-text-chat');
            const makeRequest = (key) => axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash-preview:generateContent?key=${key}`,
                { contents, systemInstruction: { parts: [{ text: enrichedPrompt }] }, generationConfig: { temperature: 0.8, maxOutputTokens: 2048 } },
                { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
            );
            const response = await apiRateLimiter.callWithRetry(
                () => makeRequest(apiKey),
                { maxRetries: 3, apiKeyName: 'gemini-text-chat', onRateLimit: async () => { const fallbackKey = keyRouter.getFallback('textChat'); if (fallbackKey) { logger.info(`Switching to fallback key`); return await makeRequest(fallbackKey); } throw new Error('All keys rate limited'); } }
            );
            const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            return text || "I'm here!";
        } catch (error) { logger.error('Gemini error:', error.message); return `Error: ${error.message}`; }
    }
}

// Alias so index.js can import as ClaudeBrain
export { SmartBrain as ClaudeBrain };

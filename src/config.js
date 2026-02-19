import 'dotenv/config';

export const config = {
    // Bot settings
    botName: process.env.BOT_NAME || 'Mary Jane',
    brainMethod: process.env.BRAIN_METHOD || 'gemini',

    // Telegram
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUsers: (process.env.ALLOWED_USERS || '').split(',').filter(Boolean),

    // APIs
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiAgentKey: process.env.GEMINI_AGENT_KEY || process.env.GEMINI_API_KEY,
    geminiBackgroundKey: process.env.GEMINI_BACKGROUND_KEY || process.env.GEMINI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    newsApiKey: process.env.NEWSAPI_KEY,
    openweatherApiKey: process.env.OPENWEATHER_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,

    // Supabase (vector memory)
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,

    // Google
    googleTokenPath: process.env.GOOGLE_TOKEN_PATH || './data/google_token.json',
    googleCredentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './data/client_secret.json',

    // Twilio (optional)
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,
    twilioMessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    myPhoneNumber: process.env.MY_PHONE_NUMBER,

    // ElevenLabs (optional)
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,

    // OpenAI Codex (uses $20 ChatGPT Plus subscription via OpenClaw OAuth)
    openaiCodexToken: process.env.OPENAI_CODEX_TOKEN,
    openaiCodexRefresh: process.env.OPENAI_CODEX_REFRESH,
    openaiCodexModel: process.env.OPENAI_CODEX_MODEL || 'gpt-5.3-codex',
    claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT || '60000', 10),

    // Security
    encryptionKey: process.env.ENCRYPTION_KEY,
    maxMessagesPerMinute: parseInt(process.env.RATE_LIMIT || '30', 10),

    // System
    memoryDbPath: process.env.MEMORY_DB_PATH || './data/memory.sqlite',
    logLevel: process.env.LOG_LEVEL || 'info',
    port: parseInt(process.env.PORT || '3000', 10),
};

// Validate required config
const required = ['telegramToken'];
for (const key of required) {
    if (!config[key]) {
        console.error(`Missing required config: ${key}`);
        process.exit(1);
    }
}

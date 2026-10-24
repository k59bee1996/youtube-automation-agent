const OpenAI = require('openai');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

// Keep task-specific model decisions in one place. Agents select a profile, but
// the transport-specific request handling stays in AITextService.
const MODEL_CONFIG = Object.freeze({
  strategy: Object.freeze({
    model: 'gpt-5.6-terra',
    reasoning_effort: 'medium',
  }),
  script: Object.freeze({
    model: 'gpt-5.6-terra',
    reasoning_effort: 'low',
  }),
  seo: Object.freeze({
    model: 'gpt-5.6-luna',
    reasoning_effort: 'none',
  }),
  default: Object.freeze({
    model: 'gpt-5.6-luna',
    reasoning_effort: 'none',
  }),
});

function isGPT56Model(model) {
  return /(?:^|\/)gpt-5\.6(?:-|$)/i.test(model || '');
}

// Sampling-parameter support is not uniform across OpenAI-compatible APIs.
// Keep the documented capability map for visibility, but leave sampling at the
// provider default for every request. Task-specific output guidance belongs in
// prompts, which avoids unsupported-parameter errors across providers.
const MODEL_CAPABILITIES = Object.freeze({
  openai: Object.freeze({
    default: Object.freeze({ supportsTemperature: true }),
    'gpt-5.6': Object.freeze({ supportsTemperature: false, supportsReasoningEffort: true }),
    'gpt-5.6-terra': Object.freeze({ supportsTemperature: false, supportsReasoningEffort: true }),
    'gpt-5.6-luna': Object.freeze({ supportsTemperature: false, supportsReasoningEffort: true }),
  }),
  // OpenRouter can route one model to different upstream providers. Its listed
  // Claude/GPT/Gemini models reject or do not document temperature; use the
  // provider default for every listed route to avoid backend-specific 400s.
  openrouter: Object.freeze({ default: Object.freeze({ supportsTemperature: false }) }),
  // Moonshot and MiMo's public documentation does not guarantee temperature
  // support for every model exposed by their OpenAI-compatible endpoints.
  kimi: Object.freeze({ default: Object.freeze({ supportsTemperature: false }) }),
  mimo: Object.freeze({ default: Object.freeze({ supportsTemperature: false }) }),
  // Z.AI documents temperature for its chat-completions API.
  glm: Object.freeze({ default: Object.freeze({ supportsTemperature: true }) }),
  // Gemini 3.x requires sampling parameters to be removed.
  gemini: Object.freeze({ default: Object.freeze({ supportsTemperature: false }) }),
});

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

class AITextService {
  constructor(credentials = {}, options = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;
    this.providerId = null;
    this.usesOpenAIModelRouting = false;
    this.providerPreference = options.provider || null;

    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (this.providerPreference === 'gemini') {
      const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
      if (geminiKey) return this._initGemini(geminiKey, credentials.gemini?.model);
      this.logger.warn('Google Gemini was requested for this task, but no Gemini API key is configured');
      return;
    }

    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      const key = process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.providerId = Object.entries(PROVIDERS).find(([, value]) => value === preset)?.[0] || null;
    this.usesOpenAIModelRouting = this.providerId === 'openai';
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.providerId = 'gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  getRequestDetails(options = {}) {
    const task = options.task || 'default';
    const modelConfig = MODEL_CONFIG[task] || MODEL_CONFIG.default;
    const model = options.model || (
      this.usesOpenAIModelRouting ? modelConfig.model : this.model
    );
    const capabilities = this.getModelCapabilities(model);
    const usesGPT56Settings = capabilities.supportsReasoningEffort && isGPT56Model(model);

    return {
      task,
      provider: this.providerName || 'unavailable',
      model: model || 'unavailable',
      maxTokens: options.maxTokens || 2048,
      reasoningEffort: usesGPT56Settings
        ? options.reasoning_effort || modelConfig.reasoning_effort
        : null,
      temperatureSupported: capabilities.supportsTemperature,
      available: this.isAvailable(),
    };
  }

  getModelCapabilities(model) {
    const providerCapabilities = MODEL_CAPABILITIES[this.providerId] || MODEL_CAPABILITIES.openrouter;
    return providerCapabilities[model] || providerCapabilities.default;
  }

  describeRequest(options = {}) {
    const details = this.getRequestDetails(options);
    const settings = details.reasoningEffort
      ? `reasoning_effort=${details.reasoningEffort}`
      : 'sampling=provider default';
    return `task=${details.task}, provider=${details.provider}, model=${details.model}, ${settings}`;
  }

  async generateText(prompt, options = {}) {
    const details = this.getRequestDetails(options);
    const { task, model, maxTokens, reasoningEffort } = details;

    this.logger.info(
      `AI text request: task=${task}, provider=${details.provider}, model=${model}, ` +
      `${reasoningEffort ? `reasoning_effort=${reasoningEffort}` : 'sampling=provider default'}, max_tokens=${maxTokens}`
    );

    if (this.gemini) {
      const config = { maxOutputTokens: maxTokens };
      const response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      const text = response && response.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(
          `${this.providerName} returned an empty response. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`
        );
      }
      return text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
    };

    // GPT-5.6 controls deliberation through reasoning_effort and rejects
    // non-default temperatures. Other OpenAI-compatible models keep their
    // existing temperature behavior.
    if (reasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }

    try {
      // Newer OpenAI models (gpt-5.x and later) reject the legacy max_tokens
      // parameter with a 400 error and require max_completion_tokens instead.
      const response = await this.client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens,
      });
      return this._extractContent(response);
    } catch (error) {
      // Older models and some providers reject max_completion_tokens with a 400;
      // retry the same request using the legacy max_tokens spelling.
      if (
        error &&
        error.status === 400 &&
        /max(_completion)?_tokens/i.test(error.message || '')
      ) {
        const response = await this.client.chat.completions.create({
          ...params,
          max_tokens: maxTokens,
        });
        return this._extractContent(response);
      }
      throw error;
    }
  }

  _extractContent(response) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

module.exports = {
  AITextService,
  PROVIDERS,
  GEMINI_MODELS,
  GEMINI_DEFAULT_MODEL,
  MODEL_CONFIG,
  MODEL_CAPABILITIES,
  isGPT56Model,
};

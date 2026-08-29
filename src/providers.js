'use strict';

// LLM 供应商适配层：把 DeepSeek 单一接入变成可插拔的多供应商注册表。
// 项目所有 LLM 调用（simulate/extract-llm/refactor/rebase 及 IDE 的模拟/提取/重构）走的都是
// OpenAI 兼容的 chat/completions 协议（含 Ollama / DashScope 的 compatible-mode），差异只在
// 三处：baseUrl、API key 环境变量名、默认模型名（外加模型上下文窗口用于硬护栏）。
// 因此适配层不做协议翻译，只做"供应商→环境约定"的统一解析与向后兼容兜底。
//
// 切换方式（按优先级）：
//   1. LLM_PROVIDER 环境变量（如 LLM_PROVIDER=moonshot）
//   2. config.json 顶层 provider 字段（IDE 场景，见 app/config-util.js）
//   3. 依赖关系自动兜底：仅设置了某个供应商的 key 而 LLM_PROVIDER 未指定时，推断为该供应商
// 未命中任何显式设定时默认 deepseek（历史行为，向后兼容）。

const DEFAULT_PROVIDER = 'deepseek';

// 供应商注册表（OpenAI 兼容协议簇）。keyEnv 为 null 表示无需鉴权（本地 ollama 等）。
const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    contextTokens: 128000,
    jsonMode: true,
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o',
    contextTokens: 128000,
    jsonMode: true,
  },
  moonshot: {
    name: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyEnv: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshot-v1-8k',
    contextTokens: 128000,
    jsonMode: true,
  },
  qwen: {
    name: '通义千问（DashScope）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-plus',
    contextTokens: 131000,
    jsonMode: true,
  },
  zhipu: {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyEnv: 'ZHIPUAI_API_KEY',
    defaultModel: 'glm-4-plus',
    contextTokens: 128000,
    jsonMode: true,
  },
  ollama: {
    // 本地离线模型：无鉴权头；json object 由 format=json 而非 response_format 触发，标记为不支持 response_format
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: null,
    defaultModel: 'llama3.1',
    contextTokens: 128000,
    jsonMode: false,
  },
};

// 环境变量名推导：{PROVIDER}_BASE_URL / {PROVIDER}_MODEL 可覆盖同名供应商默认值，
// 全 lowercase 供应商 id 一律转大写（deepseek → DEEPSEEK_*，与历史 DEEPSEEK_API_KEY 对齐）。
const envBaseName = (id) => `${id.toUpperCase()}_BASE_URL`;
const envModelName = (id) => `${id.toUpperCase()}_MODEL`;

function providerIds() {
  return Object.keys(PROVIDERS);
}

function isKnownProvider(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/**
 * 智能推断当前供应商：显式 LLM_PROVIDER 优先；否则看其它供应商的 key/baseUrl
 * 是否已设置（历史 DeepSeek 单 key 场景 → deepseek）。显式指定未知 → 诊断性报错。
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{provider:string, explicit:boolean}}
 */
function resolveProviderId(env) {
  const e = env || process.env;
  const explicit = e.LLM_PROVIDER;
  if (explicit) {
    if (isKnownProvider(explicit)) return { provider: explicit, explicit: true };
    // 显式传未知：宁可暴露问题也不静默回退（静默回退会让用户误以为切到 X 实际还在用 deepseek）
    const err = new Error(
      `未知 LLM_PROVIDER「${explicit}」。可用：${providerIds().join(' / ')}。比如 LLM_PROVIDER=moonshot 并设置 MOONSHOT_API_KEY。`
    );
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  // 依赖自动推断：哪个供应商的 key 或专属 baseUrl 存在就用哪个（deepseek 恒默认，放最后）
  for (const id of providerIds()) {
    if (id === DEFAULT_PROVIDER) continue;
    if ((PROVIDERS[id].keyEnv && e[PROVIDERS[id].keyEnv]) || e[envBaseName(id)]) {
      return { provider: id, explicit: false };
    }
  }
  return { provider: DEFAULT_PROVIDER, explicit: false };
}

/**
 * 解析生效的供应商配置（纯函数，便于测试）。返回含 apiKey/baseUrl/model 的完整连接对象。
 * @param {object} [opts]
 * @param {string} [opts.provider] 显式指定（config 层），优先级低于 env.LLM_PROVIDER（env 是全局来源）
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {string} [opts.apiKey] 调用方已解析的 key（如 IDE 从 STATE/config 读到的），优先级最高
 * @returns {{provider:string, name:string, baseUrl:string, apiKey:string|null, model:string, contextTokens:number, jsonMode:boolean, explicit:boolean}}
 */
function resolveProvider(opts = {}) {
  const e = opts.env || process.env;
  const explicitEnv = e.LLM_PROVIDER;
  let id = DEFAULT_PROVIDER;
  let explicit = false;
  if (opts.provider && isKnownProvider(opts.provider)) { id = opts.provider; explicit = true; }
  if (explicitEnv && isKnownProvider(explicitEnv)) { id = explicitEnv; explicit = true; }
  if (opts.provider && !isKnownProvider(opts.provider) && !explicitEnv) {
    const err = new Error(
      `未知供应商「${opts.provider}」。可用：${providerIds().join(' / ')}。`
    );
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  if (explicitEnv && !isKnownProvider(explicitEnv)) {
    const err = new Error(
      `未知 LLM_PROVIDER「${explicitEnv}」。可用：${providerIds().join(' / ')}。`
    );
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  if (!explicit) {
    const inferred = resolveProviderId(e);
    id = inferred.provider;
    explicit = inferred.explicit;
  }
  const def = PROVIDERS[id];
  // key：显式 apiKey > 该供应商 keyEnv > 通用 LLM_API_KEY（本地无鉴权可传冗余 key，取到也无妨）
  const apiKey = opts.apiKey || e[def.keyEnv || '__none__'] || e.LLM_API_KEY || null;
  const baseUrl = e.LLM_BASE_URL || e[envBaseName(id)] || def.baseUrl;
  const model = e.LLM_MODEL || e[envModelName(id)] || def.defaultModel;
  return {
    provider: id,
    name: def.name,
    baseUrl,
    apiKey,
    model,
    contextTokens: def.contextTokens,
    jsonMode: def.jsonMode,
    explicit,
  };
}

/**
 * 缺失/配置错误的面向用户诊断提示（随供应商变化）。keyEnv 为 null 的供应商（ollama）不需 key，
 * 若其仍未就绪应提示 baseUrl。
 * @param {string} provider
 * @returns {string}
 */
function missingKeyHint(provider) {
  const def = PROVIDERS[provider];
  if (!def) return '（未知供应商）';
  if (!def.keyEnv) {
    return `供应商「${provider}」无鉴权要求，请确认其服务已就绪或 LLM_BASE_URL=${def.baseUrl} 可访问`;
  }
  return `缺少 ${def.keyEnv} 环境变量（${def.name}）；或设置 LLM_PROVIDER 后对应供应商的 API key（可读取 .dsh-home/.credentials.yaml 中的同名项注入）`;
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  providerIds,
  isKnownProvider,
  resolveProviderId,
  resolveProvider,
  missingKeyHint,
};
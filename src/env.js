'use strict';

// LLM 连接环境统一读取（simulate / extract-llm / refactor / rebase / IDE 共用）。
// v0.4.4+ 通过 src/providers.js 适配层多供应商解析：LLM_PROVIDER 或自动推断供应商，
// 而非硬编码 DeepSeek。返回结构保持 { apiKey, baseUrl, model } 向后兼容，另附 provider 元信息。

const { resolveProvider } = require('./providers');

/**
 * @param {object} [opts]
 * @param {string} [opts.provider] 上层已解析的供应商（优先级最低，env 优先）
 * @param {string} [opts.apiKey] 上层已解析的 key（如 IDE 从 config/凭据读取）
 * @returns {{apiKey:string|null, baseUrl:string, model:string, provider:string}}
 */
function loadLLMEnv(opts = {}) {
  const r = resolveProvider({ provider: opts.provider, apiKey: opts.apiKey });
  return {
    apiKey: r.apiKey,
    baseUrl: r.baseUrl,
    model: r.model,
    provider: r.provider,
  };
}

module.exports = { loadLLMEnv };
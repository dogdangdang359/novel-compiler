'use strict';

// LLM 环境变量统一读取（simulate / extract-llm 共用）

function loadLLMEnv() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || undefined,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  };
}

module.exports = { loadLLMEnv };

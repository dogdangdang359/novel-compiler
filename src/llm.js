'use strict';

// DeepSeek API 封装：JSON 输出 + 围栏剥离 + 推理模型预算自动升级（零依赖，Node 18+ 自带 fetch）

const DEFAULT_BASE = 'https://api.deepseek.com';

// 输入预算（token 估算阈值）：估算超限时 extract-llm 全量模式自动分块、
// simulate/refactor 给出警告（不截断）。可用 LLM_INPUT_BUDGET_TOKENS 环境变量调整。
const INPUT_BUDGET_TOKENS = Number(process.env.LLM_INPUT_BUDGET_TOKENS || 48000) || 48000;
// 模型上下文绝对上限：DeepSeek 家族当前 128K（输入+输出共享窗口）。
// 硬护栏的语义是"超限调用必败"，只能锚定真实模型窗口，不能纯随预算缩放：
// 预算调大（如 200k）时 ×3 相对护栏跟着水涨船高，护栏形同虚设；默认 48k×3=144k
// 也已越过 128K 窗口。走 DEEPSEEK_BASE_URL 接其他大上下文模型时可调 LLM_MODEL_CONTEXT_TOKENS。
const MODEL_CONTEXT_TOKENS = Number(process.env.LLM_MODEL_CONTEXT_TOKENS || 128000) || 128000;
// 硬护栏：输入估算超此上限直接拒绝（不调 LLM）。预算以内尚有分块/警告兜底，
// 超过硬限的调用必败（超出任何常见模型上下文），重试只会白烧钱。
const HARD_INPUT_LIMIT = Math.min(INPUT_BUDGET_TOKENS * 3, MODEL_CONTEXT_TOKENS);

/**
 * 输入预算硬护栏：估算超 HARD_INPUT_LIMIT 时抛错（调用方打印后 exit 2）。
 * @param {string} label 场景名（如"模拟器/提取器"）
 * @param {number} tokens 估算 token 数
 */
function assertInputWithinHardLimit(label, tokens) {
  if (tokens > HARD_INPUT_LIMIT) {
    const err = new Error(`${label}输入估算约 ${tokens} tokens，超过硬上限 ${HARD_INPUT_LIMIT}（min(LLM_INPUT_BUDGET_TOKENS × 3, 模型上下文 ${MODEL_CONTEXT_TOKENS})）——调用必然失败，已拒绝。请拆分输入：分次提取/精简大纲前提/分卷管理。`);
    err.code = 'INPUT_HARD_LIMIT';
    throw err;
  }
}

// 粗略 token 估算（仅用于预算规划，不需要精确）：中文 1 字 ≈ 1 token（保守），
// ASCII 约 4 字符 ≈ 1 token。纯 ASCII 文本会高估，中文长文本接近真实。
function estimateTokens(text) {
  const s = String(text || '');
  let zh = 0;
  let ascii = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x2e7f) zh += 1;
    else ascii += 1;
  }
  return zh + Math.ceil(ascii / 4);
}

// 请求体构建（纯函数，供测试）：jsonMode 控制是否附加 response_format=json_object
function buildRequestBody({ model, messages, maxTokens = 8192, temperature = 0.6, jsonMode = false }) {
  return {
    model,
    messages,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    max_tokens: maxTokens,
    temperature,
  };
}
const MAX_BUDGET = 65536;

// 重试最小退避：5xx/429/网络错误在重试前等待（避免连续失败打满服务端限流）
const RETRY_BACKOFF_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单次 LLM 调用超时：默认与 max_tokens 预算挂钩（推理模型会把预算花在 reasoning 上，
// 大预算任务需要更长等待——固定 5 分钟会误杀 65k 预算的调用）；
// 可用 timeoutMs 参数或 LLM_TIMEOUT_MS 环境变量整体覆盖。工具级 TOOL_TIMEOUT_MS 仍为最终兜底。
const DEFAULT_TIMEOUT_MS = 300000;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 0) || 0;
function timeoutFor(maxTokens, timeoutMs) {
  if (timeoutMs) return timeoutMs;
  if (LLM_TIMEOUT_MS) return LLM_TIMEOUT_MS;
  return Math.max(DEFAULT_TIMEOUT_MS, (maxTokens || 8192) * 10);
}

function stripFence(text) {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
}

/**
 * 调用 chat/completions，返回原始响应信息。
 * @param {object} opts - { apiKey, model, messages, maxTokens, temperature, baseUrl, signal, jsonMode }
 *   jsonMode=true 时附加 response_format=json_object（仅 JSON 生成使用；
 *   纯文本生成绝不能开 —— 强制 JSON 模式会让模型输出空白/报 400）。
 * @returns {Promise<{content: string, finishReason: string}>}
 */
async function chat(opts) {
  const { apiKey, model, messages, maxTokens = 8192, temperature = 0.6, baseUrl, signal, jsonMode = false } = opts;
  const res = await fetch(`${baseUrl || DEFAULT_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildRequestBody({ model, messages, maxTokens, temperature, jsonMode })),
    signal: signal || AbortSignal.timeout(timeoutFor(maxTokens, opts.timeoutMs)),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 400 && /model/i.test(body)
      ? '（模型名可能不被 API 接受，可尝试 DEEPSEEK_MODEL=deepseek-chat）'
      : '';
    const err = new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}${hint}`);
    err.statusCode = res.status; // 供上层判定：4xx 永久错误不重试（密钥/模型名/参数问题，重试只会白等超时）
    throw err;
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  return {
    content: typeof content === 'string' ? content : '',
    finishReason: choice && choice.finish_reason,
  };
}

/**
 * 调用并解析 JSON。推理模型（如 deepseek-v4-flash）可能把预算全部花在
 * reasoning_content 上导致 content 为空（finish=length）：自动加倍预算重试。
 */
async function chatJSON(opts) {
  let budget = opts.maxTokens || 8192;
  const MAX_ATTEMPTS = 3;
  let last;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    last = await chat({ ...opts, jsonMode: true, maxTokens: budget });
    if (last.content.trim()) {
      try {
        return JSON.parse(stripFence(last.content));
      } catch (e) {
        // finish=length：输出被 max_tokens 截断，JSON 不完整是预算不足导致的（可修复）——
        // 翻倍预算重试而非标 permanent；非截断（finish=stop）解析失败才是模型风格问题，
        // 同提示词重试无意义，标 permanent 让外层不白等退避。
        if (last.finishReason === 'length' && budget < MAX_BUDGET) {
          budget = Math.min(budget * 2, MAX_BUDGET);
          continue;
        }
        const err = new Error(`LLM 输出不是合法 JSON（开头: ${last.content.slice(0, 120).replace(/\n/g, ' ')}）`);
        err.permanent = true;
        throw err;
      }
    }
    if (last.finishReason === 'length' && budget < MAX_BUDGET) {
      budget = Math.min(budget * 2, MAX_BUDGET);
      continue;
    }
    const emptyErr = new Error('LLM 返回空内容（content 为空且未触发预算升级）');
    emptyErr.permanent = true;
    throw emptyErr;
  }
  const budgetErr = new Error(`LLM 在 ${budget} token 预算下仍未产出内容（finish=${last && last.finishReason}）`);
  budgetErr.permanent = true;
  throw budgetErr;
}

/**
 * 带校验反馈的调用循环：输出未通过 validate 时，把错误清单喂回模型重试。
 * 重试策略：网络/解析/超时/5xx 错误原样重试；4xx（除 429 限流）是永久性错误
 * （密钥、模型名、参数问题），立即抛出——旧实现盲目重试最坏白等 3 × 动态超时。
 * @param {object} opts - { apiKey, baseUrl, model, messages, validate, maxAttempts, temperature, maxTokens }
 * @returns {Promise<any>} 通过校验的 JSON
 * @throws {Error} LLM/解析错误（原样抛出）；校验耗尽时抛出带 validationErrors 的错误
 */
async function chatJSONValidated(opts) {
  const { validate, maxAttempts = 3, messages } = opts;
  let lastRaw = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      lastRaw = await chatJSON(opts);
    } catch (e) {
      if (i === maxAttempts - 1) throw e;
      if (e.permanent) throw e; // 解析失败/空内容：同提示词重试无意义（预算升级已在内层尝试过）
      if (e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) throw e; // 永久错误
      await sleep(RETRY_BACKOFF_MS * (i + 1)); // 网络/5xx/429：最小退避后重试（避免连续打满限流）
      continue;
    }
    const errs = validate(lastRaw);
    if (errs.length === 0) return lastRaw;
    if (i === maxAttempts - 1) {
      const err = new Error(`输出 ${maxAttempts} 次未通过校验，放弃`);
      err.validationErrors = errs;
      throw err;
    }
    messages.push({ role: 'assistant', content: JSON.stringify(lastRaw) });
    messages.push({
      role: 'user',
      content: `你上一次的输出未通过校验，问题如下：\n${errs.slice(0, 20).map((e) => `- ${e}`).join('\n')}\n请修正后重新输出完整的 JSON（结构不变，只修正内容，不要解释）。`,
    });
  }
  return lastRaw;
}

/**
 * 带校验反馈的调用循环（Markdown 文本版）：输出未通过 validate 时把错误喂回模型重试。
 * 重试策略与 chatJSONValidated 一致：4xx（除 429）永久错误不重试。
 * @param {object} opts - { apiKey, baseUrl, model, messages, validate, maxAttempts, temperature, maxTokens }
 * @returns {Promise<string>} 通过校验的内容文本
 */
async function chatTextValidated(opts) {
  const { validate, maxAttempts = 3, messages } = opts;
  let budget = opts.maxTokens || 8192;
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      last = await chat({ ...opts, maxTokens: budget });
    } catch (e) {
      if (i === maxAttempts - 1) throw e;
      if (e.permanent) throw e; // 与 chatJSONValidated 同语义：确定性失败不重试
      if (e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) throw e; // 永久错误
      await sleep(RETRY_BACKOFF_MS * (i + 1)); // 网络/5xx/429：最小退避后重试
      continue;
    }
    // finish=length：输出被 max_tokens 截断（推理模型可能把预算花在 reasoning 上导致 content 空/不完整），
    // 翻倍预算重试——与 chatJSON 对称。此时不喂校验反馈：问题在预算而非内容，空内容当"上次输出"反而污染上下文。
    if (last.finishReason === 'length' && budget < MAX_BUDGET) {
      budget = Math.min(budget * 2, MAX_BUDGET);
      continue;
    }
    const errs = validate(last.content);
    if (errs.length === 0) return last.content;
    if (i === maxAttempts - 1) {
      const err = new Error(`输出 ${maxAttempts} 次未通过校验，放弃`);
      err.validationErrors = errs;
      throw err;
    }
    messages.push({ role: 'assistant', content: last.content });
    messages.push({
      role: 'user',
      content: `你上一次的输出未通过校验，问题如下：\n${errs.slice(0, 10).map((e) => `- ${e}`).join('\n')}\n请修正后重新输出完整的 Markdown 文本（结构不变，只修正内容）。`,
    });
  }
  return last ? last.content : '';
}

module.exports = { chatJSONValidated, chatTextValidated, chat, stripFence, buildRequestBody, DEFAULT_BASE, estimateTokens, INPUT_BUDGET_TOKENS, MODEL_CONTEXT_TOKENS, HARD_INPUT_LIMIT, assertInputWithinHardLimit };

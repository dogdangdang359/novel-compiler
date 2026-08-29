'use strict';

// canon 信封处理：提取器（extract-llm）/ 模拟器（simulate）输出是信封
// { canon, evidence|risk_register, ... }，而 compile/compare/rebase/review 需要的是
// 纯 canon。统一在这里判定与解包，避免各入口重复实现且判定口径漂移。

const fs = require('fs');

/**
 * 判断一个对象是否是「信封」：含 canon 字段且本身不是 canon 对象
 * （canon 对象有 entities 数组；信封的 canon 字段是对象且顶层无 entities 数组）。
 */
function isEnvelope(x) {
  return !!x && typeof x === 'object'
    && !!x.canon && typeof x.canon === 'object'
    && !Array.isArray(x.canon)
    && !Array.isArray(x.entities);
}

/** 信封 -> canon；纯 canon 原样返回。 */
function unwrapEnvelope(x) {
  return isEnvelope(x) ? x.canon : x;
}

/**
 * 读取 JSON 文件并解包为纯 canon。
 * @param {string} p 文件路径
 * @returns {object} 纯 canon 对象
 * @throws {Error} 文件不存在 / JSON 非法时抛出（message 带路径）
 */
function loadCanonFile(p) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`无法解析 ${p}（${e.message}）`); }
  return unwrapEnvelope(raw);
}

/**
 * 读取 JSON 文件，同时返回信封与纯 canon（rebase 需要信封 meta 推导输入路径）。
 * @returns {{envelope: object|null, canon: object}}
 * @throws {Error} 文件不存在 / JSON 非法时抛出（message 带路径）
 */
function loadEnvelopeOrCanon(p) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`无法解析 ${p}（${e.message}）`); }
  return { envelope: isEnvelope(raw) ? raw : null, canon: unwrapEnvelope(raw) };
}

module.exports = { isEnvelope, unwrapEnvelope, loadCanonFile, loadEnvelopeOrCanon };

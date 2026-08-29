'use strict';

// canon 结构常量与辅助：跨文件统一，防硬编码漂移。
// 浏览器端通过 /api/canon-schema 端点获取服务端常量，前端仅保留 fallback 字面量。

// 条目数组 section
const CANON_SECTIONS = ['entities', 'knowledge', 'suspense'];
// 含 timeline 的完整列表（mergeEvidence 等需要 timeline 的场合）
const CANON_SECTIONS_ALL = ['entities', 'knowledge', 'suspense', 'timeline'];

/**
 * 数组化防御：输入必须是数组才原样返回，否则返回空数组。
 * 统一替代散落的 `x || []`（只挡 falsy，truthy 非数组会在 .map/.forEach 上抛 TypeError）
 * 与 `Array.isArray(x) ? x : []`（重复内联）。
 */
function asArray(x) {
  return Array.isArray(x) ? x : [];
}

module.exports = { CANON_SECTIONS, CANON_SECTIONS_ALL, asArray };


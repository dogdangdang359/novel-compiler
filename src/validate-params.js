'use strict';

/**
 * 统一参数校验层：每项规则为 { required, type, enum, pattern, message }，
 * 校验失败返回可读错误字符串，成功返回 null。
 *
 * 示例：
 *   validateParams(body, { tool: { required: true, type: 'string' }, args: { required: true, type: 'array' } })
 */
function validateParams(body, rules) {
  for (const [key, rule] of Object.entries(rules)) {
    const val = body[key];
    if (rule.required && (val === undefined || val === null || (typeof val === 'string' && !val.trim()))) {
      return `缺少必填参数: ${key}${rule.message ? `（${rule.message}）` : ''}`;
    }
    if (val !== undefined && val !== null) {
      if (rule.type && typeof val !== rule.type) {
        return `参数 ${key} 类型应为 ${rule.type}，实际为 ${typeof val}`;
      }
      if (rule.enum && !rule.enum.includes(val)) {
        return `参数 ${key} 值不合法（允许: ${rule.enum.join('/')}）${rule.message ? `（${rule.message}）` : ''}`;
      }
      if (rule.pattern && typeof val === 'string' && !rule.pattern.test(val)) {
        return `参数 ${key} 格式不合法${rule.message ? `（${rule.message}）` : ''}`;
      }
    }
  }
  return null;
}

module.exports = { validateParams };
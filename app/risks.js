'use strict';

// 风险登记册状态机：未处理(open) / 已处理(handled) / 已触发(triggered) / 已忽略(ignored)
// 纯函数（服务器与测试共用）：解析、过期判定、状态更新
// 状态文件结构: { source, simulated_at, statuses: { [riskId]: status } }
// 过期判定: 状态文件记录的预测来源/时间与当前预测不一致 → 全部视为 open（旧预测的状态作废）

const STATUSES = ['open', 'handled', 'triggered', 'ignored'];

function parseRiskStatus(raw) {
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object' && d.statuses && typeof d.statuses === 'object') {
      return { source: d.source || null, simulated_at: d.simulated_at || null, statuses: d.statuses };
    }
  } catch { /* 损坏视为空 */ }
  return { source: null, simulated_at: null, statuses: {} };
}

/**
 * 生成新的状态文件内容。
 * @param {string} raw - 现有状态文件内容（可空）
 * @param {{source: string, simulated_at: string|null}|null} meta - 当前预测的标识
 * @param {string} id - 风险 id；status='open' 表示清除该条
 * @param {string} status - 目标状态
 * @returns {string} 新状态文件内容
 */
function buildRiskStatus(raw, meta, id, status) {
  const cur = parseRiskStatus(raw);
  const stale = !meta || cur.simulated_at !== meta.simulated_at || cur.source !== meta.source;
  const statuses = stale ? {} : { ...cur.statuses };
  if (status === 'open') delete statuses[id];
  else statuses[id] = status;
  return JSON.stringify({
    source: meta ? meta.source : null,
    simulated_at: meta ? meta.simulated_at : null,
    statuses,
  }, null, 2) + '\n';
}

/**
 * 判定状态文件是否已过期（对应另一份预测）。
 */
function isStale(cur, meta) {
  return !meta || cur.simulated_at !== meta.simulated_at || cur.source !== meta.source;
}

module.exports = { parseRiskStatus, buildRiskStatus, isStale, STATUSES };

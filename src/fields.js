'use strict';

// 条目字段级比较 —— 唯一实现（incremental / extraction / review 共用，避免三份漂移）。
// 语义：union 键集（基线有而提议没有的键也算变化，如删除 aliases）、JSON.stringify 值比较。
//   fieldsChanged(b, a) -> { key: [old, new] }     （对象版，审阅 diff 用）
//   hasChanges(b, a)    -> boolean                 （快速判定，合并/校验用）
// b = 基线条目，a = 提议条目；任一可为 null（按空对象处理，不崩溃）。

function fieldsChanged(b, a) {
  const changed = {};
  const kb = b && typeof b === 'object' ? b : {};
  const ka = a && typeof a === 'object' ? a : {};
  const keys = new Set([...Object.keys(kb), ...Object.keys(ka)]);
  for (const k of keys) {
    if (JSON.stringify(kb[k]) !== JSON.stringify(ka[k])) changed[k] = [kb[k], ka[k]];
  }
  return changed;
}

function hasChanges(b, a) {
  return Object.keys(fieldsChanged(b, a)).length > 0;
}

module.exports = { fieldsChanged, hasChanges };

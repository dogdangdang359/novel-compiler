'use strict';

// canon.json 结构校验（零依赖）
// 返回 { ok: true } 或 { ok: false, errors: [...] }

const READERS = ['webnovel', 'genre', 'published'];
const { asArray } = require('./canon');
// 条目 id 格式：小写字母开头，仅小写字母/数字/下划线（与提取器/模拟器提示词口径一致）
const ID_RE = /^[a-z][a-z0-9_]*$/;

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function validateCanon(canon) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (!isObj(canon)) return { ok: false, errors: ['canon 必须是 JSON 对象'] };

  const meta = canon.meta;
  if (!isObj(meta)) err('[meta] 缺失或不是对象（至少需要 title）');
  else {
    if (typeof meta.title !== 'string' || !meta.title.trim()) err('[meta.title] 必填字符串');
    if (meta.target_reader !== undefined && !READERS.includes(meta.target_reader)) {
      err(`[meta.target_reader] 必须是 ${READERS.join(' / ')} 之一，当前为 "${meta.target_reader}"`);
    }
  }

  const entities = asArray(canon.entities);
  if (!Array.isArray(canon.entities)) err('[entities] 必须是数组');
  const idSet = new Set();
  entities.forEach((e, i) => {
    const p = `[entities][${i}]`;
    if (!isObj(e)) return err(`${p} 必须是对象`);
    if (typeof e.id !== 'string' || !e.id) err(`${p}.id 必填字符串`);
    else if (!ID_RE.test(e.id)) err(`${p}.id "${e.id}" 格式非法（小写字母开头，仅小写字母/数字/下划线）`);
    else if (idSet.has(e.id)) err(`${p}.id "${e.id}" 重复`);
    else idSet.add(e.id);
    if (typeof e.name !== 'string' || !e.name) err(`${p}.name 必填字符串`);
    if (e.type !== undefined && !['character', 'location', 'item'].includes(e.type)) {
      err(`${p}.type 必须是 character / location / item，当前为 "${e.type}"`);
    }
    if (e.aliases !== undefined && (!Array.isArray(e.aliases) || e.aliases.some((a) => typeof a !== 'string'))) {
      err(`${p}.aliases 必须是字符串数组`);
    }
    if (e.appears_from_chapter !== undefined && (!Number.isInteger(e.appears_from_chapter) || e.appears_from_chapter < 0)) {
      err(`${p}.appears_from_chapter 必须是非负整数`);
    }
  });

  const knowledge = asArray(canon.knowledge);
  if (!Array.isArray(canon.knowledge)) err('[knowledge] 必须是数组');
  const kIdSet = new Set();
  knowledge.forEach((k, i) => {
    const p = `[knowledge][${i}]`;
    if (!isObj(k)) return err(`${p} 必须是对象`);
    if (typeof k.id !== 'string' || !k.id) err(`${p}.id 必填字符串`);
    else if (!ID_RE.test(k.id)) err(`${p}.id "${k.id}" 格式非法（小写字母开头，仅小写字母/数字/下划线）`);
    else if (kIdSet.has(k.id)) err(`${p}.id "${k.id}" 重复`);
    else kIdSet.add(k.id);
    if (typeof k.name !== 'string' || !k.name) err(`${p}.name 必填字符串`);
    if (k.known_from_chapter !== undefined && (!Number.isInteger(k.known_from_chapter) || k.known_from_chapter < 0)) {
      err(`${p}.known_from_chapter 必须是非负整数`);
    }
    if (k.terms !== undefined && (!Array.isArray(k.terms) || k.terms.some((t) => typeof t !== 'string'))) {
      err(`${p}.terms 必须是字符串数组`);
    }
    if (k.holders !== undefined) {
      if (!Array.isArray(k.holders)) err(`${p}.holders 必须是字符串数组`);
      else k.holders.forEach((h) => {
        if (!idSet.has(h)) err(`${p}.holders 引用了不存在的实体 "${h}"`);
      });
    }
  });

  const suspense = asArray(canon.suspense);
  if (!Array.isArray(canon.suspense)) err('[suspense] 必须是数组');
  const sIdSet = new Set();
  suspense.forEach((s, i) => {
    const p = `[suspense][${i}]`;
    if (!isObj(s)) return err(`${p} 必须是对象`);
    if (typeof s.id !== 'string' || !s.id) err(`${p}.id 必填字符串`);
    else if (!ID_RE.test(s.id)) err(`${p}.id "${s.id}" 格式非法（小写字母开头，仅小写字母/数字/下划线）`);
    else if (sIdSet.has(s.id)) err(`${p}.id "${s.id}" 重复`);
    else sIdSet.add(s.id);
    if (typeof s.name !== 'string' || !s.name) err(`${p}.name 必填字符串`);
    ['planted_in_chapter', 'expected_resolve_chapter', 'resolved_in_chapter'].forEach((f) => {
      if (s[f] !== undefined && s[f] !== null && (!Number.isInteger(s[f]) || s[f] < 0)) {
        err(`${p}.${f} 必须是非负整数`);
      }
    });
    // 预期回收早于埋设：逻辑矛盾，直接拒绝（rules.js 只查 resolved<planted，expected 无规则兜底）
    if (s.expected_resolve_chapter !== undefined && s.expected_resolve_chapter !== null
      && s.planted_in_chapter !== undefined
      && s.expected_resolve_chapter < s.planted_in_chapter) {
      err(`${p}.expected_resolve_chapter（${s.expected_resolve_chapter}）早于 planted_in_chapter（${s.planted_in_chapter}）`);
    }
    // 已回收早于埋设：因果倒置，同样直接拒绝（rules.js 的 suspense/order 只在运行时报告，
    // schema 层先拦下可让提取/审阅的确定性校验更早失败）
    if (s.resolved_in_chapter !== undefined && s.resolved_in_chapter !== null
      && s.planted_in_chapter !== undefined
      && s.resolved_in_chapter < s.planted_in_chapter) {
      err(`${p}.resolved_in_chapter（${s.resolved_in_chapter}）早于 planted_in_chapter（${s.planted_in_chapter}）`);
    }
  });

  const timeline = asArray(canon.timeline);
  if (!Array.isArray(canon.timeline)) err('[timeline] 必须是数组');
  const seenChapters = new Set();
  timeline.forEach((t, i) => {
    const p = `[timeline][${i}]`;
    if (!isObj(t)) return err(`${p} 必须是对象`);
    if (!Number.isInteger(t.chapter) || t.chapter < 0) {
      err(`${p}.chapter 必填非负整数`);
    } else if (seenChapters.has(t.chapter)) {
      err(`${p}.chapter ${t.chapter} 重复`);
    } else {
      seenChapters.add(t.chapter);
    }
    if (!Number.isInteger(t.day) || t.day < 0) err(`${p}.day 必填非负整数（剧情内第几天）`);
    if (t.location !== undefined && !idSet.has(t.location)) err(`${p}.location 引用了不存在的实体 "${t.location}"`);
  });

  return { ok: errors.length === 0, errors };
}

// 读者向 -> 规则阈值 / 级别
function configFor(reader) {
  const table = {
    webnovel:  { label: 'webnovel（网文/连载）', overdueLimit: 3,  danglingSeverity: 'info',    chapterMin: 100,  chapterMax: 10000 },
    genre:     { label: 'genre（类型小说）',     overdueLimit: 5,  danglingSeverity: 'warning', chapterMin: 100,  chapterMax: 15000 },
    published: { label: 'published（出版向）',   overdueLimit: 8,  danglingSeverity: 'error',   chapterMin: 100,  chapterMax: 20000 },
  };
  return table[reader] || table.genre;
}

module.exports = { validateCanon, configFor, READERS };

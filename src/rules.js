'use strict';

// 规则引擎：canon + 手稿解析结果 -> problems[]
// problem = { rule, severity, file, line, chapter, message, detail }
// 层次划分：L0 文字层 / L1 连续性层 / L3 资源层（L2 因果层、L4 语义层不在 MVP 范围内）
//
// 规则注册表：每条规则是一个独立函数 { id, layer, name, emits, run(ctx) }，runChecks 依序执行。
// 规则不可插拔的遗留已通过注册表消解——新增规则只需在 RULES 末尾追加条目，无需改 runChecks 主体。

const { PAIRS, isSuppressLine, lastChapterNumber } = require('./extract');
const { asArray } = require('./canon');

// ---------- 共享受益上下文 ----------
// runChecks 在遍历 RULES 前一次性派生供各规则引用的数据，保证顺序一致、零重复派生。
// ctx = { canon, parsed, mentions, quotes, cfg, file, problems, add,
//         chapters, lastChapterNumber, headingLineOf, timeline, chapterNumbers }

// ================= 规则 1 · 章节编号顺序（L0） =================
const ruleChapterOrder = {
  id: 'text/chapter-order',
  layer: 'L0',
  name: '章节编号顺序',
  emits: ['text/chapter-order'],
  run(ctx) {
    const { chapters, add } = ctx;
    // 0 为楔子/序章，首个编号章不参与递增判定
    let prev = -1;
    let firstNumbered = true;
    for (const ch of chapters) {
      if (ch.number === null) continue;
      if (!firstNumbered && ch.number <= prev) {
        add('text/chapter-order', 'error', ch.headingLine, ch.number,
          `章节编号异常：${ch.title} 的编号 ${ch.number} 未递增（前一章为 ${prev}）`);
      } else if (!firstNumbered && ch.number - prev > 1) {
        add('text/chapter-order', 'info', ch.headingLine, ch.number,
          `章节编号跳号：${prev + 1} 与 ${ch.number} 之间存在空缺`);
      }
      prev = Math.max(prev, ch.number);
      firstNumbered = false;
    }
  },
};

// ================= 规则 2 · 引号配对（L0） =================
// 指向首个失衡行，便于跳转与豁免
const ruleQuoteBalance = {
  id: 'text/quote-balance',
  layer: 'L0',
  name: '引号配对',
  emits: ['text/quote-balance'],
  run(ctx) {
    const { chapters, quotes, add } = ctx;
    for (const ch of chapters) {
      const q = quotes[ch.index];
      if (!q) continue;
      for (const [open, close] of PAIRS) {
        if (q.count[open] !== q.count[close]) {
          add('text/quote-balance', 'info', q.firstBadLine || ch.headingLine, ch.number ?? ch.index + 1,
            `引号不配对：「${open}」出现 ${q.count[open]} 次、「${close}」出现 ${q.count[close]} 次`,
            '若为有意的对话中断（如话未说完），可忽略');
        }
      }
    }
  },
};

// ================= 规则 3 · 章节长度（L0） =================
const ruleChapterLength = {
  id: 'structure/chapter-length',
  layer: 'L0',
  name: '章节长度',
  emits: ['structure/chapter-length'],
  run(ctx) {
    const { chapters, cfg, add } = ctx;
    for (const ch of chapters) {
      const n = ch.number ?? ch.index + 1;
      if (ch.charCount < cfg.chapterMin) {
        add('structure/chapter-length', 'info', ch.headingLine, n,
          `第${n}章过短（${ch.charCount} 字 < ${cfg.chapterMin}）`);
      }
      if (ch.charCount > cfg.chapterMax) {
        add('structure/chapter-length', 'info', ch.headingLine, n,
          `第${n}章过长（${ch.charCount} 字 > ${cfg.chapterMax}）`);
      }
    }
  },
};

// ================= 规则 4 · 时间回退（L1） =================
const ruleTimelineRegression = {
  id: 'timeline/regression',
  layer: 'L1',
  name: '时间回退',
  emits: ['timeline/regression'],
  run(ctx) {
    const { timeline, add, headingLineOf } = ctx;
    for (let i = 1; i < timeline.length; i++) {
      const a = timeline[i - 1];
      const b = timeline[i];
      if (b.day < a.day) {
        add('timeline/regression', 'error', headingLineOf(b.chapter), b.chapter,
          `剧情时间回退：第${a.chapter}章 day=${a.day} → 第${b.chapter}章 day=${b.day}`,
          '修复：更新 canon.json 的 timeline 中该章的 day，或在正文中补充时间过渡');
      }
    }
  },
};

// ================= 规则 5 · 时间线覆盖（L1） =================
// 第 0 章=楔子/序章也要求有条目，与提取器"时间线每章一条"口径一致
const ruleTimelineCoverage = {
  id: 'timeline/missing',
  layer: 'L1',
  name: '时间线覆盖',
  emits: ['timeline/missing', 'timeline/planned'],
  run(ctx) {
    const { chapters, timeline, lastChapterNumber, add, headingLineOf } = ctx;
    const timelineChapters = new Set(timeline.map((t) => t.chapter));
    for (const ch of chapters) {
      if (ch.number !== null && !timelineChapters.has(ch.number)) {
        add('timeline/missing', 'info', ch.headingLine, ch.number,
          `第${ch.number}章缺少时间线条目（timeline）`);
      }
    }
    for (const t of timeline) {
      if (t.chapter > lastChapterNumber) {
        add('timeline/planned', 'info', 1, t.chapter,
          `时间线覆盖到第${t.chapter}章，当前进度第${lastChapterNumber}章（规划中，未到期）`);
      }
    }
  },
};

// ================= 规则 5b · 删章幽灵（L1） =================
// canon 时间线有条目但手稿没有该编号章（且不是未来规划章）——删章后 canon 未同步，静默残留
const ruleTimelineGhost = {
  id: 'timeline/ghost',
  layer: 'L1',
  name: '删章幽灵',
  emits: ['timeline/ghost'],
  run(ctx) {
    const { timeline, lastChapterNumber, chapterNumbers, add } = ctx;
    for (const t of timeline) {
      if (t.chapter > lastChapterNumber) continue; // 未来规划章（timeline/planned 已报）
      if (!chapterNumbers.has(t.chapter)) {
        add('timeline/ghost', 'warning', 1, t.chapter,
          `canon 时间线有第${t.chapter}章，但手稿中没有该章（删章后 canon 未同步？）`,
          '修复：删除 canon.json 的 timeline 中该章条目，或恢复对应的正文章节');
      }
    }
  },
};

// ================= 规则 6 · 地点矛盾（L1） =================
// 保守启发式：设定地点未提及 + 其他地点高频出现才报
const ruleContinuityLocation = {
  id: 'continuity/location',
  layer: 'L1',
  name: '地点矛盾',
  emits: ['continuity/location'],
  run(ctx) {
    const { canon, timeline, chapters, mentions, add } = ctx;
    const locations = new Map();
    for (const e of asArray(canon.entities)) if (e.type === 'location') locations.set(e.id, e);
    for (const t of timeline) {
      if (!t.location) continue;
      const assigned = locations.get(t.location);
      if (!assigned) continue;
      const ch = chapters.find((c) => c.number === t.chapter);
      if (!ch) continue;
      const m = mentions.get(t.location);
      const assignedCount = m ? (m.byChapter.get(ch.index) || 0) : 0;
      if (assignedCount > 0) continue;
      let suspect = null;
      for (const [id, ent] of locations) {
        if (id === t.location) continue;
        const mm = mentions.get(id);
        const cnt = mm ? (mm.byChapter.get(ch.index) || 0) : 0;
        if (cnt >= 2) {
          suspect = {
            ent,
            cnt,
            line: mm.firstLineByChapter.get(ch.index) || ch.headingLine,
          };
          break;
        }
      }
      if (suspect) {
        add('continuity/location', 'warning', suspect.line, t.chapter,
          `时间线设定本章地点为「${assigned.name}」，但正文未提及，反出现「${suspect.ent.name}」${suspect.cnt} 处`,
          '若为有意的地点变动，请更新 canon.json 的 timeline.location，或在正文补写地点交代');
      }
    }
  },
};

// ================= 规则 7 · 知识提前使用（L1） =================
// 句级启发式：同一句内同时出现「知情者 + 知识特征词」
const ruleKnowledgePremature = {
  id: 'knowledge/premature',
  layer: 'L1',
  name: '知识提前使用',
  emits: ['knowledge/premature'],
  run(ctx) {
    const { canon, chapters, parsed, add } = ctx;
    for (const k of asArray(canon.knowledge)) {
      if (k.known_from_chapter === undefined || k.known_from_chapter <= 0) continue;
      const terms = asArray(k.terms).filter((t) => t);
      if (!terms.length || !asArray(k.holders).length) continue;
      const holderNames = new Set();
      for (const h of k.holders) {
        const e = asArray(canon.entities).find((x) => x.id === h);
        if (e) {
          holderNames.add(e.name);
          asArray(e.aliases).forEach((a) => holderNames.add(a));
        }
      }
      const found = new Set(); // holder|term 去重
      for (const ch of chapters) {
        if (ch.number === null || ch.number >= k.known_from_chapter) continue;
        for (let li = ch.startLine - 1; li < ch.endLine; li++) {
          const line = parsed.lines[li];
          if (isSuppressLine(line)) continue; // 豁免注释不参与句级扫描
          for (const seg of line.split(/[。！？；]/)) {
            for (const h of holderNames) {
              if (!seg.includes(h)) continue;
              for (const t of terms) {
                if (!seg.includes(t)) continue;
                const key = `${h}|${t}`;
                if (found.has(key)) continue;
                found.add(key);
                add('knowledge/premature', 'warning', li + 1, ch.number,
                  `「${h}」在获得知识前使用了「${t}」：known_from_chapter=${k.known_from_chapter}（第${ch.number}章）`,
                  '若为有意为之（如伪装知情、误用），请在 canon.json 调整 knowledge.known_from_chapter');
              }
            }
          }
        }
      }
    }
  },
};

// ================= 规则 8 · 闲置实体（L3，dead code） =================
const ruleEntityMissing = {
  id: 'entity/missing',
  layer: 'L3',
  name: '闲置实体',
  emits: ['entity/missing'],
  run(ctx) {
    const { canon, mentions, lastChapterNumber, add } = ctx;
    for (const e of asArray(canon.entities)) {
      const m = mentions.get(e.id);
      const total = m ? m.total : 0;
      const due = e.appears_from_chapter !== undefined && e.appears_from_chapter <= lastChapterNumber;
      if (total === 0) {
        if (due) {
          add('entity/missing', 'warning', 1, e.appears_from_chapter,
            `「${e.name}」设定于第${e.appears_from_chapter}章起出场，但全稿未提及`,
            '闲置角色/物件：若已放弃该线索，请从 canon.json 删除或标注；若规划未到期，请调整 appears_from_chapter');
        } else if (e.type === 'character' && e.appears_from_chapter === undefined) {
          add('entity/missing', 'info', 1, null,
            `角色「${e.name}」从未出场`,
            '若为规划中的角色，请在 canon.json 标注 appears_from_chapter');
        }
      }
    }
  },
};

// ================= 规则 9 · 承诺台账（L3，悬念） =================
const ruleSuspenseLedger = {
  id: 'suspense/overdue',
  layer: 'L3',
  name: '承诺台账（悬念）',
  emits: ['suspense/unplanted', 'suspense/order', 'suspense/planned', 'suspense/dangling', 'suspense/overdue'],
  run(ctx) {
    const { canon, lastChapterNumber, cfg, add, headingLineOf } = ctx;
    for (const s of asArray(canon.suspense)) {
      const planted = s.planted_in_chapter;
      const resolved = s.resolved_in_chapter;

      if (resolved !== undefined && resolved !== null && planted === undefined) {
        add('suspense/unplanted', 'error', headingLineOf(resolved), resolved,
          `悬念「${s.name}」已回收（第${resolved}章）但未记录埋设章`,
          '因果倒置：请在 canon.json 中补 planted_in_chapter');
      }
      if (planted !== undefined && resolved !== undefined && resolved !== null && resolved < planted) {
        add('suspense/order', 'error', headingLineOf(planted), planted,
          `悬念「${s.name}」回收章（第${resolved}章）早于埋设章（第${planted}章）`);
      }
      if (planted === undefined) continue;

      if (resolved !== undefined && resolved !== null && resolved > lastChapterNumber) {
        add('suspense/planned', 'info', headingLineOf(planted), planted,
          `悬念「${s.name}」埋设于第${planted}章，预期第${resolved}章回收（未到期）`);
        continue;
      }

      if (resolved === undefined || resolved === null) {
        add('suspense/dangling', cfg.danglingSeverity, headingLineOf(planted), planted,
          `悬念「${s.name}」埋设于第${planted}章，至文末（第${lastChapterNumber}章）仍未回收`,
          '连载中悬置属正常；完本前请确保回收或显式放弃（在 canon.json 删除该条目）');
      }

      // 已回收的悬念不再做超期检查
      if (resolved !== undefined && resolved !== null && resolved <= lastChapterNumber) continue;

      // 悬置超期：登记了预期回收章但已过期（expected ≤ 当前进度）的，或未登记预期而长期悬置的，都要报
      const expected = s.expected_resolve_chapter;
      const hasExpected = expected !== undefined && expected !== null;
      // 预期回收章在未来（> 当前进度）说明仍处于规划期，未到期不报超期
      if (hasExpected && expected > lastChapterNumber) continue;
      const overdue = lastChapterNumber - planted;
      if (overdue > cfg.overdueLimit) {
        const anchor = hasExpected ? expected : planted;
        add('suspense/overdue', 'warning', headingLineOf(anchor), anchor,
          `悬念「${s.name}」埋设于第${planted}章，已悬置 ${overdue} 章，超过阈值 ${cfg.overdueLimit}（${cfg.label}）`,
          hasExpected
            ? `预期回收章：${expected} —— 已过预期仍未回收，建议安排回收或调整预期`
            : '未登记预期回收章 —— 建议在 canon.json 补 expected_resolve_chapter，或安排回收');
      }
    }
  },
};

// ---------- 规则注册表（执行顺序即问题输出顺序，勿乱序） ----------
const RULES = [
  ruleChapterOrder,
  ruleQuoteBalance,
  ruleChapterLength,
  ruleTimelineRegression,
  ruleTimelineCoverage,
  ruleTimelineGhost,
  ruleContinuityLocation,
  ruleKnowledgePremature,
  ruleEntityMissing,
  ruleSuspenseLedger,
];

// ---------- 顶层入口 ----------
// 一次性派生共享数据后，依序执行注册表。签名保持 { canon, parsed, mentions, quotes, cfg, file } 不变，
// 保证 compile.js 与既有测试（场景 45b 直调 runChecks、asArray 兜底测试）零改动兼容。
function runChecks({ canon, parsed, mentions, quotes, cfg, file }) {
  const problems = [];
  const add = (rule, severity, line, chapter, message, detail = '') =>
    problems.push({ rule, severity, file, line, chapter, message, detail });

  const chapters = parsed.chapters;
  const lastChapterNumber_ = lastChapterNumber(chapters);
  const headingLineOf = (number) => {
    const ch = chapters.find((c) => c.number === number);
    return ch ? ch.headingLine : 1;
  };

  const timeline = asArray(canon.timeline).slice().sort((a, b) => a.chapter - b.chapter);
  const chapterNumbers = new Set(chapters.filter((c) => c.number !== null).map((c) => c.number));

  const ctx = { canon, parsed, mentions, quotes, cfg, file, problems, add, chapters, lastChapterNumber: lastChapterNumber_, headingLineOf, timeline, chapterNumbers };
  for (const rule of RULES) rule.run(ctx);
  return problems;
}

// ---------- 元数据视图（供 wjrc / manifest 消费，单一来源防漂移） ----------
// 合法规则 id 全集 = 每条规则 emits 声明的 rule id 并集。
// .wjrc.json 的 rules 键若命中此集合之外的值，即为未知规则（拼写错误 / 已下线规则），应警告而非静默。
const LEGAL_RULE_IDS = [...new Set(RULES.flatMap((r) => r.emits))];
// id -> 规则名 / 层级（同一 rule id 只会被一条规则 emit；若未来多条 emit 同 id，取先注册者）
const RULE_NAMES = {};
const RULE_LAYERS = {};
for (const r of RULES) {
  for (const e of r.emits) {
    if (RULE_NAMES[e] === undefined) RULE_NAMES[e] = r.name;
    if (RULE_LAYERS[e] === undefined) RULE_LAYERS[e] = r.layer;
  }
}

module.exports = { runChecks, RULES, LEGAL_RULE_IDS, RULE_NAMES, RULE_LAYERS };
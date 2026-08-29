# novel-compiler review 报告

> 第六轮 review · 2026-08-25 · 测试基线 365/365 → 371/371

---

## 测试基线

| 阶段 | 通过 / 总数 | 备注 |
|---|---|---|
| 起点 | 365 / 365 | 用户修复后交回 |
| 本轮 | 371 / 371 | 新增 6 项 asArray 兜底单测，全绿 |

---

## 验证上轮项（已修复）

| 类别 | 旧问题 | 本轮状态 |
|---|---|---|
| `asArray` 抽象 | `src/review.js / extraction.js / incremental.js / validate.js` 统一 | ✓ 仍生效，无回退 |
| 浏览器端手动同步 | `app/public/app.js` 顶部 `asArray` 与 `src/canon.js` 同步 | ✓ 仍生效 |
| `timeline` 排序 | `applyReview` 末尾 `.sort((a,b) => a.chapter - b.chapter)` | ✓ 保留 |
| `chapter` 兼容 | 决定 key 用 `d.id ?? d.chapter` | ✓ 保留 |
| `parseError` | `app/config-util.js` 损坏 config 标记 | ✓ 保留 |
| 死代码 | `chatJSON` 删除 | ✓ 未回退 |
| `errors.slice(0, 5)` | `app/server.js` 多错展示 | ✓ 保留 |

---

## 本轮新做的事

### 🔴 P0: 全项目统一 `|| []` → `asArray`（34 处）

之前只在 `review / extraction / incremental / validate` 用了 `asArray`，**核心数据通路**（`rules.runChecks / diff.diffCanons / report.buildSnapshot / outline.syncReport / compile / simulate / extract-llm`）仍散落 `|| []`。

`|| []` 是单点防御：只能挡 `null/undefined/0/""`，但挡不住 truthy 非数组。例如 `canon = { entities: "oops", timeline: null, suspense: { a:1 } }` 时：
- `"oops".forEach` → TypeError
- `{a:1}.map` → TypeError
- `null.reduce` → TypeError

**用户场景**（手工编辑 canon.json 错填、合并脚本产出非数组、上游 schema 漂移）就会让整条 compile 流水线崩 500，看不到任何 problem。

#### 改动清单

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/diff.js` | 5 | `toMap / indexByName / maxTimelineChapter / k.holders / a.holders` |
| `src/rules.js` | 5 | `timeline / locations / 知识提前使用 / 闲置实体 / 承诺台账` |
| `src/report.js` | 5 | `buildSnapshot` 三段 + `renderJson` 兜底 suppressed/unused_suppressions |
| `src/outline.js` | 1 | `syncReport` 时间线 |
| `src/extract.js` | 2 | `scanMentions` entities + aliases |
| `src/review.js` | 2 | `evidence` 兜底（顺手简化 `ev[section] && ev[section][item.id] \|\| []` → `asArray(...)`） |
| `compile.js` | 4 | 入口 + 三处 .length |
| `simulate.js` | 2 | 权威基线保留检查 |
| `extract-llm.js` | 2 | baseS / suspenseDrop filter |

#### 新增 6 项单测（test/run-tests.js）

```
✓ runChecks 非数组 canon 不抛（asArray 兜底）
✓ diffCanons 非数组 canon 不抛（asArray 兜底）
✓ buildSnapshot 非数组 canon 不抛（asArray 兜底）
✓ syncReport 非数组 canon 不抛（asArray 兜底）
✓ renderText 非数组 suppressed/unused_suppressions 兜底为 0
✓ renderJson 非数组 suppressed/unused_supensions 兜底为 []
```

外加 1 个 README 快照同步（365 → 371）。

---

## 挖到但本轮不动的问题

### 🟡 准 P1：`rawLines` 不是死字段

`src/extract.js:42-43 / 77` 同时返回 `lines` 和 `rawLines`：
- `lines` 经 `normalizeSuppressBlocks` 原地替换（跨行豁免注释续行 → 占位行）
- `rawLines` 是 BOM 剥除后、归一化前的真原始行

`suppress.js` 注释明确「compile 传 `parsed.rawLines`」——必须用原始行才能让跨行豁免注释的原始字符在 `parseSuppressions` 整行匹配。**当前用法是必要的，不删**。

### 🟢 错判后已撤销的「问题」

- ~~`app.js:266 jumpTo` 对 `p.line=null` 触发 Monaco RangeError~~：经核实 `state.problems` 来源是 `rules.runChecks`，所有 problem 的 `line` 字段都是 1 或 headingLine，不会传 `null`。撤销。

---

## 改动文件汇总

```
M  README.md                                       (+1, -1)
M  compile.js                                      (+5, -4)
M  extract-llm.js                                  (+3, -2)
M  simulate.js                                     (+2, -1)
M  src/diff.js                                     (+5, -4)
M  src/extract.js                                  (+2, -1)
M  src/outline.js                                  (+2, -1)
M  src/report.js                                   (+6, -4)
M  src/review.js                                   (+3, -3)
M  src/rules.js                                    (+6, -5)
M  test/run-tests.js                               (+31, -1)
```

净增：约 30 行（含 6 个新单测 + 全部 `asArray` import）。

---

## 总评

| 维度 | 评价 |
|---|---|
| 整体质量 | 7/10 → 8/10 |
| 防御一致性 | 6/10 → 9/10（核心数据通路统一 asArray） |
| 测试覆盖 | 365 → 371（+6 项 asArray 兜底单测） |
| 死代码 | 0 |
| 对称性 | canon 数组访问对称，跨文件一致 |

建议下一轮可考虑：
- `app/public/app.js` 的 `asArray / CANON_SECTIONS_ALL / cnToInt / HEADING_RE` 4 处「与 src 手动同步」注释可改为 build 阶段打包（Vite/esbuild）消除漂移风险；
- `rules.runChecks` 的 9 段规则可拆成独立函数 + 注册表（目前单函数 200+ 行，单元粒度稍粗）；
- `compile.js / extract-llm.js / simulate.js` 三处 spawn 子进程逻辑（args 拼装 + 流式输出 + 超时 + 退出码映射）可抽到 `src/runner.js`，避免三处并行维护。

加油！💪

# 文检 novel-compiler  V 0.4.4

小说「编译器」：**手稿 + canon JSON → 带行号的 problems 报告**，外加 **AI 模拟器（动笔前预测）+ LLM 提取器（正文→设定，自动检查）+ 机械比对器（防漂移）**。

把软件工程的编译/质检思维搬进小说创作：你不是在"写"，是在"产出代码"；正文是源码，canon 是运行时状态，检查器是编译器，模拟器是设计评审，提取器是自动插桩，比对器是回归测试。**你永远是唯一的生产设备，AI/工具只做质检和路径规划。**

```
node compile.js    <手稿.md> <canon.json> [--reader ...] [--json]     # 编译：正文 vs 设定 → problems
node simulate.js   <outline.md> [--premise ...] [--canon ...] [...]   # 模拟：大纲 → 预测 canon + 风险登记册
node extract-llm.js <手稿.md> [--canon ...] [...]                     # 提取：正文 → 提议 canon（带行号证据）
node compare.js    <预测/提取.json> <实际.json> [--json]               # 比对：预测 vs 实际 → 漂移报告
node rebase.js     <预测.json> <实际.json> [--force] [--dry-run]      # rebase：漂移检测 → 自动以实际重模拟
node refactor.js    <手稿.md> <canon.json> <outline.md> <premise.md> # 重构：文稿先行，逆推并重写 canon/outline/premise
```

退出码：`0` = 无 error 级问题 · `1` = 存在 error/警告级偏差（rebase 语义：1 = 漂移已处理）· `2` = 输入/canon 校验错误。

## LLM 供应商（v0.4.4+ 多供应商适配层）

所有 AI 工具（simulate / extract-llm / refactor / rebase / IDE 的模拟/提取/重构/重规划）走统一的 OpenAI 兼容 `chat/completions` 协议，通过 `src/providers.js` 可插拔多供应商：

| 供应商 | 选择方式 | API key 环境变量 | 默认模型 |
|---|---|---|---|
| DeepSeek（默认） | 不设或 `LLM_PROVIDER=deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| OpenAI | `LLM_PROVIDER=openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Moonshot（Kimi） | `LLM_PROVIDER=moonshot` | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |
| 通义千问 | `LLM_PROVIDER=qwen` | `DASHSCOPE_API_KEY` | `qwen-plus` |
| 智谱 GLM | `LLM_PROVIDER=zhipu` | `ZHIPUAI_API_KEY` | `glm-4-plus` |
| Ollama（本地） | `LLM_PROVIDER=ollama` | 无需鉴权 | `llama3.1` |

切换三原则：
1. **显式优先**：`LLM_PROVIDER=xxx` 最优先（config.json 顶层 `provider` 字段在 IDE 场景等效）。
2. **自动推断**：未显式指定时，按"哪个供应商的 API key 已设置"自动挑选（仅设了 `MOONSHOT_API_KEY` → 自动用 Moonshot）；都不设 → 回退 DeepSeek（历史行为）。
3. **通用覆盖**：`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 对任意供应商生效（接自定义 OpenAI 兼容网关）；`<PROVIDER>_BASE_URL` / `<PROVIDER>_MODEL` 覆盖该供应商默认值。

向后兼容不变：只设 `DEEPSEEK_API_KEY`（无 `LLM_PROVIDER`）仍是纯 DeepSeek 行为。未知供应商属配置错误，明确报错而非静默回退。

## 完整工作流（工业流水线）

```
① 写大纲 → ② simulate 模拟（预测 canon + 风险登记册）
      ↓
③ 动笔写第 N 章（你是唯一生产设备）
      ↓
④ extract-llm 提取（正文 → 提议 canon，每条设定带行号证据，反幻觉校验）
      ↓
⑤ 人工审阅合并（接受/修正提议，更新实际 canon —— AI 提议、人确认）
      ↓
⑥ compile 编译（正文 vs 实际 canon → 带行号 problems）→ 断点修复
      ↓
⑦ rebase（漂移检测 → 自动以实际 canon 重新模拟，新预测记录本次漂移）
      ↓
⑧ 循环 ③-⑦
```

模拟不是剧情强制，是**情景规划**：预测 canon 是参考轨迹，写偏了不是错——rebase 之后继续。

## 重构（refactor.js）—— 敏捷开发工具：文稿先行

```
node refactor.js <手稿.md> <canon.json> <outline.md> <premise.md> [--reader ...] [--model ...] [--title <书名>] [--extract-out <信封.json>] [--dry-run]
```

**重构 = 文稿先行，从正文逆推并重写 canon / outline / premise**，为后续 编译/审阅/比对/重规划 服务（IDE 里是编译键旁的「重构」键）。三段流水线：

1. **① canon**：extract-llm 基线保留提取，直接写回（`--canon-out` 原子写）
2. **② 大纲回写**：正文 → as-built 章节大纲（覆盖全部实际章节，缺章自动重试）
3. **③ 前提回写**：正文 → 世界规则 / 角色初始状态 / 基调与风格 / 核心冲突与悬念策略

**同步保障（v0.3.2）**：
- **僵尸清理**：换作品/大改后，正文零提及且已到期的实体/知识自动移除（依赖感知：实体 → 知识 → 时间线联动；时间线引用的地点实体豁免）；悬念退役由提取模型同轮判断（`retired.suspense`，校验只允许基线 id）
- **书名/题材对齐**：meta 与正文一致（不沿用旧书名）；重构末尾以大纲为准确定性对齐 canon 书名
- **时间线完整性**：时间线必须覆盖正文全部章节（缺章 → 自动重试），清理永不破坏每章一条
- **同步检查**：重构后跨文件检查（正文/canon/大纲的章节集合 + 大纲/前提/canon 书名一致性），问题逐条列出
- **安全**：写文件前自动备份为 `<文件>.bak-<时间戳>`（每个文件仅保留最近 5 个，`--backup-keep` 可调，超出自动清理）；全部原子写；任一段失败即中止（不半写）。
- **超时保护**：所有工具进程受 `TOOL_TIMEOUT_MS` 约束（默认 20 分钟，覆盖 LLM 重试最坏情况）——挂起的 LLM 调用不会无限阻塞，超时自动终止并返回明确错误。
- 需要逐条审阅 canon 变更？用 IDE ⑤ 审阅（重构同时把提议信封写到 `--extract-out`）。
- 注：重构覆盖 outline/premise 为"实际剧情版"（as-built），原计划文档保留在 .bak 备份中。

## rebase 自动化（rebase.js）

```
node rebase.js <预测.json> <实际.json> [--out <file>] [--force] [--dry-run] [--outline ...] [--premise ...]
```

- **一条命令完成**：漂移检测（diffCanons）→ 有警告级漂移时自动以「实际 canon」为基线重跑模拟 → 新预测写入 `<预测>.rebase.json`（`--out` 指向预测文件本身时旧预测先备份 `.bak-*` 再覆盖——IDE 的 rebase 按钮走此路径，风险面板/比对/审阅直接指向新预测）。
- **输入自动推导**：预测信封的 meta 记录了它自己的 `source_outline` / `source_premise` / `target_reader`，无需重复指定（也可用 `--outline` 等覆盖）。
- **漂移门控**：仅警告级偏差触发 rebase；提示级差异跳过（`--force` 可强制）。
- **历史可追溯**：新预测 meta.rebase 记录 `{ of, drift_warnings, drift_infos, at, reason }`。
- 退出码：`0` = 无需 rebase（预测仍有效）· `1` = 漂移已处理，rebase 成功（评审新预测）· `2` = 错误；`--dry-run` 只预览漂移摘要与将执行的命令。

## 快速开始

```bash
node compile.js examples/manuscript.md examples/canon.json --reader webnovel   # 示例（as-built 演示：《风雪破庙》，与正文一致，无内置问题）
node compile.js test/fixtures/demo-manuscript.md test/fixtures/demo-canon.json --reader webnovel   # bug 演示：《雾都迷踪》内置 7 类问题（exit 1）
node compile.js examples/manuscript.md examples/canon.json --json > report.json # 机器可读输出
node test/run-tests.js   # 冒烟测试（833 项断言）

# 模拟 + 提取 + 比对（需要 DEEPSEEK_API_KEY 环境变量）
node simulate.js examples/outline.md --premise examples/premise.md --canon examples/canon.json --reader webnovel --out predictions/wumizongji-pred.json
node extract-llm.js examples/manuscript.md --canon examples/canon.json --reader webnovel --out predictions/wumizongji-extract.json
node compile.js examples/manuscript.md predictions/wumizongji-extract.json   # 用提取的提议 canon 自动检查
node compare.js predictions/wumizongji-pred.json examples/canon.json
```

`test/fixtures/demo-manuscript.md` 是一篇故意埋了 bug 的 5 章短篇（《雾都迷踪》），`test/fixtures/demo-canon.json` 是配套设定（即"实际 canon"），`test/fixtures/demo-project/` 下有配套的 outline + premise（写它之前的计划）。完整闭环实测效果：
- **模拟器**自己预测出 canon 里的信息差矛盾（known_from_chapter 与大纲不符）并给出 R1 high 风险；
- **提取器**产出带行号证据的提议 canon，`compile` 自动抓出知识提前使用、闲置角色（周建国）、悬念超期；
- **比对器**把第 5 章时间回退（正文时序第4天 vs 设定第2天）报为漂移。

> 注：`examples/` 目录是重构流水线跑出的 **as-built 演示**（《风雪破庙》：正文/canon/大纲/前提 四件套一致，编译零问题），用于展示"写完 → 重构 → 一致"的成果形态；想看规则引擎检错效果请用上面的 demo 夹具。

## 手稿格式

- Markdown 或纯文本分章，两种标题都支持：`# 第1章 标题` 与纯文本 `第1章 标题`（也支持 `第 1 章`、中文数字 `第一章`、`楔子/序章/尾声/番外/后记`）。
- 行号以文件真实行号为准，problems 里的 `file:line` 可直接跳转定位。
- 规则按章节作用域检查：地点、时间、知识、悬念都以"章"为最小单位。
- 无任何章节标题时给出友好提示（两种格式）。

## canon 格式（手写设定库）

| 字段 | 内容 | 说明 |
|---|---|---|
| `meta.title` | 书名（必填） | |
| `meta.target_reader` | `webnovel` / `genre` / `published` | 读者向，决定规则阈值；可用 `--reader` 覆盖 |
| `entities[]` | `id, name, aliases[], type(character/location/item), appears_from_chapter?` | 角色/地点/物件。**appears_from_chapter 声明"该角色应从第几章起出场"**，用于闲置检测 |
| `knowledge[]` | `id, name, terms[], holders[], known_from_chapter` | 关键信息的知识状态机。`terms` 是**知识专属特征词**（见下），`holders` 是知情者实体 id，`known_from_chapter` 是获知章 |
| `suspense[]` | `id, name, planted_in_chapter, expected_resolve_chapter?, resolved_in_chapter?` | 承诺台账（悬念=接口契约：埋设/预期回收/实际回收） |
| `timeline[]` | `chapter, day, location?` | 剧情时间线：`day` 为剧情内第几天（整数），`location` 引用实体 id |

### 知识特征词的选取（重要）

`terms` 必须是"只有获得该知识才会说/用的话"，而不是泛指的物品名。例如：

- ❌ `terms: ["铜钟"]` —— 角色只是"看见"铜钟，不算知道"钥匙藏在暗格里"
- ✅ `terms: ["暗格", "黄铜钥匙"]` —— 提到这两样才说明他动用了知识

特征词太泛会导致误报（狼来了效应），太窄会漏报。建议：**知识 = 名词 + 动作的组合短语**。

## 规则参考

| 规则 id | 层 | 级别 | 读者向敏感 | 含义 |
|---|---|---|---|---|
| `text/chapter-order` | L0 | error / info | — | 章节编号未递增 / 跳号 |
| `text/quote-balance` | L0 | info | — | 引号开闭不配对 |
| `structure/chapter-length` | L0 | info | 阈值不同 | 章节过短 / 过长 |
| `timeline/regression` | L1 | **error** | — | 剧情时间回退（day 变小） |
| `timeline/missing` | L1 | info | — | 章节缺少时间线条目 |
| `timeline/ghost` | L1 | warning | — | canon 时间线有条目但手稿没有该章（删章后未同步） |
| `timeline/planned` | L1 | info | — | 时间线覆盖到未来章节（规划中） |
| `continuity/location` | L1 | warning | — | 设定地点未提及而其他地点高频出现 |
| `knowledge/premature` | L1 | warning | — | 角色在获知章之前使用知识 |
| `entity/missing` | L3 | warning / info | — | 设定角色从未出场（dead code） |
| `suspense/unplanted` | L3 | **error** | — | 先回收后埋设（因果倒置） |
| `suspense/order` | L3 | **error** | — | 回收章早于埋设章 |
| `suspense/overdue` | L3 | warning | 阈值 3/5/8 | 悬念悬置超过读者向阈值 |
| `suspense/dangling` | L3 | info / warning / error | 网文=info 类型=warning 出版=error | 文末仍未回收 |
| `suspense/planned` | L3 | info | — | 预期未来章回收（未到期） |

### 阈值（按读者向）

| 读者向 | 悬置阈值（章） | 文末悬置 | 章节字数范围 |
|---|---|---|---|
| `webnovel`（网文/连载） | 3 | info（连载正常） | 100–10000 |
| `genre`（类型小说） | 5 | warning | 100–15000 |
| `published`（出版向） | 8 | **error** | 100–20000 |

## 豁免机制（wj-suppress）

有些"违规"是故意的（对话中断、埋伏笔的角色暂不登场）。在正文里用 HTML 注释声明，编译时对应问题不再计入计数与退出码：

```markdown
<!-- wj-suppress: text/quote-balance 故意话没说完 -->       行级：应用于下一个内容行（必须单行）
<!-- wj-suppress: entity/missing @chapter 本章暂缓登场 -->   章级：应用于所在章（含楔子、尾声/番外）
<!-- wj-suppress: entity/missing @global 角色暂缓登场 -->    全稿级：豁免该规则所有无章归属（chapter=null）的问题
```

- 豁免的问题进入独立的「⊘ 已豁免」分组（带理由，可审计），`--json` 输出 `suppressed[]` 与 `counts.suppressed`。
- **未命中的豁免**单独报告（`unused_suppressions[]`）：规则 id 写错、位置移动、或问题已消失时提醒你清理注释。
- **反馈准确性**：机制无法生效的注释会明确标记而非伪装成"没有对应问题"——**豁免注释必须单行**（跨行注释不产生豁免，续行也不计入正文）；行级注释后没有正文行、章级注释不在任何章节内时，未命中报告会给出对应的具体原因。
- **全稿级问题**（无章归属，如 `entity/missing` 的"从未出场"提示 chapter=null）：必须用显式 `@global` 豁免。`@chapter` 只作用于所在章，不覆盖全稿级问题——旧版"任一 `@chapter` 即视为全局豁免"会为某一章的豁免连带静默全稿同类提示（规则级豁免过度）；误用 `@chapter` 豁免全稿级问题时，未命中报告会提示改用 `@global`。
- 豁免注释是元数据而非正文：不计入提及扫描 / 引号统计 / 字数，不发给提取 LLM，增删注释不会把章节标脏（增量提取不受影响；跨行注释的续行同样不进入正文统计）。
- `--json` 输出 `unused_suppressions[]`（含 `multiline` / `unresolvable` 标记）；文本报告显示 `ℹ 未命中的豁免 (N)` 并区分原因。

## 个人规则库（.wjrc.json）

不想每次用 `--reader` 或注释调规则？放一个 `.wjrc.json`，compile 与 simulate 自动读取（就近优先）。查找顺序：**手稿/大纲所在目录 → canon 所在目录 → 当前工作目录**——同一项目的 `.wjrc.json` 放在任意一个工作文件目录（手稿、大纲或 canon）旁即可，两个工具口径一致：

```json
{
  "rules": {
    "text/quote-balance": "off",
    "entity/missing": "error",
    "knowledge/premature": { "severity": "warning" }
  },
  "thresholds": { "overdueLimit": 4, "chapterMin": 200, "chapterMax": 8000, "danglingSeverity": "info" }
}
```

- `rules`：`"off"` 关闭该规则；`"error" | "warning" | "info"` 改写级别；对象形式 `{ "enabled": false }` / `{ "severity": "..." }` 等价。**合法规则 id 与规则注册表一致（见 `src/rules.js`）**；写错/已下线规则 id 会警告并忽略，`manifest.wjrcInvalid.rules` 列出，杜绝拼错后静默失效。
- `thresholds`：覆盖读者向默认阈值（悬置阈值、章节字数上下限、文末悬置级别）；非法值（非整数、负阈值、未知级别）自动回退读者向默认；**未知键会警告并忽略**并由 `manifest.wjrcInvalid.thresholds` 列出，不会导致规则失效。
- 编译输出 `manifest.wjrc` 指明实际生效的配置文件，未知规则/阈值键以 `manifest.wjrcInvalid` 暴露；解析失败仅警告并忽略，不影响编译。

## 模拟器（simulate.js）—— AI 先行

```
node simulate.js <outline.md> [--premise <premise.md>] [--canon <canon.json>] [--reader ...] [--out <file.json>] [--json] [--dry-run] [--model ...]
```

- 输入：大纲（必填）、前提设定（世界规则/角色初始/风格基线）、**已有 canon 作为权威基线**、目标读者（缺省取 `canon.meta.target_reader`，再缺省 genre——与 compile 口径一致）。
- 输出（信封 JSON）：`canon`（预测设定库，**与手写 canon 同一 schema**，已自动通过 schema 校验）+ `risk_register`（风险登记册：每条含 severity/kind/概率/触发条件/对策）+ `simulation_notes`（模拟假设）。
- **--canon 基线语义**：已有 canon 中的全部条目（按 id）必须原样保留，模型只做补全（timeline）、修正（字段值）和预测性增补——保证预测与你的建模同构，比对才有意义。
- **自修复循环**：输出未通过 schema 校验时，自动把错误清单喂回模型重试（最多 3 轮）——这就是"编译-修复"循环在模拟侧的实现。
- 模型：默认 `deepseek-chat`（快速、JSON 原生）。推理模型（`deepseek-v4-flash`）可用但慢（会把大量预算花在 reasoning 上），`src/llm.js` 会在 content 为空时自动加倍 max_tokens 重试。环境变量：`DEEPSEEK_API_KEY`（必填）、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`LLM_TIMEOUT_MS`（单次 LLM 调用超时，缺省与 max_tokens 预算挂钩）、`LLM_INPUT_BUDGET_TOKENS`（输入预算，缺省 48000，超限时模拟/重构给出警告）、`LLM_MODEL_CONTEXT_TOKENS`（模型上下文上限，缺省 128000；输入硬护栏 = min(预算 × 3, 该值)，护栏不随预算水涨船高——超限调用在发起前被拒绝 exit 2，分块模式下必败批次也在规划期被拒）。`--dry-run` 只打印提示词，不调 LLM。

## 提取器（extract-llm.js）—— 自动插桩

```
node extract-llm.js <手稿.md> [--canon <基线canon.json>] [--from <章> --to <章>] [--incremental --merge-with <上次提取.json>] [--reader ...] [--out <proposed.json>] [--resume] [--json] [--dry-run] [--model ...]
```

- 输入：正文（必填）、基线 canon（已有设定，必须保留其全部条目 id/name）、目标读者。
- 输出（信封 JSON）：`canon`（提议设定库，与手写 canon 同一 schema）+ **`evidence`（逐条证据：每条新增设定和每章时间线都带 行号+引文）** + `extraction_notes`。
- **反幻觉校验（确定性）**：引文必须逐字命中对应行（容忍省略中文引号字符）、行号必须在手稿范围内、行号必须落在声明的章范围内、非基线条目必须有证据、**基线条目的任何字段修正也必须有证据**（未修正的基线条目不强制，作者权威）、基线条目不得缺失。校验失败自动喂回模型重试。
- **增量提取（--incremental）**：对比上次提取信封的 `chapter_hashes` 自动检测脏章节，只把脏章行号化文本发给 LLM；**合并判据是字段级变化**（不看你条目的埋设章是否脏）——悬念在第 2 章埋设（干净）但在脏章 8 回收，`resolved_in_chapter` 照样正确更新；证据合并：变更/新条目替换、未变条目保留。**无脏章节时走快速路径**（不调 LLM，直接输出基线+旧证据）。`--merge-with` 缺失（首次运行）自动退化为全量提取；**缺省 `--merge-with` 取 canon 同目录的 `last-extract.json`**（按项目隔离，CLI 多项目互不污染）。全量提取也会记录 chapter_hashes，保证下一次增量精准。**尾声/番外/后记（无编号章）同样纳入哈希**——修改番外会正确触发增量提取（脏章键显示为 `s<标题哈希>`，标题是稳定身份，章节增删不误报）。
- **范围运行时哈希不"洗白"未提取章**：`--from/--to` 范围提取与自动分块检查点的输出哈希**只写已提取章的哈希**，未提取章沿用 `--merge-with` 的旧哈希（无旧哈希则不写键——下次增量对缺失键天然判脏）。这保证了"先提一部分 → 之后增量"的流程里，没提过的章**永远会被判脏重新提取**，不会因全文哈希被写入而永久缺失（分块断点续跑：分块提取每批完成自动写 `<out>.partial` 检查点，失败/中断后原命令加 `--resume` 即可从失败批续跑，跳过「已完成且手稿未变更」的整批；检查点后被修改的章按哈希判脏重新提取，成功收尾后检查点自动清理）。**范围外章的 evidence 证据同样继承**（`--merge-with` 的旧证据 + 本次新证据合并），范围推进后旧章的证据引文不丢。
- **手动范围（--from/--to）**：只提取指定章节范围（范围外条目一律按基线保留）。章号必须 ≥1 且 `--from ≤ --to`，非法输入直接退出 2；`--from`/`--to` 可只给其一（缺省分别为第 1 章与文末）。
- **自动分块（全量提取）**：无 `--from/--to`、且已有基线时，若"正文+基线"估算超输入预算（`LLM_INPUT_BUDGET_TOKENS`，缺省 48000），自动按章分批调用并逐批合并（与增量提取同一字段级合并语义；`meta.auto_chunked` 记录批次；分块模式跳过僵尸清理与悬念退役判断——单批看不到全文，跨批退役不可靠）。**同样覆盖增量首次/退化路径**（`--merge-with` 缺失或旧版产物无哈希 → 等效全量 → 同样自动分块，长稿不会静默超上下文）。**无基线超预算时**给出提示（分块需要基线背书，范围外章节靠基线携带）：先建最小 canon 基线，或用 `--from/--to` 分次提取（每次用上次输出做基线）。
- **变更摘要**：输出 vs 基线的"新增条目 + 字段修正"清单，供作者一键审阅（AI 提议、人确认——state 可靠性的地基）。
- 提取出的提议 canon 可直接喂给 `compile.js`（compile 已支持信封输入），实现"写完正文 → 自动检查"的全自动链路。
- 低温（temperature 0.3）保证事实还原。
- **跨进程写锁（防并发互相覆盖）**：所有写共享输出的工具（`extract-llm`、`simulate`、`refactor`、`rebase`）在解析参数后对输出文件（`--out` / `--canon-out` / `--extract-out` / 重构的 outline·premise·canon）获取 `<输出>.lock` 排他锁，覆盖整个运行（含分块检查点与最终写入）。CLI 直接运行与 IDE（spawn 同一 CLI）并发写同一共享输出（如 `last-extract.json`、`last-pred.json`、canon.json）时，原子写只防损坏、不防"计算几分钟后互相覆盖"——后到者**快速失败（exit 2）并给出明确提示**，而非白算后静默覆盖。进程退出时自动释放；崩溃遗留的陈旧锁按 mtime 超时自动回收（阈值随 `TOOL_TIMEOUT_MS` 派生：`max(30 分钟, 超时 × 1.5)`，默认 30 分钟——超时调高后合法长运行不会被误判陈旧），可删除 `<输出>.lock` 手动兜底。重构/重规划的子进程（extract-llm/simulate）与父进程各锁自己直写的文件，避免父子锁冲突（refactor 父进程锁 outline/premise，子进程经 `--canon-out`/`--out` 锁 canon/extract-out）。**IDE 直写路径同样纳入协议**：`/api/apply-review`（读-改-写全周期持锁）、`/api/save`、`/api/save-as`、`/api/save-copy` 写项目文件前以同一 `<输出>.lock` 异步锁互认，CLI 正在写同一文件时返回 **409 + 明确提示**（服务器单线程，异步轮询不阻塞事件循环），而非静默覆盖。

## 比对器（compare.js）—— 防漂移

```
node compare.js <预测.json> <实际.json> [--json]
```

- 预测文件接受 simulate.js 的信封输出（含 `canon` 字段）或纯 canon JSON；实际文件是作者维护的 canon。
- **匹配策略**：先按 id，id 未命中按 name 兜底对齐（id 差异报 info 级 `diff/*-id-drift`，不误报缺失）。
- **比对范围**：只比对已写章节（以实际 canon 的 timeline 最大章为界）；预测覆盖的未来章节报 info（未到期）。
- 输出：`diff/*` 系列偏差（实体/知识/悬念在场与字段漂移、时间线 day/location 漂移、回收状态漂移），每条带处理建议（rebase 或修复实际）。
- **`diff/timeline-missing-in-actual`（warning，v0.4.2 新增）**：预测有、实际无、且已写章范围内的时间线缺章——删章后未同步或漏登记。升级后出现此警告属**预期行为**（新规则），不是回归；处理：rebase（以实际为准）或补进 actual canon 的 timeline。
- **`diff/timeline-empty-actual`（warning）**：实际 canon 时间线为空（schema 允许 `timeline: []`）而预测有时间线——写作进度无从判定，所有章级比对被跳过。旧版在此场景恒报"无偏差"（rebase 永不触发的假阴性）；现明确报 warning。处理：补全 actual canon 的 timeline（compile 会按手稿报缺章），或确认以实际为准后 rebase。
- **`--json` 输出的 `line` 字段**：`diff/*` 是 canon 条目级比对，没有正文行号锚点——`line` 统一为 **`null`**（v0.4.2 起；旧版本硬编码 1，会误导消费者以为指向手稿第 1 行）。文本报告不显示行号，不受影响。
- 退出码：0 = 无警告级偏差；1 = 有警告级偏差（需决定 rebase 或修复）；2 = 输入错误。

## 设计说明（与长线路线的关系）

1. **三段式编译**：`extract（解析手稿→结构化事实）→ state（canon 库）→ check（规则引擎）`。
   本 MVP 的 extract 是启发式（行级提及扫描、句级知识匹配）；后续可换成 LLM 提取层，**接口不变**——这是整个系统可替换性的关键。
2. **checker 的可靠性上限 = state 的可靠性**。canon 必须手工维护、作者确认，这是地基。
3. **增量编译**：规则全部按章节作用域实现，天然支持"只重扫脏章节"。
4. **同构原则（已落地）**：模拟器输出与手写 canon 同一 schema，比对器是纯函数机械 diff——"模拟 vs 实际"不需要 LLM 判读，可复现、可测试。
5. **rebase 语义**：比对报告的警告级偏差 = 需要决策的信号。当前处理方式是人肉决策（修正实际 or 重新模拟）；下一步可自动化（`--canon 实际` 重跑 simulate 即 rebase，已经是一条命令的事）。
6. **边界**：L2 因果层（动机、巧合）与 L4 语义层（节奏、风格、"对不对味"）不在编译判定范围内——模拟器的风险登记册会给证据，最终裁决权在作者。

## IDE（app/）—— 类 VSCode 风格写作 harness

```
cd app && npm install     # 首次：安装 monaco-editor
npm run app               # 或 node app/server.js [--port 3090] [--config <配置路径>]
# 浏览器打开 http://127.0.0.1:3090
```

布局（与你最初设想一致）：

| 区域 | 内容 |
|---|---|
| 左侧 dashboard | 两个页签：**状态**（时间线、角色/地点/物件出场率、悬念台账、知识状态机）· **风险登记册**（模拟风险列表：严重度/概率/触发/对策 + 状态机 未处理/已处理/已触发/忽略） |
| 中间主体 | Monaco 编辑器（标签页随模式切换：创作者模式 = 文稿 / 故事大纲 / 前情提要；开发者模式 = manuscript.md / canon.json / outline.md / premise.md，行号即锚点） |
| 底部 problems | 编译输出（错误/警告/提示 分类 tab，**点击任意条目跳转到对应行号**） |
| 右侧 AI 面板 | 创作者模式：**「生成报告」一键流水线**（自动保存 → ① 模拟 → ② 提取 → ③ 比对 → ④ 重规划 → 编译 → 自动弹出审阅窗口；失败停在出错步骤、原因进日志）。开发者模式：分步按钮 ① 模拟 ② 提取 ②′提取本章 ③ 比对 ④ 重规划 ⑤ 审阅；**长任务流式输出**（分段进度实时流入日志，期间按钮禁用 + 状态栏显示 ⏳ 运行中） |
| 审阅模态框 | 提议 canon vs 实际 canon 条目级 diff：新增/修改逐条 **接受 / 拒绝 / 编辑后接受**（含证据引文），一键全部接受 → 写回 canon 并自动编译刷新（canon 标签内容同步刷新，防旧编辑覆盖审阅成果） |

- **双模式**（0.4.4）：点击左上角「文检 ▾」弹出设置栏，可在 **创作者模式**（默认，刷新即回）与 **开发者模式** 间切换。创作者模式面向写作者：中文标签 + 生成报告一键 + 隐藏调校项（读者向/模型下拉、编译、六项分步流水线、canon 标签）；开发者模式还原完整界面（四个英文标签 + 六项 AI 流水线 + 全部按钮）。
- 快捷键：`Ctrl+S` 保存、`F5` 编译；顶栏可切**项目**/读者向/模型；**「重构」键一键从正文逆推并重写 canon/outline/premise**。
- **保存下拉菜单**（悬停"保存 ▾"展开）：**保存**（写回当前文件）· **另存为…**（写新路径并让项目指针跟随）· **存储为…**（导出副本，指针不变）。
- **多项目配置**：`app/config.json` 支持 `projects` 字典（每项含 manuscript/canon/outline/premise/reader）+ `activeProject`；顶栏下拉一键切换（编辑器模型重建 + 自动编译 + 状态栏显示项目名），切换即时持久化。旧版平铺格式自动迁移（项目名取 canon 标题）。**顶栏「＋」新建项目**：填名称（可改路径）→ 自动创建四件套空文件并切换。**项目 id 不能包含 `\ / : * ? " < > |` 字符**（保证 id → 预测目录 1:1 映射，防止 'a/b' 与 'a_b' 串扰）。示例：

```json
{
  "model": "deepseek-chat",
  "apiKey": null,
  "activeProject": "雾都迷踪",
  "projects": {
    "雾都迷踪": { "manuscript": "../examples/manuscript.md", "canon": "../examples/canon.json", "outline": "../examples/outline.md", "premise": "../examples/premise.md", "reader": "webnovel" },
    "锦鲤抄":  { "manuscript": "../examples/exam2.md", "canon": "../examples/exam2-canon.json", "outline": "../examples/exam2-outline.md", "premise": "../examples/exam2-premise.md", "reader": "webnovel" }
  }
}
```
- 工作文件在 `app/config.json` 配置（指向你的手稿/canon/大纲/前提）；API 密钥取 `config.json → apiKey` → 环境变量 → 本机 DSH 凭据。可用 `--config <path>` 指定其他配置文件（测试/多配置场景）。
- **预测产物按项目隔离**：模拟/提取/风险状态写入 `app/predictions/<项目id>/`（last-pred.json / last-extract.json / risk-status.json），切换项目不会互相覆盖（旧版单项目路径读取时自动兜底兼容，写入进新目录）。
- 服务器只监听 127.0.0.1；写操作仅限配置的工作文件、predictions 目录与项目根目录内（另存为/存储为目标超出项目根会被拒绝）；流水线工具名经白名单校验（禁止路径注入）；所有带副作用的 POST API 校验浏览器 Origin（仅接受本机页面，跨站请求返回 403）；工具超时（TOOL_TIMEOUT_MS）会终止**整个进程树**（防孙进程残留继续消耗 LLM 配额）。
- **API 错误约定**：业务校验失败（canon 校验、文件缺失、编辑值非法等）返回 **HTTP 200 + `ok: false`**（前端统一解析 `res.json()`，不区分状态码）；HTTP 状态码保留给协议层错误（400 参数、403 越权/越界、404 不存在、409 冲突、500 服务器内部）。消费方应检查 `ok` 字段而非仅状态码。
- 保存采用原子写（临时文件 + rename），避免文件保护拦截半写状态。

## 路线图

> 当前迭代计划见 [docs/PLAN-v0.3.md](docs/PLAN-v0.3.md)（已批准：解析器兼容 + 增量提取 + IDE diff 审阅）。

- [x] 编译器 MVP：手稿 + canon → 带行号 problems（L0/L1/L3 规则 + 状态快照）
- [x] 模拟器：大纲 → 预测 canon + 风险登记册（schema 自修复重试，--canon 基线）
- [x] 提取器：正文 → 提议 canon（行号证据反幻觉校验，--canon 基线，变更摘要）
- [x] 增量提取：--from/--to 手动范围 + **--incremental 自动脏章检测**（chapter_hashes 对比 → 只提取脏章 → 字段级合并 canon/evidence；无脏快速路径；首次自动退化全量）
- [x] 健壮性：工具进程超时保护（TOOL_TIMEOUT_MS）+ 备份自动清理（每文件保留 N 个）+ 路径与运行目录解耦
- [x] 比对器：预测/提取 vs 实际 → 漂移报告（按名称兜底对齐，只比对已写章节）
- [x] rebase 自动化：漂移检测 → 自动以实际 canon 重模拟（输入自推导，元信息可追溯）
- [x] IDE 壳：类 VSCode 布局（Monaco 编辑器 + 状态 dashboard + problems 面板点击跳行 + AI 流水线面板）
- [x] IDE 审阅闭环：提取结果条目级 diff（接受/拒绝/编辑后接受 → 写回 canon → 自动编译）
- [x] 解析器兼容：纯文本/中文数字/楔子 标题（真实长篇格式）
- [x] 重构（敏捷开发）：文稿先行，逆推并重写 canon/outline/premise（as-built 回写 + 自动备份 + 原子写）
- [x] 重构同步保障：僵尸清理（依赖感知）+ 书名对齐 + 时间线完整性 + 跨文件同步检查
- [x] 多项目配置：projects 字典 + 顶栏切换（即时持久化，旧格式自动迁移）+ 新建项目（一键创建四件套）+ 保存下拉（保存/另存为/存储为）
- [x] 风险登记册面板：模拟风险可视化 + 状态机（未处理/已处理/已触发/忽略，预测更换自动判定状态过期）
- [x] 长任务进度：/api/run-stream 流式输出（进度行实时流入日志 + 运行中禁用 + 状态栏指示）
- [x] 多项目配置（顶栏切换项目）
- [x] 风险登记册面板 + 长任务进度
- [x] suppress 豁免机制（`<!-- wj-suppress: rule [理由] -->` / `@chapter` 章级，独立可审计分组 + 未命中报告）
- [x] 个人规则库 `.wjrc.json`（规则启停 / 级别覆盖 + 阈值覆盖，compile 与 simulate 共用）
- [x] 增量编译：只重扫脏章节（当前 compile 为全量，但 LLM 免费、速度足够，优先级低于增量提取）
- [x] 0.4.x 硬化轮：自动分块全量提取（含增量退化路径）+ 预测/提取产物按项目隔离 + `timeline/ghost` 删章幽灵规则 + 豁免机制准确反馈（尾声/全稿级/跨行注释）+ 番外纳入增量哈希（稳定键）+ 输入预算硬护栏 + 分块检查点 + 4xx 不盲目重试
- [x] 0.4.2：diff `line` 语义化（null）+ `timeline-missing-in-actual` + 统一参数解析（takeValue 缺值检查）+ 互斥锁异常路径兜底 + .gitignore 精确化 + 原子写 fsync（含父目录）+ 跨平台 CI（GitHub Actions：Linux/macOS/Windows × Node 18/20/22）
- [x] 0.4.2 加固：config 旧格式迁移保留旧项目字段 + 配置读失败不做写回决策（防清空）+ 进程树终止模块化（taskkill 3s 超时）+ 项目 id 入口校验（预测目录 1:1）+ 状态先持久化后改内存（失败时内存与磁盘一致）+ LLM 5xx/429 最小退避 + 原子写失败清理临时文件 + 审阅缺字段/非数组基线防御 + 空对象编辑值拦截 + timeline 决定兼容 chapter 字段 + 条目 section 常量统一（src/canon.js）+ asArray 数组防御统一 + 损坏 config 解析失败显式标记（parseError + 拒绝写回，不再静默默认）
- [x] 0.4.3：asArray 数组防御全项目核心通路统一（rules/diff/report/outline/extract/compile/simulate/extract-llm）+ 非数组 canon 全链路兜底单测（6 项）+ simulate 风险登记册字段类型校验（chapter 非负整数 + kind/trigger/mitigation 字符串）
- [x] 0.4.4：创作者/开发者双模式（默认创作者，不持久化）——「生成报告」一键流水线（保存→模拟→提取→比对→重规划→编译→自动审阅，失败停在出错步骤）+ 标签中文化（文稿/故事大纲/前情提要，canon 幕后维护不暴露）+ 左上角「文检」设置栏（模式切换）+ 审阅写回后编辑器 canon 模型自动刷新（防旧模型覆盖审阅成果）

## 发布 checklist

发版前逐项确认（测试末尾的断言会自动校验 README 断言数）：

1. **版本号**：升根 `package.json` 的 `version`（唯一来源，`src/version.js` 自动跟随）→ **手动同步** `app/package.json` 与 `app/package-lock.json`（app 是独立 npm 包）。
2. **测试全绿**：`node test/run-tests.js`（末尾断言会校验 README 的「断言数」快照与本次实际一致，不一致必须同步 README）。
3. **README 快照**：断言数、特性路线图、规则表、CLI 用法与代码实际行为一致（`--dry-run` 可快速目检提示词与参数）。
4. **demo 冒烟**：`node compile.js test/fixtures/demo-manuscript.md test/fixtures/demo-canon.json --reader webnovel` 检出全部内置问题。

## License

MIT

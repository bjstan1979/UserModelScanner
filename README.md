# User Model Scanner

跨框架、离线优先的 User Model 提取器。它把历史会话扫描、证据治理和用户模型生成从具体 Agent runtime 中独立出来，支持 **Coding / Engineering agent** 与 **Emotional Companionship agent** 两种投影。

> 项目定位：后台单次 extraction pipeline。首次历史扫描可以较慢；后续增量扫描只处理新增或变化的 session。

## 能力概览

- 支持 Pi、Codex、WorkBuddy、Claude Code、OpenCode、OpenClaw 会话。
- 共享底座：adapter discovery → fingerprint/cursor → canonical events → SQLite。
- Coding projector：提取协作偏好、决策风格、价值观和项目/工具边界。
- Companion projector：按用户隔离，处理实体归属、关系、陪伴偏好、临时情绪状态、计划生命周期、长期协议和仪式。
- 确定性治理优先：Stage A triage、ontology contract、evidence binding、entailment、冲突与时间状态由程序控制。
- MiniMax/OpenAI-compatible semantic enhancement 可选；高置信规则候选不会重复调用模型。
- snapshot、discovery evidence 和 incremental index 支持跨运行复用。
- Assistant 输出、system prompt、tool output 和已有 USER.md 不作为用户证据。

## 核心设计原则：描述，不规定

> **用户模型的目的是增强理解，而不是增加控制。**
> **The purpose of a User Model is to improve understanding, not to increase control.**

User Model 不是来自用户的隐藏 system prompt，也不是 Agent 必须服从的规则集。它描述历史中反复出现的倾向、背景和合作线索，帮助双方更好地理解彼此；当前用户表达、当前情境、新证据和现实始终具有更高优先级。

- **Model the user; do not control the agent.**
- **User Model is a prior, not a constraint.**
- 用户可以改变偏好；模型必须保持可修订，不能冻结用户。
- Agent 应结合当前任务作判断，而不是为了迎合历史画像而忽略必要解释、风险或事实。
- 明确建立的安全边界和关系协议可以记录，但应保留适用范围与证据，不能无限外推。

每条候选 trait 进入 `USER.md` 前应回答：

1. 这是用户特征/倾向，还是伪装成 trait 的 Agent 行为命令？后者应改写或拒绝。
2. 换一个任务或情境后仍然成立吗？若只适用于特定领域，应保留 scope，不能冒充全局人格。
3. 删除它是否会让 Agent 失去对用户的重要理解？如果不会，就不应占用便携 User Model。

因此推荐写法是 `Prefers...`、`Tends to...`、`Usually works best when...`，而不是 `Agent must...`、`Always...`、`Never...`。

## 快速开始

### 环境

- Node.js >= 20
- npm

```bash
git clone https://github.com/bjstan1979/UserModelScanner.git
cd UserModelScanner
npm install
npm run build
```

默认使用确定性规则 provider，不需要 API key：

```bash
# Coding / Engineering agent
npx user-model scan

# 查看生成结果
npx user-model show
npx user-model traits
```

## Coding agent

增量扫描默认发现本机支持的数据源：

```bash
npx user-model scan
npx user-model scan --full
npx user-model scan --full --ab
npx user-model evidence <trait-id>
npx user-model diff
```

产物默认写入 `~/.user-model/`，包括 `USER.md`、分层 Markdown、结构化 `user-model.json` 和 `evidence.sqlite`。本地数据目录不会提交到仓库。

## Companion agent

Companion 是后台纵向扫描，不参与实时对话循环。它复用 Coding 的 ingestion 底座，但按用户分别归约，防止不同用户的记忆互相污染。

### 扫描单个真实用户的陪伴历史

把该用户的 OpenClaw JSONL session 放在一个独立目录中，不要直接指向包含多个 agent、checkpoint 和工具日志的整个 `~/.openclaw`：

```bash
npx user-model companion \
  --source ./my-companion-sessions \
  --adapter openclaw \
  --provider rule
```

不指定 `--home` 时，最终交付物与 Coding agent 一样写入 `~/.user-model/`：

```text
~/.user-model/companion/
├── USER.md
├── USER_MODEL.md          # USER.md 的兼容副本
├── RELATIONSHIP.md
├── COMPANION_IDENTITY.md
├── EPISODIC_MEMORY.md
├── CURRENT_CONTEXT.md
├── companion-model.json
└── longitudinal-index.json
```

`USER.md` 是优先阅读的便携用户模型；未提取到的字段不会输出 `undefined`。OpenClaw 原生 typed text blocks 会被规范化，tool result、thinking 和 orchestration record 不作为用户内容。

### 运行模拟纵向 corpus

```bash
# 生成 4 个用户 × 12 个跨月 session
npx user-model companion-simulate --out ./companion-sim

# 首次扫描
npx user-model --home ./companion-home companion \
  --source ./companion-sim \
  --adapter openclaw \
  --provider rule

# 再次运行：未变化的 session 会跳过
npx user-model --home ./companion-home companion \
  --source ./companion-sim \
  --adapter openclaw \
  --provider rule
```

输出位于：

```text
<home>/companion/
├── users/<user-id>/
│   ├── USER.md                    # 每个用户的便携模型
│   ├── USER_MODEL.md
│   ├── RELATIONSHIP.md
│   ├── COMPANION_IDENTITY.md
│   ├── EPISODIC_MEMORY.md
│   ├── CURRENT_CONTEXT.md
│   └── companion-model.json
├── longitudinal-index.json       # session 增量索引
├── longitudinal-baseline.json    # fixture 有 truth ledger 时生成
└── semantic-cache/               # discovery evidence 持久化缓存
```

只有一个真实用户时不会额外创建 `users/default/`，文件直接写入 `<home>/companion/`。

### MiniMax semantic enhancement

可以通过 CLI 指定 OpenAI-compatible 配置文件：

```bash
npx user-model --home ./companion-home companion \
  --source ./companion-sim \
  --adapter openclaw \
  --provider auto \
  --model-config ~/.openclaw/workspace-doctor/minimal-agent/minimax.md
```

配置文件至少需要：

```yaml
api: YOUR_API_KEY
url: https://api.minimaxi.com/v1
model: MiniMax-M3
```

不要把 API key 写入仓库、fixture、报告或 issue。也可以使用项目既有的 OpenAI-compatible 环境配置。

### Companion 的五类信息

- 用户背景与长期偏好
- 当前临时状态与生命周期（active / temporary / closed）
- 关系和具名实体归属
- 计划、协议、仪式及其发生记录
- 纠正、取消、quoted、hypothetical、role-play 与 task-only 内容的边界

## 架构

```text
历史 session
    │
    ▼
adapter discovery → fingerprint/cursor → CanonicalEvent → SQLite
                                                    │
                         ┌──────────────────────────┴──────────────────────┐
                         ▼                                                 ▼
                 Coding projector                                  Companion projector
             traits / domains / tools                         per-user candidates/entities
                                                              operations / lifecycle snapshot
```

Semantic provider 位于 projector 内部，并不是事实来源：规则提取、canonicalizer、evidence validation 和 resolver 仍是最后的安全边界。

## 测试与验证

```bash
npm test
npm run build
npx tsx --test tests/source_pollution.test.ts
```

真实网络路径（需要本地配置）在以下命令中：

```bash
npm run test:companion-semantic-real
npm run test:companion-hybrid-real
```

当前验证重点：

- canonicalizer 未被 Companion 实验绕过；
- attribution errors 必须为 0；
- 增量重跑不重复请求 semantic provider；
- assistant/system/tool 内容不进入 user model；
- synthetic longitudinal corpus 仅用于 development regression，不代表真实用户泛化结果。

## 数据与隐私

仓库只包含合成测试 fixtures 和脱敏后的验证报告。请不要提交：

- `~/.openclaw`、`~/.pi` 等本地历史会话；
- API keys、tokens、credentials；
- `USER.md`、SQLite 数据库或包含个人信息的导出文件。

OpenClaw session 格式可能包含 cron、subagent、monitor 和 tool-loop 消息。使用真实数据前必须先做 text-block normalization、PII/secret residual audit，再冻结 truth ledger；不应直接把原始 OpenClaw history 当作 Companion ground truth。

## 当前验证结果

在 `companion-longitudinal/v2` synthetic corpus 上：

- fresh rule run：final F1 `0.935`，recall `1.000`，attribution errors `0`；
- MiniMax-M3 hybrid postcheck：final F1 `0.806`，operation F1 `0.862`，semantic requests `25`；
- 48 sessions / 416 messages 的 MiniMax cold run 约 7 分钟，适合后台单次 extraction；
- 未变化的增量重跑：`processed=0`、`skipped=48`、semantic requests `0`。

这些数字是开发回归结果，不是 production guarantee。详细报告在 `reports/`。

## 许可

MIT

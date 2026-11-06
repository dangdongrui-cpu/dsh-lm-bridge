# dsh-lm-bridge

DSH ↔ AstrBot 之间的**消息与记忆桥**插件。

AstrBot 和 DSH 是同一个角色的两个窗口。本插件让两边共用一份人格与一份长期记忆：

- **人格**主源永远是 AstrBot（只读它的 `data_v4.db`），DSH 不保存第二份人格副本；
- **长期记忆**读写都走 AstrBot 的 LivingMemory 插件，DSH 不另建向量库；
- DSH 侧只保留进程内的短期轮次缓冲，卸载/重启即消失，不留持久状态。

> 本插件不改 AstrBot 源码，不写 AstrBot 数据库，除了你显式调用写回工具（或开启自动写回）之外不产生任何外部副作用。

## 架构

```
DSH 宿主（Cordis 插件）
├─ systemPrompt.section  「人格段」(order 0) + 「语气段」(order 10200)
├─ agent/pre-step        按当前发言召回记忆 → 插一条带 source.digest 的 user 消息（同内容不重复注入）
├─ tools                 livingmemory_recall（只读） / livingmemory_write（默认 dry run）
└─ webServer             /api/dsh-lm-bridge/state | /toggle（仅 127.0.0.1，给设置页开关用）
         │
         │  HTTP + 本机自签 JWT（HS256，密钥读 AstrBot 的 cmd_config.json）
         ▼
AstrBot dashboard :<port>
├─ 端口自适应发现        候选端口 → 枚举本机 LISTENING 端口 → 看 <title> 是不是 AstrBot
├─ /api/plug/astrbot_plugin_livingmemory/page/recall/test      语义召回（服务端不按人物过滤）
└─ /api/plug/astrbot_plugin_livingmemory/page/memories/import  提交对话（可 dry_run）

AstrBot 实例数据目录（只读）
└─ data_v4.db → personas 表（system_prompt / begin_dialogs）
```

一句话流程：**预取人格 → 每轮召回 → 过滤排序 → 注入 DSH → 需要时写回 LivingMemory**。

## 能力

| 能力 | 实现 |
|---|---|
| 读 AstrBot 当前人格 | 只读 `data_v4.db` 的 `personas` 表（`node:sqlite`，`readOnly` + `PRAGMA query_only`） |
| 人格进入 DSH | `ctx.systemPrompt.section({ name: 'lm-bridge:persona' })`；注册失败时退化为随记忆块一起注入 |
| 语气规则 | 优先读一份共享 markdown（和 AstrBot 侧 tone 插件读同一路径，按 mtime 热更新），读不到才用静态 `toneSuffix` |
| 按人物召回记忆 | `POST /page/recall/test` → **本地按 `metadata.persona_id` 硬过滤** → 相似度/重要性双阈值 → Top N |
| 记忆进入 DSH | `agent/pre-step` 插入一条带 `source.digest` 的 user 消息；同会话同内容不重复注入 |
| 写回 LivingMemory | 工具 `livingmemory_write`，**默认 dry run**；真正写入需 `dryRun:false` **且** `confirm:true` |
| 自动写回 | 累计 20 条 或 空闲 1 小时触发，定时器巡检，全内存游标 |
| 手动检索 | 工具 `livingmemory_recall`（只读） |
| 开关 | 设置 → 通用 →「角色人设（AstrBot）」，只切本进程的注入位，不写配置 |

插件本身**没有持久状态**：无缓存文件、无索引、无临时库。回滚零数据损失。

## 安装

### 前提

前置：需安装 AstrBot 插件 `astrbot_plugin_livingmemory`（作者 lxfight，AGPL-3.0）。本插件只通过它的 HTTP 接口调用，不复制、不链接其源码，因此不受 AGPL 传染；若你要改用别的记忆后端，改 `astrbotBaseUrl` 与接口前缀即可。

- Node.js **≥ 22.5**（依赖内建的 `node:sqlite`）
- DSH **>= 0.2.0-rc.1 < 0.3.0**
- AstrBot 已在跑，并装了 `astrbot_plugin_livingmemory`

### 步骤

1. 把本仓库放到 DSH profile 的 `node_modules` 里：

   ```bash
   pnpm add https://github.com/dangdongrui-cpu/dsh-lm-bridge.git            # 在 DSH profile 目录下执行
   # 或者手动拷/软链：
   # ~/.dsh/profiles/desktop/node_modules/dsh-lm-bridge -> https://github.com/dangdongrui-cpu/dsh-lm-bridge.git
   ```

2. 在 DSH profile 的 `cordis.patch.yml` 里加一行：

   ```yaml
   - id: dsh-lm-bridge
     name: dsh-lm-bridge
     config:
       astrbotBaseUrl: "http://127.0.0.1:16752"
       astrbotConfigPath: "<ASTRBOT_DATA_DIR>/cmd_config.json"
       personaDbPath: "<ASTRBOT_DATA_DIR>/data_v4.db"
       personaName: "nicai"
   ```

   本仓库自带的 `cordis.patch.yml` 只声明 `insert`（默认值），覆盖请写在 profile 侧、用同一个 `id`。

3. **重启 DSH**。bundle 不热加载，改完必须重启才生效。

4. 打开 设置 → 通用，应能看到「角色人设（AstrBot）」开关；开着即注入。

> DSH 桌面版的 profile 由 Electron 独占管理，`dsh plugin --profile desktop` 这类命令会被拒，改配置走界面或直接改 profile 文件。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `astrbotBaseUrl` | `http://127.0.0.1:16752` | AstrBot dashboard 地址（发现命中后会被自动覆盖） |
| `astrbotConfigPath` | `<ASTRBOT_DATA_DIR>/cmd_config.json` | 读 `dashboard.username` / `dashboard.jwt_secret` 本地签票 |
| `jwtExpSeconds` | `3600` | 自签 token 有效期 |
| `httpTimeoutMs` | `8000` | 通用 HTTP 超时 |
| `discoverEnabled` | `true` | 是否自动找 AstrBot 端口 |
| `discoverCandidates` | `[16752, 6185, 18387, 11451, 6186]` | 优先探测的候选端口，命中即停 |
| `discoverMaxPorts` | `64` | 一次发现最多探多少个端口 |
| `discoverTimeoutMs` | `900` | 单端口探测超时 |
| `circuitThreshold` | `3` | 连续失败多少次后熔断 |
| `circuitCooldownMs` | `60000` | 熔断冷却时长 |
| `personaName` | `nicai` | 对应 AstrBot `personas.persona_id`，也是 LivingMemory 的 `persona_id` |
| `personaSource` | `sqlite` | 预留 `http`，当前只实现 sqlite |
| `personaDbPath` | `<ASTRBOT_DATA_DIR>/data_v4.db` | AstrBot 主库（只读） |
| `personaRefreshSeconds` | `300` | 人格缓存 TTL；`0` = 只读一次 |
| `includeBeginDialogs` | `true` | 是否把人设的开场示范也注入（可能含露骨内容，介意就关） |
| `maxBeginDialogs` | `6` | 开场示范条数上限 |
| `personaSectionOrder` | `0` | 人格段在系统提示里的位置 |
| `toneSuffix` | 空 | 静态语气后缀（共享文件读不到时的兜底） |
| `toneSuffixFile` | `<DSH_DATA_DIR>/storages/tone.md` | 共享语气规则文件；文件不存在只警告一次 |
| `toneSuffixOrder` | `10200` | 语气段位置（排在工具指导之后） |
| `memoryBlockStyle` | `memory` | `memory` = 「我想起的事」口吻；`recall` = 「长期记忆」汇报口吻 |
| `recallEnabled` | `true` | 召回开关 |
| `recallTopK` | `20` | 向服务端要多少条（1–50） |
| `recallInjectCount` | `4` | 过滤后实际注入几条（1–8） |
| `recallMinSimilarity` | `0.55` | 相似度阈值 |
| `recallMinImportance` | `0.3` | 重要性阈值 |
| `recallTimeoutMs` | `8000` | 超过它才降级为「只注入人格」 |
| `recallQueryTurns` | `2` | 拼检索词用最近几条用户发言 |
| `includeDefaultPersonaMemories` | `false` | 是否把 `persona_id == default` 也算命中 |
| `maxInjectChars` | `4000` | 记忆块字符上限 |
| `writeEnabled` | `true` | 写回工具开关 |
| `automaticWrite` | `true` | 自动写回总开关；关掉后只剩手动工具 |
| `autoWriteTurns` | `20` | 累计多少条触发提交 |
| `autoWriteIdleMs` | `3600000` | 安静多久触发提交（1 小时） |
| `autoWriteCheckMs` | `300000` | 空闲巡检间隔（5 分钟） |
| `autoWriteMaxTurns` | `40` | 单次自动提交最多带几条 |
| `writeTurns` | `10` | 手动工具默认提交最近几轮（2–40） |
| `dryRunByDefault` | `true` | 工具默认 dry run |
| `writeTimeoutMs` | `120000` | 正式写入要走 LLM 总结，给足时间 |
| `sessionIdTemplate` | `dsh-rp:{persona}` | LivingMemory 的 `session_id` 模板，支持 `{persona}` `{storyline}` |
| `storylineName` | 空 | 多剧情线时填，例如 `冰神湖` → `dsh-rp:nicai:冰神湖` |
| `debug` | `false` | 额外日志 |

## 跑测试

```bash
node --test "test/*.test.js"          # 标准测试运行器（82 项）
node --test test/recall.test.js       # 只跑单个文件
```

如果环境限制子进程（沙箱里 `node --test` 会 `spawn EPERM`），用仓库自带的单进程入口：

```bash
node test/run.js           # 等价于 pnpm test
```

测试全部离线：不联网、不碰真实 AstrBot、只读临时目录里的 SQLite，覆盖配置归一化、召回过滤、写回双闸门、注入去重、熔断、端口解析、自动写回、语气文件。

联调冒烟（需要真的 AstrBot 在跑，只读）：

```bash
node scripts/smoke.mjs
```

## 常见问题

**Q：启动日志报 `connection-refused` / 一直找不到 AstrBot？**
A：先确认 AstrBot 起来没、dashboard 端口是多少。插件会先探 `discoverCandidates`，再枚举本机 LISTENING 端口，最多 `discoverMaxPorts` 个。非 Windows 系统拿不到 `netstat`，只会探候选端口，这时请把真实端口写进 `astrbotBaseUrl`。

**Q：报 `unauthorized`（401/403）？**
A：`cmd_config.json` 里的 `dashboard.jwt_secret` 变了，或者账号没权限。AstrBot 重启会换 secret，插件按 mtime 重读，401 时也会重签一次。

**Q：报 `endpoint-missing`（404/405）？**
A：`/api/plug/astrbot_plugin_livingmemory/page/...` 不在，通常是 LivingMemory 插件版本变了或没启用。

**Q：人格是空的 / 一直用旧缓存？**
A：`personaName` 必须和 `personas.persona_id` **完全一致**（错误日志里会列出表里现有的 id）。读失败时保留上一次缓存，所以看起来「没变」；改完等 `personaRefreshSeconds` 或重启。

**Q：记忆块没出现？**
A：按顺序查：`recallEnabled` → 设置页开关是否打开 → 是否命中阈值（召回工具会报「丢弃 N 条（原因）」）→ 是否内容没变被 digest 去重（同会话同内容不重复插入）。

**Q：自动写回会不会重复提交？**
A：游标是轮次环的累计条数，只增不减，进程内有效；重启后环清空、游标归零，因此不会重复提交已写过的内容（代价是重启前未提交的轮次会丢）。跨会话还有 LivingMemory 自己的查重兜底。

**Q：会不会动我的 AstrBot 数据？**
A：人格库只读打开（`readOnly` + `PRAGMA query_only`）。唯一的外部写操作是 `livingmemory_write`，默认 dry run，真实写入要同时传 `dryRun:false` 和 `confirm:true`。

**Q：控制台那条 `ExperimentalWarning: SQLite is an experimental feature`？**
A：`node:sqlite` 在 Node 22 里还是实验特性，正常现象，不影响功能。

**Q：能拿来当通用「多 Mem0 后端」的桥吗？**
A：不能。召回与写回都是按 AstrBot LivingMemory 的实际接口和字段写的（`recall/test`、`memories/import`、`metadata.persona_id`），换后端要改 `lib/astrbot.js`。

## 目录

```
lib/        插件实现（纯函数与适配器分开，便于单测）
test/       单元测试与单进程运行入口
scripts/    联调冒烟脚本
cordis.patch.yml   bundle 声明
```

## 许可

非商业使用许可（Non-Commercial Use License）。允许免费使用、修改、再分发，**禁止任何商业用途**。详见 [LICENSE](./LICENSE)。

## 免责声明

- 本项目**仅供个人自用与学习**，没有针对生产环境做加固，也不承诺长期维护。
- 按现状（AS IS）提供，**不保证适用于任何特定用途**；因使用产生的数据丢失、服务异常、账号风险，作者不承担责任。
- 发现 bug 欢迎提 issue，但不承诺修复时限；急用请自行 fork 修改（改完保留原版权声明即可）。
- 涉及第三方服务的部分（AstrBot / LivingMemory / NapCat / SD WebUI / ComfyUI / OpenAI 兼容接口等）请遵守各自的服务条款。

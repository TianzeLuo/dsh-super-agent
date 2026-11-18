# 使用与配置

本文放安装、UI、Worker 复用、CLI、HTTP 和配置细节。架构见
[design.md](design.md)，入口和最短路径见 [README](../README.md)。

## 安装

```sh
dsh plugin --profile web add github:TianzeLuo/dsh-super-agent
```

安装后重启 `dsh web`，硬刷新浏览器，左栏点击 **Super-agent**。首次使用会自动
创建独立的 Super-agent Workspace，不需要先选工作区。

## 实例与对话分身

实例仍是互相独立的 Super-agent，配置、任务与状态目录分别保存。每个实例有一个
「总览」，可以继续创建研究、写作、日常等**对话分身**。分身是当前 Super Agent 内的
独立子会话，保留各自聊天与专属记忆，共用任务资源。底层仍称为 topic，既有主题、
历史和设置继续使用；不另外启动调度器，也不支持递归创建子实例。

每个分身都能分派 Worker 执行任务，协调与报告由所属对话处理。开启协作后，可以交办
阶段任务、把同一任务交接给其他分身，或建立 2–6 个分身参与的群聊；可选的主分身负责
协调，没有额外权限，也不会替换当前总览或 Router。现有分身默认不开启协作。

点顶栏 **对话分身 · 当前名称** 展开切换栏，选择 **新建分身**，填名称并选择共享方式，
点 **创建并切换** 即可开始聊天。切换栏默认收起，展开时高度为 32px，记住当前窗口的
折叠偏好；收起后当前分身名称仍保留。**管理与记忆** 打开设置页，顶部同样可以新建。

切换主题只切换对话历史与本地记录；任务报告、审批提醒和定时唤醒回到发起主题。
在 **近期活动 → 任务范围** 选择本分身任务或全部任务；窄屏先打开顶栏的 **活动**。
全部任务会标注来源分身，切换范围会清空旧详情与分页结果。每个浏览器标签页独立保存所选实例和主题，
另一窗口切换位置不会改变这边请求的目标。总览默认展示全部任务；人类操作者可管理
本实例所有主题，模型读取则受下表限制。

| 主题共享设置 | 其他主题的模型可见内容 |
| --- | --- |
| 仅自己可见 | 不出现在其他分身的主题列表、状态和任务召回中 |
| 分享协作摘要（默认） | 分身名、目标／结果／阻塞／下一步、摘要版本与时间，以及任务标题／状态；不含 brief、报告正文、附件或专属记忆 |
| 允许查阅聊天 | 上述内容及按需读取的 user／assistant 文本、相关任务详情；不包含工具输出、思考过程或附件字节 |

**协作摘要**相当于给其他分身看的交接卡：正在做什么、做到哪一步、还卡在哪里、下一步。
AI 在对话有实质进展时维护；开始聊天前无需填写，也可展开 **编辑协作摘要** 纠正。
它不代表工作已验收，
每个字段最多 240 字符。共享记忆是你明确要对整个实例开放的事实／决定；本主题
记忆只提供给本主题及其 Worker。主题共享开关不会改变已经保存的实例共享记忆，
撤回共享事实需要归档该条目。长期行为约定在主题中默认保存到
本主题，可显式选择「本实例全部主题」；总览默认保存实例约定。既有实例约定继续生效。
项目约定仍可在这些范围内按项目筛选。记录与召回内容都不能授予新权限。

每个实例最多 32 个主题（含总览），名称最多 60 字符。每个记忆作用域最多 128 条有效
记录，新正文最多 1200 字符；达到容量后归档过时事实可释放有效名额。修改同一事实时
沿用稳定名称并提交所读版本，冲突须重读；同名本地事实只在本主题覆盖共享事实。
默认读取和注入排除归档项。每条保留最近五次旧版本；模型整理可以合并语义重复，归档
过时自动记录，保留事实的限定条件。
旧版最多 4000 字符的文本原样迁移，不按换行拆分，首次写入新格式时保留原始备份。

`context.maxChars` 默认 12000（可设 1000–64000），统一约束约定、记忆、主题进展及其
标记。优先选择有效约定、重点事实、当前进展，再选择普通事实与相关的其他主题进展；
同级按当前请求／主题的关键词相关性和更新时间排序，最多选择五个其他主题进展。
每条完整装入，放不下就省略并提示；重点遗漏会额外警告。界面可查看实际选中项、
省略项及原因。该字符预算不包括宿主提示词、聊天、工具结果，也不等同于 token 上限。
注入仍只选择完整条目；存储侧另由模型提炼、合并与压缩，详细内容按需读取。

在 **管理与记忆 → 记忆** 可查看本实例的自动整理开关、最近结果与保存依据，或点击
**整理记忆**。自动整理默认每 30 秒检查。对话和相关任务从插件观察到的最近活动起连续空闲
至少 15 分钟、有尚未尝试的可读材料、功能已启用、宿主支持模型调用，且本实例没有其他整理在运行时，
才开始一次整理。
每轮只处理原分身或原群的材料，结果可以是零修改。同一份材料已经处理或尝试失败时，
后台等新材料再运行。人工保存和明确要求记住的记录不由后台改写；直接聊天
纠正，或主动整理，才会检查这些内容。主动整理也可仅处理已保存内容，无需创建聊天。
没有有用变化时不改条目版本。

整理提案确实会改动记录时，另一次模型调用逐项检查正文、所引来源与原记录。新增约束、临时细节或
丢失限定条件导致提案被拒绝时，整理器可以用原证据修正一次。核对通过后，程序按当前版本一次提交。

在同页展开 **记忆模型设置**，可以从 DSH 模型目录选择模型与该模型支持的思考强度。
设置随实例保存，供手动整理、空闲整理和显式保存的意图核对使用。默认选项 **跟随 Worker 默认**
沿用当前实例的 Worker 默认模型和思考强度。单独选择模型后，可选该模型的默认思考强度。
如果已选模型或强度失效，记忆调用会报错，可以在同页改选或恢复跟随 Worker 默认。

`superagent_memory` 支持 `read/save/archive/restore/state`。读取默认只含当前有效版本，
可按 `scope/query/id` 查询，用 `after` 翻页，显式请求归档或最近修订；默认每次 6000、
最多 8000 个序列化字符，只返回完整条目。写入已有条目须传 `expected_revision`。
模型提出保存、纠正、归档或恢复时，另一次无工具模型调用根据当前真实用户消息核对
意图并精炼内容；返回 `deferred` 表示没有持久化，不能向用户声称已记住。面板手动编辑
直接保存。宿主缺少模型接口时保留手动编辑，模型整理与意图核对会明确报告不可用。
原文召回使用 `superagent_history`，每回合最多 2 次、合计 6000 个序列化字符，默认
每次 3000；最多返回 8 条消息，每条正文最多 1200 字符。默认看最近 100 条可见消息，
关键词只搜索该窗口；可用返回的消息 ID 向前翻页。没有全文索引或向量数据库。
宿主未提供已加载历史时明确报不可用，不为召回启动 Agent。

受管理主题使用统一 `context.maxChars`；`agreements.injectChars` 仅用于未启用主题注册
的旧式项目会话。具体取舍与实测见[记忆设计](memory-design.md)和[场景验证](memory-evaluation.md)。

隐藏主题会收起标签并停止向其他主题分享，保留历史和记录；任务与定时任务仍继续，
可从主题管理中恢复。重置是整个实例的操作，必须在总览中发起；新一代任务状态与
新总览会话不清除主题历史和记录。

共享开关只能限制后续模型工具读取，无法收回已进入其他对话或任务 brief 的内容。
同一实例仍使用同一宿主账户和文件权限；它不是多租户或操作系统安全边界。
敏感工作应使用独立实例及宿主权限隔离。不要将凭据写入记录。

### 让分身一起完成任务

顶栏打开 **分身协作 → 角色与权限**，先为需要接收任务的分身点击 **开启协作**，可选填写
公开职责，例如“核对材料与来源”“写作并保留约束”“审阅最终草稿”；再按需选一个
主分身，不选择也可直接交办。没有开启任何分身时，主分身选项禁用并说明原因。发起对话
不必开启接收。参与协作不改变私人聊天的共享开关，私人历史及专属记忆不会自动进入协作。

回到 Super-agent 总览或任一分身聊天即可用自然语言交办，例如“请让资料分身核对材料，
再交给写作分身起草，最后汇总给我。仅供内部审阅，未授权发布”。不必每次打开看板；
这适用于插件的对话分身，不会为无关的普通 Session 自动启用协作。标题旁的
**如何使用分身协作？** 可查看入门说明、示例及共享边界，并直接跳到角色与权限。

- **协作任务 → 交办任务**：选择接收者，说明目标、已批准材料、限制与验收标准。结果
  返回发起的对话；可在看板查看当前负责人、交接记录、结果或阻塞原因。给同一阶段补充
  背景后可交接；有执行中的 Worker 或子请求时，先完成或关闭它们。
- **群聊 → 新建群聊**：选 2–6 位已开启协作的分身及一位群协调分身。未点名的消息交给
  协调分身；点击成员按钮插入 `@名称` 可指定接收者，`@everyone` 可让成员分别处理。
  群内逐个处理发言，普通进度不会自动唤醒其他成员。
- **群内记忆**：在群聊下方展开，更新同一事实或归档过时记录。它只供该群使用；同名
  群内事实在本群覆盖实例共享事实，不会修改共享原件或自动写入私人记忆。
- **需要停下时**：暂停本群或实例的协作会保留队列，当前步骤可能继续完成；取消请求
  会结束其子请求并关闭关联 Worker。中断或预算不足会显示阻塞原因，检查后可手动继续。

协作使用独立的请求／群聊上下文，不会把窗口切到内部 Session。群聊成员首版固定，
如需改变参与范围请建新群。任务数量、召回与预算，以及文件权限边界见
[协作设计](collaboration.md)。

## UI

- 「分身与记忆」分为分身设置、记忆、AI 参考三页：分别维护名称、共享与协作摘要，
  编辑专属／实例共享事实，检查 AI 可参考的内容与省略原因。新建始终位于面板顶部，
  名称重复时保留草稿和共享选择，修改后可继续创建。共享下拉每项包含说明，
  概念、摘要和记忆操作提供点击展开的帮助；摘要先预览，按需编辑。
  编辑期间遇到新版本会保留草稿并停用
  保存；明确载入最新版本后再修改。归档项可显示、查看最近修订并恢复。
- 「分身协作」分为协作任务、群聊、角色与权限，交办与新建入口放在对应列表顶部；
  交接和事实编辑发生版本冲突时保留草稿，载入最新版本后再提交。
- 直接输入任务；Router 通过 `superagent_projects` 选择项目并派 Worker。
- 右侧「近期活动」在标题旁提供任务范围；窄屏活动抽屉提供相同控件。进行中（queued / starting / working / 等待审批）排在
  已完成、已关闭之前；两组内部都按最近更新倒序。标题计数始终是**总数**，
  默认加载 6 项任务，再按实际 Worker 会话归组，点「显示更多」每批最多追加 6 项，全部展示后显示「已全部加载」。
  标题旁的收起按钮只保留标题行，再点展开恢复默认 6 条；已加载的任务可继续逐批
  展示，不重复请求。排序在数据层完成，分页时同一时间戳的任务也不会跳位。
  同一会话的卡片优先显示正在进行的一轮，展开可按时间查看已加载的每轮任务；
  标出的会话数只统计当前已加载部分，不代表全部历史会话数。尚未分配会话的任务单独显示。
- 点任务在右侧活动栏打开详情卡：状态、项目、模型/思考强度、Worker 是否在线、Brief、
  报告（倒序）、关联线程、任务场景与沿用关系；有上一轮时可直接打开。卡片顶部 `‹` 返回列表，`✕` 关闭；详情占满右侧活动栏，
  不向对话区扩展，因此不会压到底部输入框。
- 任务有在线 Worker 时，详情卡提供「给 Worker 发指令」输入框，可直接纠正方向、
  补充约束；默认**插队**到当前 run 的下一个模型步（不打断正在执行的工具），
  发送后 Worker 的报告仍以 trigger 回到 Router。排队模式见
  [中途指令](#中途指令)。底部固定「打开聊天」
  跳到完整 Worker 会话；关闭任务只释放 Agent、不归档会话，所以历史任务也能回看。
- 顶栏「更多」集中刷新、在会话中打开和重置。「在会话中打开」把当前 Router 作为普通 DSH 会话打开；如果宿主尚未注入
  `uiWorkspace`，面板会提示重试，而不是静默无反应。
- 顶部只保留一个「Worker 模型」按钮，打开统一面板：
  - 逐个勾选（点击模型名或复选框）允许 Router 使用的模型；
  - 每个模型可以限制 reasoning efforts，并指定默认模型/effort；
  - 勾选后点「设为默认」，把这组勾选存成**默认 Worker 模型集合**；新实例和
    新会话直接继承，不再默认全选；
  - 「全部启用」是快捷方式，跟随宿主目录，不是唯一选项；保存写到项目配置。
- 面板、活动详情、模型/规则/定时抽屉全部使用 DSH 主题 token，跟随系统或宿主切换浅色/深色；
  下拉项也是自绘菜单，深色下不会出现白底的原生弹层。
- 「规则」维护长期工作约定：选择所属范围、适用对象与可选场景；可停用、编辑或删除。
- 「Schedules」创建和取消定时唤醒：一次、每日、每周、Cron 或绝对时间；可
  「立即执行」一次。上限由 `schedule.maxActive` 控制。
- 「Reset」只在总览发起，二次确认后中止本实例的 Worker 和各主题当前回合、取消
  本实例所有主题的定时任务，切换新的 dataDir generation、创建新 Router；旧 Worker
  归档，旧 Router 会话保留但隐藏。主题历史、记录与长期约定保留，其他实例不受影响。
- Worker Session 不出现在侧栏，`[super-agent]` 内部 trigger 不出现在聊天流。
- 点通知（[dsh-away-notify](https://github.com/TianzeLuo/dsh-away-notify)）会回到产生它的**实例 + 会话**：选中面板 → 切实例 →
  adopt 那条会话。成功定位不弹顶部提示（跳转本身已说明结果）；只有认不出会话或
  切换实例失败时才给一条提示。已经在那个实例/面板上也照样定位。
  点通知直接打开面板并定位到对应实例/会话，行为与普通会话一致（走 away-notify 原生
  落点，面板没有「跟随」开关）。没有待跳转通知时，切窗口/切标签不会跳；有待跳转通知时
  与普通会话一致（away-notify 只有一条消费通路，点击和回到前台不可区分）。
- 打开面板后如果被自动切走：根因是 worker 会话以前会被 away-notify 弹通知（普通
  Session 没有内部标记），回到前台时 away-notify 消费 pendingFocus 把界面切到该会话。
  现在 worker 创建/恢复时由本插件调用 `awayNotify.markInternal` 登记为内部会话，
  away-notify 不再为它弹通知，也就不会切走面板。导航守卫**默认关**（原生导航原样
  生效）；只有手动 `localStorage['dsh.super-agent.navGuard'] = 'on'` 才启用诊断式拦截，
  排障看 `__SA_NAV_LOG__` 的 `nav.close` / `nav.restored`（带调用栈）。
- 文件预览是面板右侧的一列（560px，最宽 640px）：对话区跟着变窄，Esc 或右上角 ✕ 关闭。
  正文用宿主官方 `CodeBlock` / `MarkdownText`，`.tex`/Markdown 的代码围栏也能正常渲染。
- 排障：地址栏加 `?navdebug=1`（默认关闭），每条日志带 `source`（`layout.panelInfo` /
  `layout.selectPanel` / `away-notify.showSession` / `super-agent.*`）。之后每次 `activePanelId` 变化、实例/会话
  切换都连调用栈打到 console（`[super-agent][nav]`），并累积在
  `window.__SA_NAV_LOG__`（最多 500 条）——复现一次「被切走」就能看到调用点。

默认 workspace：

| 平台 | 路径 |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/dsh-super-agent/workspace` |
| macOS | `~/Library/Application Support/dsh-super-agent/workspace` |
| Windows | `%LOCALAPPDATA%\dsh-super-agent\workspace` |

可用 `DSH_SUPER_AGENT_HOME` 或 profile 配置 `superAgentHome` 覆盖。

## Worker 模型与思考强度

`models.allowed` 是 Router 唯一可选的 Worker 模型集合；为空时优先用
`models.defaults`（默认 Worker 模型集合），再为空才跟随宿主目录。每条可以写：

```json
{
  "models": {
    "allowed": [
      {
        "id": "flash",
        "label": "DeepSeek-Flash",
        "provider": "<provider-id>",
        "model": "dfmodel",
        "efforts": ["low", "high", "max"],
        "defaultEffort": "high",
        "note": "日常默认，快"
      }
    ],
    "defaults": [],
    "default": "flash",
    "defaultEffort": "high"
  }
}
```

- `id` 是 Router/面板看到的短 id，缺省为 `provider/model`；
- `efforts` 缺省表示该模型目录里的全部 effort 都允许；空数组表示不限制；
- `defaultEffort` 缺省用目录默认；显式指定但不在允许列表会被拒绝；
- 目录暂时不可用时，显式 allowlist 仍保留，标成 `available: false`，真正调用由
  宿主报错；
- Router 可以在 `superagent_dispatch` 里传 `model` / `reasoning_effort`；
  `superagent_models` 返回当前可选模型和 efforts。

只想暴露一个渠道的几个模型、又不想抄 model id 时，用可选的来源过滤：

```json
{
  "models": {
    "onlyProvider": "<provider-id>",
    "onlyNames": ["DeepSeek-Flash", "Qwen3.8-Flash", "GLM-5.3-Flash"],
    "default": "",
    "defaultEffort": ""
  }
}
```

### 默认 Worker 模型集合

面板「Worker 模型」里勾选要用的模型，点「设为默认」即可。保存的是
`models.defaults`（每项至少 `provider` + `model`），不会改写 `allowed`：

- 当前实例：写入它自己的 `.dsh/super-agent.json`，下一条 dispatch / 新会话立即生效；
- profile 级：同时写入默认实例的配置，新建实例时复制进新实例的配置；
- `allowed` 非空时仍以 `allowed` 为准；`allowed` 为空且 `defaults` 非空时，
  只暴露默认集合里的模型；
- 宿主目录或来源过滤里已经消失的条目会被静默跳过，保留其余条目；全部消失时
  可调用集合为空，不会回退成“全部模型”。

`onlyNames` 同时匹配 model id 和显示名，顺序即默认模型优先级；`allowed` 非空
时以显式 allowlist 为准。过滤后的目录也会限制面板，不会在 UI 里冒出其它渠道；
此时面板会显示“当前只显示 N 个 / DSH 共 M 个”，并给出一键
「使用 DSH 全部模型」（清空 `allowed`、`onlyProvider`、`onlyNames`，默认模型保持不变）。

## 审批与阻塞

Worker 在宿主要求**手动审批权限**时，任务会立刻变成 `blocked-approval`：面板活动
行显示「等待审批」，Router 收到一条 `approval-request` trigger（含任务 id、工具、
命令/路径摘要、原因与可选的 allow/deny 建议）。默认 60 秒没有决定，watchdog 会再
升级一次。审批决定后任务回到 `working`，等待标记与面板提示一起消失。

`superagent_dispatch` 可以带 `approval` 参数：

- `ask`（默认）：所有审批请求转人工；
- `auto-workspace` / `deny-all`：**本版本只记录到任务与 journal**，仍转人工；
  策略 answerer 是后续 B 阶段的接口预留，见
  [审批阻塞设计](approval.md)。

配置（可选）：

```json
{
  "approval": { "mode": "ask" },
  "watchdog": { "approvalTimeoutMs": 60000 }
}
```

## 长期工作约定

约定保存在 `<项目根>/.dsh/super-agent.agreements.json`，不放在 generation 的
dataDir 里，所以 Reset 不会丢。条目：

```json
{
  "id": "agr_...",
  "title": "先给结论",
  "text": "回复先给结果，再给必要解释；不要贴 Worker 原文。",
  "project": "",
  "projectTitle": "",
  "mode": "append",
  "audience": "router",
  "scenes": [],
  "enabled": true
}
```

- 先区分两个范围：共享范围决定当前分身或本实例全部分身，项目范围决定所有项目或指定项目；总览默认管理实例共享规则；
- `project: ""` 表示所有项目；绝对项目路径表示项目级，修改时省略保留原值，空字符串清除项目限制；
- `audience` 为 `both`（默认）、`router` 或 `worker`：分别约束双方、协调者或执行者；Router 包括总览、分身及协作协调会话；
- `scenes` 留空则通用；例如 `["代码开发", "代码审查"]` 匹配任务任一同名场景即生效，不按正文关键词暗自分类；最多 8 个标签，每个 1–32 字，忽略大小写与首尾空格；
- 所属实例／分身及项目的可见性先确定，再筛选对象和场景；`append` 追加，适用的项目 `replace` 只替换同样适用的全局规则，不让无关场景的覆盖规则挡住通用约束；
- Router 自动看到适用于自身的条件规则、有界场景目录及规则目录版本；版本变化后应重新读取规则，再派工、补充指令或验收，防止用旧工具结果否定当前规则。Worker 仅接收匹配的执行规则。场景选择不授予权限，也不是操作系统隔离；
- 新任务、同会话续接、线程直通和补充指令都刷新当前适用的规则与事实；不会抹掉会话历史或收回已经读过的材料。预算不足仍明确提示，必要材料读不到时应报告阻塞；
- 旧条目缺少这两个字段时保持 `both` 和全部场景，文本修改保留原条件、停用状态及追加／替换模式；降级到旧插件后不会执行这些新条件，不应依赖旧版维持分发边界；
- 用户说「以后都这样」时，Router 用 `superagent_agreement` 保存；面板也可以维护；
- 也可说“把‘测试要求’改为只作用于当前分身”或“仅让执行者在代码审查时遵守”。Router 先读取规则，再按同一 ID 修改 `scope`、`project`、`audience`、`scenes` 或 `mode`；省略的条件保留，不通过新建副本代替修改；
- 已有规则显式设置 `scope: "topic"` 限制到当前分身，`scope: "instance"` 共享到本实例；扩大共享只响应用户的明确要求，协作消息仍不能修改人的约定。总览不能保存分身专属规则，需先切换到具体分身；
- 抽屉的“如何设置和修改规则？”说明常用默认值及自然语言操作；追加／覆盖选项附带说明，未选择具体项目时不可新选覆盖。重新打开抽屉会读取聊天修改后的最新设置；
- 文件损坏时降级为 warning，不影响 Router 启动。

## 定时任务

使用宿主 `@deepseek-ai/dsh-schedule`（`ctx.schedule`），不是插件自己的计时器。
到点后宿主向 Router 投递一条 reminder，Router 被唤醒并自行判断是否派活。
`lib/schedule-bridge.js` 同时适配两代宿主契约：0.2.1 及更早的按会话
`create/list/delete`，0.2.2 起的宿主级 `create({title,prompt,timing,target})`、
分页 `list` 与 `edit({id, action:"delete"})`；旧宿主照常可用。支持：

- `after_seconds`：N 秒后一次；
- `at`：绝对时间（RFC3339）；
- `daily` / `weekly` / `cron`：需要 IANA 时区；
- `every_seconds`：固定间隔（≥60 秒）。

每条必须有 `title`（≤120）和 `prompt`；插件会加
`[super-agent scheduled task]` 框，避免模型把唤醒当成用户即时消息。默认最多
`schedule.maxActive` 条活跃任务。面板可立即执行一次，不影响下一次时间。

## 目标（objective）

长期目标用 `superagent_goal`，不要用宿主的 `create_goal`。差别是**是否自动续轮**：
宿主 goal 由 `dsh-goal-round-driver` 在每轮结束时再唤醒一次，Router 会空转；原生
objective 是**被动**的，只有三种推进来源：

1. **到点检查**：目标的 `cadence` 建一条宿主 schedule，到点唤醒一次，Router 显式
   `check`；
2. **Worker 报告**：`superagent_dispatch` 带 `objective_id`，该任务的报告自动记一条
   `source: "report"` 的检查；
3. **用户指令**：用户说「继续/汇报/改目标」时由 Router 显式 `check`/`update`。

创建或更新目标**不会**唤醒 Router，也不会排 0 延迟调度。没有 `cadence` 就是
`manual`，完全靠报告和用户指令推进。

```json
{
  "action": "create",
  "objective": "把界面改版的 M2 交付完",
  "milestones": ["接入流式消息", "补齐错误态", "通过 Playwright 回归"],
  "every_seconds": 3600
}
```

- `action`：`create` / `list` / `check` / `update` / `close` / `import`。
- `check` 可带 `note`、`complete_milestones`（`ms_N` 或原文）、`source`
  （`user` 默认 / `schedule` / `report`）。
- `update` 可改文本、里程碑（`milestones` 整体替换，`add_milestones` 追加）、
  `status`（`active`/`paused`）和节奏；改节奏会先取消旧 schedule。
- `close` 关闭目标并取消它的检查调度；之后不会再被唤醒。
- `import` 把当前会话里已有的宿主 goal 迁移成 manual 节奏的目标（宿主 goal 保持
  暂停，并被 disarm，不再续轮）。Router 启动时也会自动做一次同样的迁移（幂等：
  同一个 hostGoalId 只迁一次，已完成的 goal 不迁），所以之前 paused 的
  交付目标会被自动接管，不需要额外操作。

节奏选择器和 `superagent_schedule` 一样：`every_seconds`（≥60）、`at`、`daily`、
`weekly`、`cron`。`daily`/`weekly`/`cron` 的墙钟计算交给宿主，目标只保存它返回的
下一次时间。

**关于宿主 goal**：Router 会话里 `create_goal` / `update_goal` 被摘除并拒绝执行，
已有的 armed goal 会被 `disarm`，`get_goal` 仍可读。普通会话不受影响。

## Worker 复用

是否沿用由 Super-agent 根据交付物关联、已有上下文、并行需求与模型要求判断；同一项目或分身不强制共用 Worker。
修改同一交付物时可续用，独立任务、并行复核或更换模型时可新建。用户仍可用自然语言说明偏好。
Router 在 `superagent_dispatch` 里传入一个已完成/等待中任务的 id：

```json
{
  "title": "继续修登录测试",
  "brief": "基于上一轮的失败日志继续，不要重复已完成的部分。",
  "project": "project6",
  "reuse_task_id": "tsk_..."
}
```

- 新任务复用同一个 Worker Session，保留之前的对话、工具状态和项目 cwd；
- 每轮仍有独立任务 ID 和报告，近期活动按真实会话归组；恢复到新会话时明确标记并单独成组，不把恢复来源等同于历史已恢复；
- `scenes` 可指定本轮场景；续用时省略则继承，显式 `[]` 改为仅通用规则。规则或当前事实更新会进入本轮输入；
- 已发送的重点事实、用户明确保存的事实和面板保存的事实发生修订时，同一 Worker 的后续输入会提示版本变化，并优先带上适用的新版；
- 只有源任务处于 `idle` / `blocked` / `resumable`、且 Worker 没有其他
  `starting`/`working` 任务时才允许；
- 新任务必须使用同一 cwd/project；
- 需要独立并行或跨项目时不要复用，直接创建新 Worker；
- 旧任务保持为独立活动记录；关闭其中一个不会掐掉仍被其他任务共享的 Worker。

执行中的纠偏通常使用 steer；已完成一阶段、需要单独跟踪下一轮时使用续接。
预设提醒 Router 保留预期还要修订的执行上下文，并在真正不再需要时关闭；这只是判断引导，不做自动绑定或强制续用。
支持原生子会话续接的宿主可在同项目 Worker 交付并释放后重新打开原会话。任务详情显示「Worker 可续接」，可直接发送补充指令，也可另派一轮任务沿用这段会话。

任务详情显示需要复核的决定及各次报告时已发给 Worker 的决定版本。协调者先查看受影响的产物和
真实验证结果，再在关闭任务时附上 `verification`。其中 `basis` 来自当前任务的 `decisionReview.basis`，
`evidence` 记录实际检查过的文件、提交或命令结果。程序核对报告和决定版本，之后相关决定继续修订时，
任务详情会再次提示复核。正常关闭和取消任务可以不提交这项证据。

## 附件（dispatch / steer）

`superagent_dispatch` 和 `superagent_steer` 都能带 `attachments`，三种写法可以混用：

| 写法 | 含义 |
| --- | --- |
| `/abs/path/file.png` | 绝对路径，原样使用 |
| `relative/file.pdf` | 相对 Worker 项目根；不允许越界 |
| `msg:last`（别名 `msg:latest`） | 当前会话最近一条带附件的用户消息，展开其中全部可引用 part |
| `msg:last:<partIndex>` | 只取该消息 content 数组的第 `partIndex` 个可引用 part（0 起） |
| `msg:<messageId>` | 精确引用当前会话里的某条消息 |
| `msg:<messageId>:<partIndex>` | 精确消息 + part 下标 |

`msg:` 引用由插件通过宿主 attachment service 定位，复制到
`<dataDir>/attachments/<taskId>/`，再把**副本的绝对路径**交给 Worker；图片用
`read_image` 读，文件用 `read`。原会话对象、用户源文件和 `~/.dsh` 不直接交给 Worker。

- 限额：展开后最多 8 个文件、每个 10 MiB、合计 30 MiB（`worker.attachments` 可覆盖）。
- 目录、符号链接、缺失/失效引用、越界 part 和不支持的图片格式（BMP/TIFF/HEIC/AVIF/ICO）
  都显式报错；复制失败整体拒绝，不会留下半个任务。
- `steer` 的副本同样落在这一个任务目录下，并在给 Worker 的消息后追加附件绝对路径。
- 暂存副本不自动清理；本插件没有删除逻辑。

```json
{
  "title": "按附件里的链路补回归",
  "brief": "先看 architecture.png，再补 msg:last 的边界用例。",
  "project": "dsh-super-agent",
  "attachments": ["msg:last", "msg:last:1"]
}
```

## 中途指令

任务有 live Worker 时，`superagent_steer`、面板输入框和
`POST /api/super-agent/ui/task/steer` 都能给 Worker 补一条消息。默认是**插队**
（`interrupt: true`）：

- 消息进宿主的 `next-step` 队列，Worker 在**当前 run 的下一个模型步**之前读到；
- 宿主只在 step 边界注入，正在执行的工具调用会先安全结束，不会被打断；
- 这只影响消息何时被 Worker 看见，不改变任务归属；Worker 的最终报告仍以
  `turn/end` trigger 回到 Router。
- 本次输入刷新当前规则与事实；工具的可选 `scenes` 可替换场景，省略则保留。面板补充指令保留原场景，若需重新安排工作可在普通聊天中交给 Super-agent 判断。

需要“等这一轮做完再处理”时用排队（`interrupt: false`，兼容旧行为）：消息作为独立的
follow-up turn，当前 run 结束后才被消费。两种模式都立即返回 `accepted`，回执里的
`mode` / `interrupt` / `delivery`（`next-step` 或 `next-turn`）标明实际模式；
journal 的 `task.steered` 事件也记录 `mode` 与 `interrupt`；任务详情
`/ui/task` 和 `superagent_status` 的 activity 行会带 `lastSteerMode` /
`lastSteerInterrupt`，可回看最后一次 steer 的模式。

选择建议：纠偏、补充约束、回答 Worker 的问题用插队；交接给下一段工作、不希望改变
当前步骤目标时用排队。旧宿主 Agent 没有 `steer()` 时自动退回排队，并在回执里给
`warning`。

### 重启之后

`dsh web` 重启后 Worker 会话从内存里消失，任务注册表（journal）还在。启动时插件
会对每条非 closed 任务尝试 `sessionController.resolveAgent()` 把会话装回内存：

| 结果 | 状态 | 怎么继续 |
| --- | --- | --- |
| 会话装回来了 | `resumable` | `reuse_task_id` 续同一会话（上下文完整，被打断那一轮不重放） |
| 会话装不回来 | `interrupted` | `reuse_task_id` 用原 brief 起新 Worker（继承项目/模型/目标/线程，记 `resumedFrom`），或 close |

`interrupted` 取代了重启路径上的 `lost`；`lost` 只留给「跑着的时候 Worker 会话被
宿主回收」。`superagent_status detail=full` 里能看到这两种状态和每条任务的 brief。

Worker 的最终 assistant 消息仍是报告，以 trigger 回到 Router。

## CLI

```sh
node bin/super-agent.mjs init [--project DIR] [--data-dir DIR]
node bin/super-agent.mjs enable|disable [--project DIR]
node bin/super-agent.mjs emit ...
node bin/super-agent.mjs status [--full] [--json]
node bin/super-agent.mjs recall <id> [--max-chars N] [--json]
node bin/super-agent.mjs outbox [--channel C] [--since …] [--json]
node bin/super-agent.mjs config
```

`emit` 会追加 `<dataDir>/inbox.jsonl`，宿主下次轮询消费；不需要宿主正在运行。

## HTTP

所有端点走 DSH 的 `/api` 鉴权栏：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/super-agent/ingest` | 投一条事件，body 同 `emit` 的 JSON |
| GET | `/api/super-agent/status` | 健康状态 + 紧凑快照 |
| GET | `/api/super-agent/outbox?channel=im&since=…` | 读待发送的人类消息 |
| GET | `/api/super-agent/ui/state` | 面板状态、项目、任务、workspace sessions |
| POST | `/api/super-agent/ui/ensure` | 确保总览或主题；可传 `instance_id`、`topic_id`，兼容旧 `cwd` |
| GET/POST | `/api/super-agent/ui/topics` | 管理主题与事实、主动整理、配置本实例的自动整理与记忆模型 |
| POST | `/api/super-agent/ui/topics/ensure` | 创建／恢复已登记主题的宿主会话；必传 `instance_id`、`topic_id` |
| POST | `/api/super-agent/ui/focus` | 兼容旧脚本的 focus 设置 |
| POST | `/api/super-agent/ui/reset` | 仅总览可用：中止并归档本实例 Worker、取消定时任务、切换 generation、创建新总览 |
| GET | `/api/super-agent/ui/activity?limit=N&cursor=…` | 近期活动（含已结束）。进行中优先；`limit` 默认 20、最大 500，返回 `total` / `nextCursor` / `hasMore` |
| GET | `/api/super-agent/ui/task?task_id=…` | 单个任务详情：Brief、报告、线程、Worker 是否在线 |
| POST | `/api/super-agent/ui/task/steer` | 给在线 Worker 发一条指令，body `{task_id,text,interrupt?}`；`interrupt` 默认 true（插队到当前 run 的下一步），false 为排队；`mode:"queue"` 是等价别名 |
| GET/POST | `/api/super-agent/ui/models` | 读/写 Worker 模型 allowlist 和默认选择 |
| POST | `/api/super-agent/ui/models/default` | 保存默认 Worker 模型集合，body `{"defaults":[{provider,model,…}]}` |
| GET/POST | `/api/super-agent/ui/agreements` | 读/写长期工作约定 |
| GET/POST | `/api/super-agent/ui/schedules` | 读/建定时唤醒 |
| POST | `/api/super-agent/ui/schedules/run` | 立即执行一次某条定时任务 |
| POST | `/api/super-agent/ui/schedules/cancel` | 取消某条定时任务 |

主动整理向主题接口提交 `action: "memory_review"`、`scope: "topic" | "instance"`、
`run: true`；开关提交同一 action 与 `auto: true | false`。携带 `instance_id/topic_id`
定位实例和分身。群整理向协作接口提交同一 action、`group_id` 与 `run: true`。
这些是操作者界面入口，不向模型开放范围或权限配置。

主题接口的 `GET ?memory_models=1` 返回宿主模型和可选思考强度。提交
`action: "memory_model"` 与 `selection: { provider, model, reasoningEffort? }` 保存本实例选择。
`selection: null` 恢复跟随 Worker 默认，省略 `reasoningEffort` 则使用所选模型的默认强度。

## 配置文件

`<项目根>/.dsh/super-agent.json`：

```json
{
  "version": 1,
  "enabled": true,
  "dataDir": ".dsh/super-agent",

  "agents": ["super-agent", "superagent", "助手"],

  "sources": {
    "im":     { "mode": "addressed", "requireMention": true },
    "github": { "mode": "candidate" },
    "email":  { "mode": "candidate" },
    "ci":     { "mode": "candidate" }
  },
  "defaultSource": { "mode": "addressed", "requireMention": false },
  "ignoreActors": ["spam*"],
  "redact": true,
  "storeFullText": true,

  "router": {
    "maxBatch": 24,
    "batchDebounceMs": 200,
    "maxBatchChars": 12000,
    "inlineChars": 280,
    "sessionId": "",
    "guardExecutionTools": true
  },

  "worker": {
    "spawnProvider": "spawn",
    "maxWorkers": 4,
    "maxReportChars": 4000,
    "defaultCwd": "",
    "initialContextChars": 12000,
    "routeTextChars": 8000
  },

  "watchdog": {
    "enabled": true,
    "intervalMs": 30000,
    "pendingStaleMs": 90000,
    "startTimeoutMs": 120000,
    "lostGraceMs": 10000,
    "idleStaleMs": 300000,
    "repeatMs": 600000
  },

  "models": {
    "allowed": [],
    "defaults": [],
    "default": "",
    "defaultEffort": "",
    "onlyProvider": "",
    "onlyNames": []
  },

  "agreements": {
    "fileName": "super-agent.agreements.json",
    "maxItems": 40,
    "maxCharsPerItem": 2000,
    "injectChars": 6000
  },

  "context": {
    "maxChars": 12000
  },

  "schedule": {
    "maxActive": 20,
    "timeZone": "",
    "frame": true
  },

  "voice": {
    "style": "brief",
    "maxWords": 120,
    "expandWhenAsked": true
  },

  "channels": {
    "im":     { "maxWords": 100, "guidance": "One decision or result." },
    "github": { "maxWords": 600, "guidance": "Context, change, verification." },
    "email":  { "maxWords": 500 }
  }
}
```

容易误用的字段：

- `sources.<name>.mode`：`addressed`（默认 IM，需点名）、`candidate`（候选，
  由 Router 判断）、`ignore`（程序层丢弃）。
- `requireMention`：`addressed` 模式下是否要求 `@agent` / `mentions` / `direct`。
- `actorsDeny` + `ignoreActors`：支持末尾 `*` 通配；`ignorePatterns` 是正文正则。
- `dataDir`：相对项目根或绝对路径；拒绝盘符根、`~/.dsh`、系统目录。
- `router.sessionId`：固定 Router 会话；留空表示本项目第一个根会话。
- `worker.maxWorkers`：同时执行中的 Worker 上限；完成的 Worker 让出执行槽位，
  queued 任务自动补位。idle Worker 可供 steer/Thread 直通。
- `channels.<name>.maxWords`：`superagent_tell` 硬上限；`0` 表示不限。
- `redact`：进入 journal 前遮盖常见 key/token；不是安全边界。
- `models.allowed`：Router 唯一可选的 Worker 模型；空数组时优先按
  `models.defaults`，没有再按 `onlyProvider` / `onlyNames` 过滤，最后才跟随宿主
  全部目录。面板会显示过滤原因和“DSH 共 N 个”的总数。`default` 必须是 allowlist
  里的 `id` 或 `provider/model`。
- `models.defaults`：面板「设为默认」保存的默认集合，每项 `{provider, model}`
  加可选 `id/label/efforts/defaultEffort`。新实例会继承；目录里已不存在的项静默
  跳过，不会因为缺一项就回退成全部模型。
- `models.defaultEffort`：默认思考强度；为空用模型自己的默认。
- `approval.mode`：`ask` / `auto-workspace` / `deny-all`；本版本只记录，不自动
  回答。`watchdog.approvalTimeoutMs` 是审批等待升级时间（默认 60000ms）。
- `watchdog.startTimeoutMs`：任务停在 `starting` 多久判启动失败（默认 120000ms）；
  未超时前 watchdog 不会因为“还查不到 Worker 会话”判 lost。
- `watchdog.lostGraceMs`：`working`/`blocked-approval` 首次查不到 Worker 后的宽限
  窗口（默认 10000ms）；下一次 watchdog 检查仍查不到才落 lost，期间恢复则撤销。
- `agreements.fileName`：相对项目根 `.dsh/` 的文件名；一般不用改。
- `context.maxChars`：受管理主题持久上下文的字符预算，默认 12000；不含宿主聊天与工具输出。
- `memory.enabled`：是否启用空闲自动整理，默认 true；各实例可在记忆页单独关闭。
- `memory.idleMs`：相关对话与任务结束后的整理等待，默认 900000，最低 1000 毫秒；
  活跃期间合并等待，新输入和并发编辑使旧整理结果失效，失败不会按同一材料反复重试。
- `schedule.maxActive`：活跃定时任务上限；`timeZone` 是未传时区时的默认 IANA
  时区，空表示用宿主本地时区。
- `voice.maxWords`：`superagent_tell` 的短回复上限；`expandWhenAsked` 允许用户
  明确要求长答时放宽。

配置坏了（JSON 语法、路径越界、字段类型）时插件保持关闭并记 warn，不会阻止
普通会话创建。

## 频道桥

插件不直接调用 IM/GitHub API。桥接器读 `outbox.jsonl`：

```sh
tail -F /path/to/project/.dsh/super-agent/outbox.jsonl
```

每行包含 `id`、`channel`、`text`、`threadId`、`taskId`、`words`、`createdAt`、
`status`。发送成功后由桥接器自行记录回执；插件不删除 outbox 行。

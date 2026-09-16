# dsh-plugin-context

DeepSeek Harness 的上下文管控：量出下一次请求真正要带的东西（toolCall → toolResult、每条消息、每段推理），**并且能够改**——把过大的 toolResult、过长的 CoT、过长的输出压下去。改不改、按什么策略改，是配置和策略函数的事，插件本身先把这条管线接好。

页面侧给两个座位：**Context Control 视图**（完整面板）和**会话头部的压力表**。

## 设计原则

**1. 默认什么都不改。** 每个 kind 的默认策略都是恒等函数 `(input) => input`，默认动作是 `report`。装上插件后，一次会话里唯一的变化是它变得**可见**了。

**2. 能改的接缝，只在你要的时候才挂上。** `tools/post-execute`、`tools/ptc-dispatch-log`、`llm/stream` 这三个能改写内容的监听器，只有在对应 kind 被设成 `rewrite` 时才注册。全部保持 `report` 时，本插件在任何能改变请求的路径上**没有任何监听器**。

**3. `report` 是预演，不是空转。** 超预算的条目在 `report` 模式下**照样会跑一遍策略**，结果记为 `applied: false`。面板因此能告诉你"这个策略本可以省掉 18 400 个字符"，而实际一个字节都没动。（代价是：策略是用户代码，可能有副作用——这点写在这里，而不是藏起来。）

**4. 同一份数据只画一遍。** 面板的第一版把栈、最大的条目和调用流量画成了三张卡，其实是同一批行按不同顺序排了三遍——于是"按工具筛一下"要筛三次，而三张卡可以互相矛盾。现在只有一份**查询结果**，三种画法（表 / 排行 / 汇总）都读它。

**5. 只在自己能承担的接缝上动手。** 策略抛异常、返回了不该返回的结构、想丢一张图片——一律**拒绝并记录**，被观察的那次调用照原样继续。一个会把正在管理的回合弄坏的上下文管理器，比没有更糟。

## 三个接缝，以及为什么 CoT 只能在生成时管控

| 目标 | 接缝 | 时机 | 结果落在哪 |
| --- | --- | --- | --- |
| 过大的 toolResult | `tools/post-execute` → `{kind:'accept', content}` | 结果落盘之前 | 直接成为持久的 `tool/result` 事件，也就是下一次请求看到的内容 |
| PTC 子调用（`run_code` 里的工具）的 toolResult | `tools/ptc-dispatch-log` → `ContentBlock[]` | 同上 | 同上（`min-ptc` 预设下大部分工具调用走这里） |
| 过长的 CoT / 输出 | `llm/stream` | 生成时 | 流式截断 |

**为什么 CoT 不能事后修剪：框架不允许。** 一个 `assistant/message` 永远不能携带 `sourceEventSeqs`，而一次 surface replace 必须覆盖它遮蔽的每一个节点——两条规则互斥，所以 `assistant/message` **不可能**被 surface replace。检查整个 checkout，没有任何一处修剪 reasoning 的生产者。所以这里不去对抗它：推理和输出在**生成时**按预算截断，这也是唯一诚实的做法。

流式截断的语义写清楚了：已经吐出去的文本收不回来，所以策略在第一次越过预算时被问一次"这个块本该有多长"，然后按答案**停在那里**。恒等策略回答"我看到的全都留下"，于是流继续——**默认是真·无操作，而不是偷偷截断**。

## 已落地的 toolResult 改写，抄的是框架自己的写法

改写一个**已经落盘**的 toolResult（面板上的"应用策略"），走的是官方 `toolResultPruner` 的同一条路：先同步追加一条 `compaction/prune` 影子计价事件，紧接着追加一条只改 `message` 的 `tool/result` replace，`sourceEventSeqs` 引用被遮蔽的节点。`src/surface.ts` 一个文件读完，并且每一步都宁可拒绝也不猜。

## 面板

**Context Control 视图**（`conversation.view`，与 Chat / Trajectory / dsh-context 的 Context 并列，是新增的一个，不替换任何东西）：

- **当前上下文** — 整条上下文一根堆叠柱，图例给出 token 数与占窗口的比例。**柱子的每一段和图例的每一条都是筛选器**：点"工具结果"就把下面的表筛到那一类。**只有一个例外**：「固定请求开销」（旧名"系统提示与工具 schema"）不是一个节点，它是 `total − surface` 的残差——请求自己的工具 schema、请求框架，加上逐节点计价没算到的部分——按钮禁用，悬停里说明它由什么组成。
- **「系统提示词」是它自己的一个节点**（surface 上的 `system/message`；框架里唯一的生产者是 `dsh-agent-loop` 的 SystemPromptProjection，compaction 也把这个节点叫 "the system prompt held by the system/message at surface node 0"）。它以前叫"注入的上下文"，看起来就像系统提示词被算了两遍——其实是两个名字都起错了：那个残差里根本没有系统提示词。
- **查询条** — 预设（全部 / 可改写 / 超预算 / 工具结果 / 推理与输出 / 最后一轮 / 出错 / 子调用 / run_code 调用 / 大条目 / 慢）加**可编辑条件**（字段 + 运算符 + 值，可增删）、排序（字段 + 升降序）、分组（不分组 / 类型 / 工具 / 轮次）与分页（`匹配 N 条 · 共 M 条 · 显示 1–50`）。预设不是第二套过滤机制：它编译成与手写条件完全相同的条件，所以"可改写"和显式写 `actionable is 是` 不可能不一致。
- **一张表，三种画法** — 表（`#` / 类型 / 节点 / tok / 字符 / 状态 / 动作）、排行（每行一根条）、汇总（按分组键合计并给出占比），三者读同一个查询结果，所以不可能对"匹配了什么"有分歧。（切到**汇总**时若还没选分组，会按该域的第一个可分组字段自动分组——下拉里显示的就是它；"不分组"的汇总没有东西可合计，而对着一个非空结果画一句"没有符合条件的条目"是骗人的。）范围切到**调用**时读的是日志而不是 surface：`run_code` 的子调用带着真实工具名、参数字节、结果字节、耗时与错误出现，并明确标出"子调用 / 未进 context"。
- **选中（批量）** — 当前筛选结果里可改写的节点就是选中集：`预演` 给出"共省 N 字符 · M 条会变"与逐条 `before → after`，**一个字节都不动、也不写日志**；`应用` 走同一条 host 路由逐条落盘，被拒绝的（不在 surface、回合已关、策略抛错）逐条列出原因。
- **干预日志** — 默认折叠、计数常驻；展开后是每次策略运行的 `字符 before → after` 与"已应用 / 预演 / 已拒绝"标记。
- **配置（右侧常驻栏）** — 总开关、每个 kind 的开关 / 预算 / `report|rewrite` / 策略名、每页行数与日志长度、保存 / 放弃，以及"用官方 pruner 立刻裁一次"。它以前排在两百行栈之下——那是一个控件被遗忘的位置；现在它随滚动常驻在右边，视口窄于 900px 时自动落回单列。

**会话头部压力表**（`conversation.session.header.utilities`）：`12.3k / 128k` 加一条进度条，后面一个小符号表示当前是"改写已武装（✎）"还是"仅报告（◦）"。鼠标悬停给出各分类的构成。它 10 秒轮询一次，视图只在被选中时才挂载并轮询。

**文案跟随界面语言。** 面板和压力表里没有一个写死的句子：所有文案都在客户端注册的 `context-control` 命名空间字典里，英文与中文**并排放在同一张表**（`DICT` 由这张表投影出来，所以两种语言的 key 集合不可能不一致）。两个座位在注册时声明 `locale: "context-control"`，渲染器据此把官方的 `t` 座位注入组件 props；在 Settings → General 里换语言时，已挂载的插槽会重渲染——不刷新页面，也不重新注册座位。host 侧送来的分类名（`prefix` / `tool-result` / …）带稳定 `key`，客户端按 key 翻译，翻不到才回落到宿主自己的措辞，所以 **host 半不需要知道语言**。内建语言只有 `zh` 和 `en` 两种，缺 key 依次回落英文、再回落 key 本身，字典可以分批补；组件在没有 `t` 座位时（比如被单独调用）用打包在文件里的英文继续说话，不会抛错。

所有颜色都来自文档化的主题 token（`--dsw-alias-*`），没有硬编码色值——所以浅色/深色主题都能用。分类色是用四个 token 加透明度加一种斜纹拼出来的，因为主题里没有分类色板。

## 配置

**持久配置放在 composition 里。** 面板上的修改是**进程内实时**生效的（本插件没有接 `settings` 命名空间，见"已知限制"）。要给一个 profile 钉住配置，写一条**不带 `insert`** 的定向 patch（重复 insert 会因为 `duplicate loader entry id` 让 profile 起不来）：

```yaml
- id: dsh-plugin-context
  config:
    enabled: true
    kinds:
      tool-result: { maxChars: 12000, onOver: rewrite }   # 过大的 toolResult：改写
      reasoning:   { maxChars: 16000, onOver: report }    # CoT：只看
      output:      { maxChars: 16000, onOver: report }
    policies:
      tool-result: head-tail     # identity（默认）| head-tail
    topN: 12                   # 面板每页多少行（也是排行/汇总的取样长度）
    logLimit: 200
```

预算单位是 **Unicode 码点**（不是 UTF-16 单元），和官方 pruner 的度量一致。

## 策略就是一个函数

```ts
type Policy = (input: PolicyInput) => PolicyOutput | Promise<PolicyOutput>
const identity: Policy = (input) => input
```

`PolicyInput` 里有：`kind`、`sessionId`、`turn` / `step`、`callId` / `toolName`、`blocks`（每个块带 `index` / `type` / `text` / `chars` / `raw`）、`chars`、`tokens`、`maxChars`、`over`、`reason`。返回同样的结构，改动只允许落在 `text` 上，或者把某个**带文本**的块标 `drop: true`。

不允许：新增/重排块、改块类型、给非文本块凭空写文本、丢掉非文本块（图片、tool-call 的 payload 必须原样留在 `raw` 路径上）。越界即拒绝，原内容照用。

接一个好的策略有两种方式：

1. 在 `src/policies.ts` 的 `BUILT_IN_POLICIES` 里加一条 `名字: () => Policy`，然后在配置或面板里选这个名字。压缩包自带 `head-tail` 作为演示（off by default），它的不变量是"返回的一定比给的小"——当 marker 都塞不进预算时它直接不动，因为把长内容换成一个 marker 加两个残段会让内容**变长**。
2. 拿 `ContextControl` 实例的 `policies.set(kind, policy, name)`。

## 安装

```sh
dsh plugin --profile web add <本包>      # 或 git 地址
# 重启 profile 后生效
```

`lib/` 不入库，由 `prepare`（`npm run build`）编译。pnpm 默认拦截 git 依赖的构建脚本，首次 `add` 会提示构建被忽略；把 `dsh-plugin-context: true` 加到 profile 目录（`$DSH_HOME/profiles/web/`）的 `pnpm-workspace.yaml` 的 `allowBuilds` 下，再跑一次安装命令。

客户端产物**不需要打包器也不需要 Vite**：`dsh-client-modules` 原样提供 `exports["./client"]` 指向的文件（只做拼接和 source map），该文件自己调用 `window.__ModuleLoader__.load({ id, factory })`。HMR 轮询的是**编译后的那个文件**（`lib/client.js`），所以 `tsc --watch` 就是热更新的开发循环。

## 验证

**单元与接线测试**（97 个，含在 `vm` 里真的执行编译出来的浏览器半成品）：

```sh
npm test
```

**用真实 session 日志校验数据模型**（本插件最大的风险是"字段名猜错"——猜错不报错，只是面板全是 0）：

```sh
npm run verify                 # 取 $DSH_HOME/sessions 下最新的会话日志
npm run verify -- <日志路径>
```

它逐帧解开 zstd（会话日志是**多个拼接的 zstd frame**，单帧解码只会得到一行 header——正是这类"安静的成功"要被挡住），然后用 `lib/` 里真正的读取函数跑一遍：每个 `tool/call` 是否读出工具名、每个 `tool/result` 是否读出 callId、120 个调用能否 join 成对、每个 surface 事件是否带 surfaceOp、assistant 消息的 reasoning 与 text 能否分开。对不上就非零退出。

**实测结论**（当前 workspace 的一次真实会话，634 个事件）：

| | |
| --- | --- |
| 上下文构成（字符） | reasoning 510 243 · user 369 146 · tool-result 336 142 · assistant 58 067 · system 18 047 |
| 最大单条 toolResult | `cordis_inspect_query` 49 999 / 42 164 字符 |
| 最大单条 CoT | 20 700 字符 |
| toolCall → toolResult | root 调用全部 join 成功；`write` 参数 221 874 字符，`bash` 结果 76 334 字符 |
| 子调用（`min-ptc`） | `tool/ptc-dispatch` 给出真实工具名与参数字节（一次会话 bash 156 / memo 8），而 root call 全部是 `run_code`——这正是这张表存在的理由 |

**推理是最大的一项**——比 tool-result 还大。这正是本插件把 CoT 预算和 toolResult 预算分开的原因，也说明默认的 16 000 / 24 000 字符预算对于一个带着子代理的长会话是偏松的。想收紧就先看 `npm run verify` 的输出，再决定 composition 里的数字。

**装到 profile 之后**（本插件注册进 `dsh.profile.bundles` 的新 bundle **只在启动时**进 boot graph，`patchReload: "live"` 不会把一个新包挂进来，所以需要重启 profile）：

```sh
dsh plugin --profile web add <本包>     # 重启 profile 后生效
curl -s localhost:3080/context/config | head -c 200
curl -s "localhost:3080/context/state?sessionId=<会话 id>" | head -c 200
```

页面上应出现两处：会话视图切换器里多一个 **Context Control**（与 Chat / Trajectory / Context / Memo 并列），会话头部右侧多一个 `12.3k / 128k` 的压力表。

## 开发

```sh
npm install --cache ./.npm-cache   # npm 缓存默认在 workspace 外，沙箱里不可写
npm run verify                     # 用真实会话日志校验数据模型
npm run build                      # src/*.ts -> lib/*.js
npm run check                      # tsc --noEmit
npm test                           # build 后跑 97 个测试
```

`src/` 是 TypeScript 源码，`lib/` 是产物（不入库）。测试里最值得看的三组：

- `test/control.test.mjs` —— 钉住"默认什么都不改"、"report 是预演"、"恒等策略下流式直通"这些**安全性质**；
- `test/client.test.mjs` —— 在 `vm` 里**真的执行**编译出来的浏览器半成品，验证它自注册、只占两个新增座位、CSS 里没有硬编码颜色；**查询引擎**（过滤/排序/分组/分页/预设编译成条件）在纯行上验；以及**画出来没有一个字绕过字典**（用一个返回 `⟦key⟧` 的假 `t` 渲染全部卡片，再断言树里没有留下任何英文原句、且每个被问到的 key 都真实存在）；
- `test/host.test.mjs` —— 驱动真正的 `apply` 和三条 HTTP 路由：默认不挂任何可改写监听器、切到 `rewrite` 只多那几个、切回来全部撤销。

**加一条文案**：在 `src/client.ts` 的 `COPY` 表里加一行 `"key": [英文, 中文]`（两列一起给，语言就不可能不对称），渲染处用 `t("key")`；需要插值就写 `{name}`，调用时 `t("key", { name })`。`t` 在组件的 props 上，卡片函数则把 `t` 当最后一个参数收。

**加一个筛选维度**：在 `FIELDS` 的对应域里加一条 `{ key, label, type }`（`type` 决定条件编辑器给出数值框、是/否选择还是文本框），在 `row` 构造里带上这个字段，需要出现在分组下拉里就再加进 `GROUP_FIELDS`——但 `GROUP_FIELDS` 里的每个键**必须**也已经是 `FIELDS` 里的一条，否则分组下拉会渲染 `null.label` 并把整个视图带崩（调用域的 `turn` 就这么崩过一次）；这条不变式由测试守着，不要只靠眼睛。查询条、表头、排行与汇总都从这张表读，所以不会漏。

## 已知限制

- **面板配置不持久**：重启后回到 composition 的配置。要持久化就写 composition patch（上面那段）。接官方的 `settings` 命名空间需要 `@deepseek-ai/schemastery` 依赖，留作下一步。
- **文案走的是官方的 locale 服务**：这一半要求 composition 里挂着 `@deepseek-ai/dsh-client-locale`（web roster 默认就有）。座位只要声明了 locale 命名空间，而 locale face 不在 composition 里，插槽装配就会直接抛错——这是有意的：宁可立刻说清楚，也不要静默显示一堆 key。
- **手动改写已落盘节点要求在打开的 turn 内**：`tool/result` 的 surface replace 受 `dsh-session` 的 turn 不变量约束（该不变量只在 `dsh-sdk-minimal` 里挂载）。面板会把宿主给出的拒绝原因原样显示。
- **`args ch` 有两个来源，而且日志里的 `arguments` 有两种形态**：root 调用读 `tool/call`，子调用读 `tool/ptc-dispatch(-start)`。这个字段在真实日志里**既是 JSON 字符串又是 JSON 值**（一次会话里 322 处是对象、2 处是字符串），只读字符串形态会让整张流量表悄悄变成 0——所以 `argsTextOf()` 是唯一的读入口。运行时瀑布 `PtcDispatchLog` 本身仍不带参数，策略在那个接缝上看不到参数。
- **子调用的结果不在上下文里**：`tool/ptc-dispatch` 是 log-only 事件（`deriveMessages()` 忽略它），所以子调用的字节只进流量表、不进上面那根柱状图。面板用"未进 context"这个标记说清这件事，而不是把它算进 token。
- **工具自己声明了 `finalizeContent` 时它说了算**：它在 `post-execute` 之后运行，可以覆盖本插件的改写。
- **`tools/post-execute` 只塑造新结果**，改不了历史；历史节点走上面那条 surface replace。
- 本插件**不发布 service**，所以不需要 `isolate` realm，可以直接挂在 profile 上。

## 依据

`surface.ts` 的写法、`compaction/prune` 影子计价的顺序、`PostToolDecision` 的形状，都来自 checkout 里 `@deepseek-ai/dsh-compaction-tool-result-pruner` 的 `pruneSession` 与 `@deepseek-ai/dsh-tools` 的 `postExecute`。度量数字来自官方 `tokenMeter.measure(session)`（与 composer 上那个上下文环是同一个投影），字符数才是本插件自己数的。**构成里的前缀是减出来的**，不是量出来的：框架的仪表定义是 `total = max(0, baseline + surfaceDelta)`，而 baseline 是一次整请求的锚点，直接当"系统提示"用就会把 surface 算两遍——`prefix = max(0, total − surface)` 是唯一诚实的算法。子调用的名字与参数字节来自 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 这两个 log-only 事件（`dsh-tools/lib/types/types.d.ts` 的 `PtcDispatchStartEventData`）。

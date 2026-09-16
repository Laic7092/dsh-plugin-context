# dsh-plugin-context

DeepSeek Harness 的上下文管控：量出下一次请求真正要带的东西（toolCall → toolResult、每条消息、每段推理），**并且能够改**——把过大的 toolResult、过长的 CoT、过长的输出压下去。改不改、按什么策略改，是配置和策略函数的事，插件本身先把这条管线接好。

页面侧给两个座位：**Context Control 视图**（完整面板）和**会话头部的压力表**。

## 设计原则

**1. 默认什么都不改。** 每个 kind 的默认策略都是恒等函数 `(input) => input`，默认动作是 `report`。装上插件后，一次会话里唯一的变化是它变得**可见**了。

**2. 能改的接缝，只在你要的时候才挂上。** `tools/post-execute`、`tools/ptc-dispatch-log`、`llm/stream` 这三个能改写内容的监听器，只有在对应 kind 被设成 `rewrite` 时才注册。全部保持 `report` 时，本插件在任何能改变请求的路径上**没有任何监听器**。

**3. `report` 是预演，不是空转。** 超预算的条目在 `report` 模式下**照样会跑一遍策略**，结果记为 `applied: false`。面板因此能告诉你"这个策略本可以省掉 18 400 个字符"，而实际一个字节都没动。（代价是：策略是用户代码，可能有副作用——这点写在这里，而不是藏起来。）

**4. 只在自己能承担的接缝上动手。** 策略抛异常、返回了不该返回的结构、想丢一张图片——一律**拒绝并记录**，被观察的那次调用照原样继续。一个会把正在管理的回合弄坏的上下文管理器，比没有更糟。

## 三个接缝，以及为什么 CoT 只能在生成时管控

| 目标 | 接缝 | 时机 | 结果落在哪 |
| --- | --- | --- | --- |
| 过大的 toolResult | `tools/post-execute` → `{kind:'accept', content}` | 结果落盘之前 | 直接成为持久的 `tool/result` 事件，也就是下一次请求看到的内容 |
| PTC 子调用（`run_code` 里的工具）的 toolResult | `tools/ptc-dispatch-log` → `ContentBlock[]` | 同上 | 同上（`min-ptc` 预设下大部分工具调用走这里） |
| 过长的 CoT / 输出 | `llm/stream` | 生成时 | 流式截断 |

**为什么 CoT 不能事后修剪：框架不允许。** 一个 `assistant/message` 永远不能携带 `sourceEventSeqs`，而一次 surface replace 必须覆盖它遮蔽的每一个节点——两条规则互斥，所以 `assistant/message` **不可能**被 surface replace。检查整个 checkout，没有任何一处修剪 reasoning 的生产者。所以这里不去对抗它：推理和输出在**生成时**按预算截断，这也是唯一诚实的做法。

流式截断的语义写清楚了：已经吐出去的文本收不回来，所以策略在第一次越过预算时被问一次"这个块本该有多长"，然后按答案**停在那里**。恒等策略回答"我看到的全都留下"，于是流继续——**默认是真·无操作，而不是偷偷截断**。

## 已落地的 toolResult 改写，抄的是框架自己的写法

改写一个**已经落盘**的 toolResult（面板上的 "Apply policy"），走的是官方 `toolResultPruner` 的同一条路：先同步追加一条 `compaction/prune` 影子计价事件，紧接着追加一条只改 `message` 的 `tool/result` replace，`sourceEventSeqs` 引用被遮蔽的节点。`src/surface.ts` 一个文件读完，并且每一步都宁可拒绝也不猜。

## 面板

**Context Control 视图**（`conversation.view`，与 Chat / Trajectory / dsh-context 的 Context 并列，是新增的一个，不替换任何东西）：

- **Current context** — 整条上下文一根堆叠柱：system prompt 与工具 schema、tool results、assistant 输出、推理、用户消息、注入上下文，加上窗口的剩余余量（斜纹）。图例给出 token 数与占比。
- **Stack in request order** — surface 上的每个节点一行，条形宽度就是它的 token 数。这是"栈"的逐节点版本：一眼看出是谁把窗口撑起来的。
- **Largest entries** — 按 token 排行的节点，和按"参数 + 结果"排行的工具调用，两张横向柱状图。
- **toolCall → toolResult** — 每个调用一行：参数字符数、结果字符数、结果 token（已离开上下文就写 `left ctx`，不写 0）、耗时、错误与超预算标记。
- **Interventions** — 每次策略运行：`字符 before → after`、省下多少、`applied`（已应用）/`dry run`（只是预演）/`refused`（被拒绝）。
- **Configuration** — 总开关、每个 kind 的开关 / 预算 / `report|rewrite` / 策略名、排行与日志长度，以及"用官方 pruner 立刻裁一次"。

**会话头部压力表**（`conversation.session.header.utilities`）：`12.3k / 128k` 加一条进度条，后面一个小符号表示当前是"改写已武装（✎）"还是"仅报告（◦）"。鼠标悬停给出各分类的构成。它 10 秒轮询一次，视图只在被选中时才挂载并轮询。

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
    topN: 12
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

**单元与接线测试**（82 个，含在 `vm` 里真的执行编译出来的浏览器半成品）：

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
| toolCall → toolResult | 120 对全部 join 成功；`write` 参数 221 874 字符，`bash` 结果 76 334 字符 |

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
npm test                           # build 后跑 82 个测试
```

`src/` 是 TypeScript 源码，`lib/` 是产物（不入库）。测试里最值得看的两组：

- `test/control.test.mjs` —— 钉住"默认什么都不改"、"report 是预演"、"恒等策略下流式直通"这些**安全性质**；
- `test/client.test.mjs` —— 在 `vm` 里**真的执行**编译出来的浏览器半成品，验证它自注册、只占两个新增座位、CSS 里没有硬编码颜色；
- `test/host.test.mjs` —— 驱动真正的 `apply` 和三条 HTTP 路由：默认不挂任何可改写监听器、切到 `rewrite` 只多那几个、切回来全部撤销。

## 已知限制

- **面板配置不持久**：重启后回到 composition 的配置。要持久化就写 composition patch（上面那段）。接官方的 `settings` 命名空间需要 `@deepseek-ai/schemastery` 依赖，留作下一步。
- **手动改写已落盘节点要求在打开的 turn 内**：`tool/result` 的 surface replace 受 `dsh-session` 的 turn 不变量约束（该不变量只在 `dsh-sdk-minimal` 里挂载）。面板会把宿主给出的拒绝原因原样显示。
- **PTC 子调用的参数大小未知**：`PtcDispatchLog` 不带参数，所以那一行的 `args ch` 是 0 而不是编一个数字。
- **工具自己声明了 `finalizeContent` 时它说了算**：它在 `post-execute` 之后运行，可以覆盖本插件的改写。
- **`tools/post-execute` 只塑造新结果**，改不了历史；历史节点走上面那条 surface replace。
- 本插件**不发布 service**，所以不需要 `isolate` realm，可以直接挂在 profile 上。

## 依据

`surface.ts` 的写法、`compaction/prune` 影子计价的顺序、`PostToolDecision` 的形状，都来自 checkout 里 `@deepseek-ai/dsh-compaction-tool-result-pruner` 的 `pruneSession` 与 `@deepseek-ai/dsh-tools` 的 `postExecute`。度量数字来自官方 `tokenMeter.measure(session)`（与 composer 上那个上下文环是同一个投影），字符数才是本插件自己数的。

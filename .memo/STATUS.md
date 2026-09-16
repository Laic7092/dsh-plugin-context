# STATUS — dsh-plugin-context

> 单一事实来源：接手先读这里，一个阶段结束时用 `memo handoff` 覆写下面四节。写短——这一页是给下一个会话扫的，来龙去脉留在代码、测试和 git log 里。journal 更短：一条一句，只放别人手里没有的那句（数字、结论、哪条路试过不行）。

_最后更新：2026-09-16T18:05:58.428Z_

## 现在在哪

dsh-plugin-context 0.1.1。**host 半已在运行中的 harness 里验过（不是模拟）**：GET /context/config 返回我写的默认值（24000/16000/16000，全 report，identity）；GET /context/state?sessionId=session-5a3f2da2-706e-403f-9b37-ca1a422848f7 返回真实度量——375193 tok / 1000000 窗口（baseline usage）、263 个 surface 节点、140 对 toolCall→toolResult、当前 15 个节点超预算、最大节点 #432 user 25146 tok、策略可选 identity|head-tail。**client 半（面板/压力表）仍是浏览器内未验证**，而且证明不了的原因已查明：/ 对命令行 401，/plugins/??<任意插件>/client.js 对 dsh-plugin-memo、dsh-context 也一律 404（要页面自己的鉴权与 graph rev），所以那条探测是无效的——scripts/verify-live.mjs 已修成只做 host 侧硬校验 + 真实会话读数。其他证据：82 个测试全绿、tsc clean、npm run verify（真实会话日志 634 事件/120 对调用）过。

## 下一步

- 交接后第一件事：浏览器刷新页面，确认视图切换器多出 Context Control、会话头部多出压力表；然后 npm run verify:live（会自动挑最新会话）应输出 host 半 OK + 真实度量。
- 想证明"改写真的落地"（用户选择暂不做）：POST /context/config 设 kinds.tool-result={maxChars:3000,onOver:"rewrite"} + policies.tool-result="head-tail"，跑一次大输出工具调用，看干预日志出现 applied 条目且结果被截短，再切回 report。期间当前会话自己的 toolResult 会被截短。
- 面板配置是进程内的，重启回 composition 默认；持久化要接官方 settings 命名空间（settings.register 吃 @deepseek-ai/schemastery，不吃 zod），可复用 installSection 的 entry-as-base 套路。
- profile 依赖是 file:/home/laix/dsh/dsh-plugin-context/dsh-plugin-context-0.1.1.tgz，不能删；改代码后 npm pack + dsh plugin --profile web add 覆盖。

## 未决问题

- **client 半从未在真实页面里渲染过**：React/插槽/Slot props 只在我 vm 的 stub 与假 ctx 里跑过，第一次刷新可能出现注册或渲染错误，dsh 日志与页面 console 都要看。
- 三个接缝的真实运行时契约仍未在活 harness 里触发过（默认全 report）：tools/post-execute 的 {kind:"accept",content} 是否被接受、llm/stream 包裹流对 finish 语义的影响、PTC tools/ptc-dispatch-log 返回 ContentBlock[] 是否落到持久日志。
- 本插件的面板路由无需页面鉴权即可 GET（命令行 curl /context/config 得 200）——与 memo 的 /memo/state 同姿态，本地 loopback 可接受，但应当知情。
- 手动 surface replace 需要有打开的 turn（turn 不变量只在 dsh-sdk-minimal 挂载，实时 GUI 不拦）；工具自己声明 finalizeContent 时它说了算，会覆盖本插件的改写。

## 不要重犯

- 不要把 toolResult 的改写同时挂在 tools/post-execute 和 tools/ptc-dispatch-log 上：exec.parent !== undefined 的嵌套子调用必须只由 PTC 那条路处理，否则同一份结果改两次。
- 不要把 tokenMeter.measure() 的 nodes 当 Map 用：live 返回的是数组 [{seq,tokens,heuristicTokens}]，曾经因此让面板永远显示"未测量"，现在在 snapshot.ts 的 readMeasurement 里归一化（有回归测试）。
- 会话日志是多个拼接的 zstd frame，单帧解码（zstdDecompressSync 直接喂整个文件）只会得到 header 那一行——看着像成功。scripts/verify-real-session.mjs 按 frame 切开解。
- 不要用 JSON.stringify/结构化克隆去碰 Cordis/会话活对象；只读标量叶子，面板数据一律自己拼最小 JSON。
- 不要动用户的 profile（cordis.patch.yml 里不要重复 insert，重复的 loader entry id 会让 profile 起不来）；配置改动写成不带 insert 的定向 patch。

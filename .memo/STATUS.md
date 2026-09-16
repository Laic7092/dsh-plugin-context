# STATUS — dsh-plugin-context

> 单一事实来源：接手先读这里，一个阶段结束时用 `memo handoff` 覆写下面四节。写短——这一页是给下一个会话扫的，来龙去脉留在代码、测试和 git log 里。journal 更短：一条一句，只放别人手里没有的那句（数字、结论、哪条路试过不行）。

_最后更新：2026-09-16T19:11:12.384Z_

## 现在在哪

0.1.5：面板图例的两个名字都起错了，已改（详见上一条 now：system/message 就是系统提示词；prefix 是 total − surface 的减法残差）。101 个测试全绿、tsc clean、npm run verify OK，已打包 dsh-plugin-context-0.1.5.tgz（61,199 字节）

## 下一步

1) 沙箱外安装 0.1.5：cd /home/laix/.dsh/profiles/web && pnpm add file:/home/laix/dsh/dsh-plugin-context/dsh-plugin-context-0.1.5.tgz 2) 刷新页面看图例，应是：固定请求开销（禁用）/ 工具结果 / 助手输出 / 推理（CoT）/ 用户消息 / 系统提示词 3) 一条 skew 要注意：我在改名前用 npm pack 原地重打过 dsh-plugin-context-0.1.4.tgz，所以磁盘上的 0.1.4.tgz 与 profile 已装的 0.1.4 内容不同，而 profile 的 package.json 仍指向 0.1.4；装完 0.1.5 这条 skew 就消失，在那之前别对 profile 跑 pnpm install --frozen-lockfile

## 未决问题

- **这次的新 UI 从未在真实页面渲染过**：locale 接线与两个座位已在 0.1.2 的截图里验过（整块面板中文），但查询引擎/批量条/两栏布局是新代码，只在 vm stub 与纯函数测试里跑过。
- **批量应用的真实行为未验**：逐条写盘依赖 surface replace 与 turn 不变量，可能部分被拒（面板逐条显示原因），但"一批里有成功也有失败"没有在活 harness 里触发过。
- **预演不写日志是有意的**：seam 驱动的 report 会记日志，而面板的批量预演不记（否则一次预演会灌满 200 条环形缓冲）。这个取舍要在页面上确认不违和。
- 三个接缝的真实运行时契约仍未在活 harness 里触发过（默认全 report）：tools/post-execute 的 {kind:accept,content}、llm/stream 包裹流对 finish 语义的影响、PTC tools/ptc-dispatch-log 返回 ContentBlock[] 是否落到持久日志。
- topN 的语义变成了"面板每页多少行"（host 仍校验 3..50），键名没改；若别的 composition 里钉过这个值，含义会变。
- 面板路由无需页面鉴权即可 GET（与 memo 的 /memo/state 同姿态）。手动 surface replace 需要有打开的 turn；工具自带 finalizeContent 时会覆盖本插件。
- 内建语言只有 zh/en；宿主侧的错误与诊断文本仍是英文原样（那是数据不是文案）。

## 不要重犯

- **不要以为 run_code 的 sandbox 升级能放宽嵌套 bash 工具的沙箱**：bash 有自己的 workspace-write 策略，只把会话工作目录 bind 成可写，/home/laix/.dsh 与 pnpm store（/home/laix/.local/share/pnpm/store）都是 --ro-bind / / 下的只读路径，写进去是 os error 30。所以 dsh plugin add / pnpm add 这类要写 profile 与 store 的命令，**只能请人在沙箱外跑**，别反复重试。
- **日志字段可能有多种形态，读之前先归一化**：arguments 在 tool/call 与旧事件里是 JSON 字符串、在多数 tool/ptc-dispatch 里是 JSON 对象（真实会话 322 对 2）。只读一种形态的后果是整张表静默变 0，而不是报错——只有 verify 抓到了它。任何"这个字段应该是 X 型"的假设都要先在一份真日志上数一遍。
- **构成的前缀不能取 baseline**：框架的仪表定义是 total = max(0, baseline + surfaceDelta)，baseline 是一次整请求的锚点，直接当前缀会把 surface 算两遍（曾让图例加起来 183%、把 29k 的固定开销画成 181k）。前缀必须减出来。
- **不要把 toolResult 的改写同时挂在 tools/post-execute 和 tools/ptc-dispatch-log 上**（exec.parent !== undefined 的嵌套子调用只走 PTC 那条）。
- **不要把 tokenMeter.measure() 的 nodes 当 Map 用**（live 返回数组，已在 snapshot.ts 归一化）。
- **会话日志是多个拼接的 zstd frame**，单帧解码只会得到 header 那一行，看着像成功。
- **不要用 JSON.stringify/结构化克隆去碰 Cordis/会话活对象**；只读标量叶子，面板数据一律自己拼最小 JSON。
- **不要动用户的 profile**（cordis.patch.yml 里不要重复 insert）。
- **改文案或加筛选维度时别只改一处**：英文原句同时存在于 COPY 表和调用点，编辑脚本要限制在 const DICT = { 之后的尾部才动渲染站点；新维度要在 FIELDS + row 构造 + （需要分组时）GROUP_FIELDS 三处一起加。
- **大块改写客户端时用 P() 逐行 push 会精确地放大手误**：漏一个结尾引号、把 ); 写成 ,，得到的是难定位的 parse error（这次花了两轮才发现）。分块写入并立刻 npm run check 才能定位。

# BOSS 直聘自动打招呼——"继续沟通"弹窗问题交接说明

> 交接日期：2026-09-23 之前 · 写给下一个接手的 AI/工程师
> 全部结论来自真机诊断（Ubuntu 26.04 + Chrome 153 + CDP），非猜测处均已标注

---

## 1. 背景与环境

- 项目：`/home/shici/career-ops`（career-ops v1.33.0 私有 fork `scccy/career-ops`，boss-* 模块自 pa1nrui1/career-ops-cn 迁移）
- 平台：**Linux Ubuntu 桌面**（非 macOS）。原 boss-chrome-*.mjs 用 osascript/AppleScript 驱动 Chrome，本机已适配为 CDP 通道
- 浏览器：用户日常 Chrome，启动于独立数据目录 `~/.config/google-chrome-boss` + `--remote-debugging-port=9222`（Chrome 136+ 禁止默认目录开调试端口；用户级 `.desktop` 覆盖让双击图标自带端口）
- 适配层：`boss/boss-cdp.mjs`（boss/ 子目录）——CLI + 库。`--eval '<js>'` 在 BOSS 标签页执行 JS 并打印结果（模拟 AppleScript 语义）；内部用 `Runtime.evaluate(returnByValue, userGesture)` + `Input.dispatchMouseEvent`（真实鼠标事件）
- 发送脚本：`boss/boss-chrome-apply.mjs`。流程：`location.href` 导航到岗位页 → 找"立即沟通/继续沟通"按钮 → 点击 → 等输入框 → 填打招呼文案 → 点"发送"按钮 → **验证自定义文案出现在聊天记录** → 记录
- 发送日志：`data/boss-sent-log.tsv`。状态字典：`sent`（自定义文案验证成功）/ `auto_sent`（BOSS 自动默认语已送达，见下文）/ `closed`（职位已下线）/ `failed` / `skipped`
- 每日配额：按城市（上海20/杭州20/南京20），配置于 `config/profile.yml` 的 `boss.daily_limit_per_city`，`boss/boss-common.mjs` 的 `countSentCompaniesTodayByCity` 按 URL 反查候选池计城市

## 2. 已验证可用的部分（不要动）

1. **CDP 执行 JS**：搜索页卡片提取、页面导航、DOM 查询全部正常（今日提取 100+ 岗位）
2. **首次沟通（立即沟通）全流程**：点按钮 → `.chat-container` 面板打开 → `.chat-input`（contenteditable）出现 → 填文案 → 点"发送" → 聊天记录验证 ✅（今日成功 4 家：上海从鲸、深度求索、认养一头牛、浙江有鹿）
3. **按钮可见性过滤**：岗位页常有两个同名按钮（DOM 前部一个隐藏 0×0 的"立即沟通" + 可见的"继续沟通"），必须 `getBoundingClientRect()` 宽高 > 0 过滤，否则点到隐藏按钮无反应
4. **真实点击机制**：`__CDP_CLICK__` 坐标标记协议——页面 JS 返回 `{ ok, __CDP_CLICK__: {x,y} }`，`boss/boss-cdp.mjs` CLI 解析后用 `Input.dispatchMouseEvent`（mouseMoved→mousePressed→mouseReleased，间隔 60ms）派发**受信任鼠标事件**。部分 BOSS 按钮对合成 `.click()` 无响应，必须走这条

## 3. 弹窗问题详解

### 3.1 现象

对**"继续沟通"类岗位**（即用户与该 HR 已有会话记录，BOSS 按钮文案从"立即沟通"变为"继续沟通"）：

点击按钮的瞬间，BOSS **自动发送默认打招呼语** `"希望和你聊聊这个职位，是否有时间呢？"`（用户在【消息通知-设置打招呼语】里配置的那条），然后弹出确认框，**自定义输入面板不出现**：

```html
<!-- 实测 DOM（有鹿机器人岗位页） -->
<div class="dialog-wrap greet-pop greet-boss-pop">
  <div class="dialog-container">
    <div class="dialog-title">已向BOSS发送消息</div>
    <div class="dialog-con">希望和你聊聊这个职位，是否有时间呢？
      如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</div>
    <div class="dialog-footer">
      <div class="btns">留在此页继续沟通</div>   <!-- 注意：是 DIV，不是 button/a -->
    </div>
  </div>
</div>
```

### 3.2 关键事实

| # | 事实 | 证据 |
|---|---|---|
| 1 | 弹窗出现 = 默认语**已实际送达**对方 | 弹窗文案"已向BOSS发送消息"；这是联系建立，不是错误 |
| 2 | 弹窗按钮是 `DIV.btns`，不是 button/a 标签 | elementFromPoint 确认；按标签找按钮的选择器会漏 |
| 3 | **弹窗新鲜时**（出现后 ~1s 内），CDP 真实点击"留在此页继续沟通"有效 → 面板打开 → 可发自定义文案 | 认养一头牛：弹窗→真实点击→`.chat-input` 出现→自定义文案发送并验证成功 |
| 4 | **弹窗变陈旧后**（页面上停留数分钟），同一按钮对一切点击无响应：合成 `.click()` 触发了（返回正常）、CDP 真实鼠标事件坐标精确落点（elementFromPoint 确认落点就是按钮本身），但既不关弹窗也不开面板 | 有鹿机器人：连续 3 次真实点击 + 3 次合成点击，弹窗纹丝不动（popupVisible=4 恒定，inputVisible=0） |
| 5 | 陈旧根因**未确证**。最可能：BOSS 前端（Vue）重渲染后旧弹窗节点的事件监听已失联，页面上只是一个"尸体"DOM | 推断依据：同一页面同一按钮，新鲜时有效、陈旧时无效 |
| 6 | 弹窗有时 **嵌套在导航流程里反复出现**：真实点击可能触发再次自动发送（弹窗内容不变），无报错 | 诊断时观察到弹窗持续存在 |

### 3.3 已落地的处理（当前代码）

`boss/boss-chrome-apply.mjs` sendOne 内：

1. 点完沟通按钮后立即进入**弹窗轮询循环**（最多 3 次，避免等待 `gapMs` 让弹窗节点变陈旧）：
   - 若可见输入框存在 → 进入正常填文案流程
   - 若页面文本含 `已向BOSS发送消息` → 标记 `autoGreeted`，并用 `__CDP_CLICK__` 真实点击"留在此页继续沟通"（**全标签搜索最内层可见元素**，按面积最小排序，不限标签）→ 等 800ms 再查
2. 循环结束后若 `autoGreeted` 且输入框仍未出现 → 自动导航到消息页 `https://www.zhipin.com/web/geek/chat`，按公司名搜索并打开对应会话。
3. 消息页复用同一套填充、点击“发送”、聊天记录验证逻辑；验证通过才记 `sent`。
4. 消息页定位或发送验证失败时，才记 `auto_sent`，并把“默认语已发送、自定义话术未验证”的具体错误写入日志和追踪表；该结果不会冒充 `sent`，但会继续批次。

这套处理**已解决"卡批"问题**（弹窗岗位不再阻塞后续发送），今日实测 4 家 auto_sent 正常记录。

## 4. 当前处理结果

**核心问题已改为双路径处理：**

1. 弹窗新鲜：点击“留在此页继续沟通”后在岗位页发送自定义文案，并验证聊天记录。
2. 弹窗陈旧或节点失效：切到消息页，按公司名打开会话，再发送并验证自定义文案。
3. 两条路径都无法验证：保留 `auto_sent` 作为“默认语已送达”的事实记录，同时明确标记自定义话术未验证，不再误报为成功。

### 消息页路径说明

`boss/boss-chrome-apply.mjs` 的 `openMessageConversation()` 使用消息页搜索框（`.boss-search-input`）搜索公司，点击匹配的 `li[role="listitem"]`，然后确认可见 `.chat-input`。发送成功仍以自定义文案出现在聊天记录、且输入框已清空为准。

### 复现/测试方法

```bash
# 环境就绪：双击 Chrome 图标（自带 9222）→ 已登录 BOSS
cd /home/shici/career-ops
node boss/boss-cdp.mjs --probe                       # 确认 CDP 在线
# 找一个"继续沟通"岗位页（队列里 auto_sent 过的公司，或直接导航其 job URL）
node boss/boss-cdp.mjs --goto "<job_url>"
# 手动点击可见沟通按钮（合成）→ 观察 .dialog-wrap.greet-pop 出现
# 再测真实点击"留在此页继续沟通"（新鲜 vs 陈旧两种时序）
```

### 关键代码位置

| 位置 | 内容 |
|---|---|
| `boss/boss-chrome-apply.mjs` sendOne | 按钮查找+可见性过滤+`__CDP_CLICK__` 协议；弹窗轮询；消息页会话补发；`AUTO_GREETED`/`JOB_CLOSED` 分流 |
| `boss/boss-chrome-apply.mjs` main catch | `auto_sent`/`closed`/`failed` 三种结果分流（auto_sent 与 closed 不中断批次） |
| `boss/boss-cdp.mjs` evaluateMaybeClick / realClick | `__CDP_CLICK__` 解析与 `Input.dispatchMouseEvent` 派发 |
| `boss/boss-common.mjs` | `loadSentCompanyKeys`（statuses 含 `auto_sent`）、`countSentCompaniesTodayByCity`（配额计数） |

## 5. 硬约束（接手者必须遵守）

- **禁止用 Playwright 浏览器访问 BOSS**（风控）；只用用户真实 Chrome + CDP
- 不破解验证码、不绕过风控、不加隐身/反检测逻辑
- `sent` 状态必须验证自定义文案出现在聊天记录；`auto_sent` 只用于确认弹窗场景
- 打招呼文案不含手机号/微信；绝不编造经历
- 每日按城市配额 20（profile.yml），发送前必须向用户展示清单并获得明确确认

## 6. 本次事故备份提示

今晚项目目录曾被误删后从 GitHub 恢复。当前所有代码已推送（commit `dbb495e` + 后续弹窗补丁未推送——**接手后请先 `git add -A && git commit && git push`**）。`~/career-ops-recovery/` 与 `~/career-ops-wiped-tmp/` 为事故遗留备份目录，确认无误后可删。

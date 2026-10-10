# Career-Ops 中国 BOSS 直聘版

这个版本把 career-ops 改成中文求职主线：导入简历、生成并确认中文求职画像、扫描 BOSS 岗位、评分、生成打招呼文案、批量发送并写入追踪表。

## 首次启动

真实启动时先运行：

```bash
node doctor.mjs --json
```

如果缺 `cv.md`，先引导用户提供简历：

- 粘贴简历文本
- 提供本地简历文件路径
- 通过问答生成一版简历

如果缺 `config/profile.yml`，或者 `profile.confirmed` 不是 `true`，先生成中文求职画像草稿，询问缺失信息，并等待用户确认。未确认前不得扫描、评分或批量发送。

## 核心流程

```text
导入简历
→ 生成 cv.md 和中文求职画像草稿
→ 用户补充缺失信息并确认画像
→ BOSS 搜索岗位
→ AI/规则评分
→ 分数 >= 4.0 进入发送队列
→ 根据每个岗位 JD 和确认版画像生成 BOSS 打招呼文案
→ 批量发送
→ 写入发送日志和申请追踪表
```

## 画像确认

`config/profile.yml` 中必须有：

```yaml
profile:
  confirmed: true
```

未确认前，`boss-score` 和 `boss:chrome:apply` 会停止。简历中没有的信息必须让用户补充，不能由 AI 编造。

首次从简历生成草稿：

```bash
npm run china:profile -- --input cv.md
```

如果 `config/profile.yml` 或 `modes/_profile.md` 已存在，脚本会拒绝覆盖。确认要重建时再加 `--force`。

## BOSS 命令

```bash
npm run boss:chrome:extract -- --company-limit 30 --max-cards 120 --click-gap-ms 2200 --append
npm run boss:import:detail -- --input data/boss-candidates-detailed.json --append
npm run boss:import -- --clipboard
npm run boss:scan -- --query "法务" --limit 50 --dry-run
npm run boss:scan -- --query "法务" --city 深圳 --limit 50 --dry-run
npm run boss:scan -- --query "法务" --company-limit 30 --append
npm run boss:quota -- --input data/boss-candidates.json --target-companies 20 --batch-companies 30
npm run boss:fill -- --input data/boss-candidates.json
npm run boss:fill -- --input data/boss-candidates.json --prepare
npm run boss:review -- --limit 20 --threshold 4.0
npm run boss:score -- --input data/boss-candidates.json --threshold 4.0
npm run boss:chrome:apply -- --threshold 4.0 --daily-limit 20 --dry-run
npm run boss:chrome:apply -- --threshold 4.0 --daily-limit 20 --confirmed-review
```

`boss:login` 和 `boss:scan` 不再长时间轮询登录页。若 BOSS 要求登录或安全验证，脚本会写入 `data/boss-login-required.json`，提示用户用正常 Chrome 登录 BOSS；用户登录完成并告知后，再继续下一步。

`boss:scan` 默认从已确认的 `config/profile.yml` 读取 `target.cities`，并把第一个目标城市转换成 BOSS 搜索城市。只有用户明确指定 `--city` 时才覆盖画像城市。例如当前画像目标城市是深圳，搜索 URL 应使用 BOSS 的深圳城市码 `101280600`；如果用户画像改成北京，则应自动搜索北京。

如果 BOSS 触发安全校验，不要让自动化浏览器停在登录页等待。稳定路径是：用户先用正常 Chrome 登录 BOSS，并手动搜索到目标岗位列表页；用户告知“已登录”后，再运行 `npm run boss:chrome:extract -- --company-limit 30 --max-cards 120 --click-gap-ms 2200 --append` 读取当前 Chrome 页面。

如果页面几秒后自动变成 `about:blank`，说明 BOSS 没有允许当前自动化浏览器继续访问。此时不要继续重试刷新；改用正常 Chrome 手动搜索岗位，再把页面文本或后续支持的导出数据交给工具评分。

当前推荐的稳定路径：

1. 用正常 Chrome 登录 BOSS 并搜索岗位。
2. 搜索目标岗位和目标城市，例如深圳 + 法务。
3. 用户告诉助手“已登录”。
4. 助手运行 `boss:chrome:extract`，慢速点击左侧岗位卡片并读取右侧完整 JD。
5. 继续运行 `boss:score` 和 `boss:chrome:apply --dry-run` 生成评分和逐岗位打招呼文案。

`npm run boss:import -- --clipboard` 只能作为备用的左侧列表文本解析器。它适合快速整理候选池，但不能作为正式评分依据，因为左侧岗位卡片通常没有完整 JD。

详情文本块格式：

```text
公司：公司名
岗位：岗位名
薪资：20-30K
城市：深圳
HR活跃：今日活跃
URL：https://www.zhipin.com/...
是否可立即沟通：是
职位描述：
岗位职责：
...
任职要求：
...
---
```

评分前会检查 `desc` 是否像完整 JD。如果岗位描述过短，或没有识别到岗位职责、职位描述、任职要求等详情结构，该岗位会被标记为“缺少完整JD”，不会进入发送队列。

## 每日 20 家企业配额

每日上限是“20 家企业”，不是 20 个岗位。同一家公司多个岗位只保留评分最高或排序最靠前的一条进入发送候选；最近 30 天已经沟通过的公司会直接排除，避免反复打扰同一家公司。

读取数量按批次控制：

```text
读取 30 家公司的完整 JD
→ 评分并按公司去重
→ 达标公司数 >= 20：停止读取，按评分从高到低取前 20 家
→ 达标公司数 < 20：继续读取下一批 30 家公司
→ 重复直到可打招呼公司满 20 家
```

`boss:quota` 只做规划和 dry-run，不发送消息。它会输出：

- 当前已读取岗位数
- 去重后的企业数
- 评分达标的企业数
- 最近 30 天已沟通过的企业数
- 当前批次目标，例如 30、60、90
- 本轮还需要补读多少家公司
- 是否可以停止读取并进入打招呼 dry-run
- 主要淘汰原因

`boss:fill` 是推荐的日常总控入口：

- 不加 `--prepare`：只判断当前候选池够不够 20 家达标公司，并告诉你还要补读多少家。
- 加 `--prepare`：当达标公司已经够 20 家时，自动刷新 `data/boss-queue.json`，生成 `data/boss-review.md` 确认清单，并输出按评分排序的 `boss:chrome:apply --dry-run` 预览。
- 如果还不够 20 家，`--prepare` 也不会发送或生成发送动作，只会提示继续补读下一批公司。
- 后续补读必须用 `--append`，避免覆盖前面已经读取的候选池。

`boss:review` 是发送前人工确认关口。每次跑完补读和评分后，必须主动向用户展示前 20 家的：

- 公司名称
- 薪资水平
- 岗位名称
- 简要职位要求
- 评分

用户明确确认后，才允许进入真实发送。真实发送命令必须显式带 `--confirmed-review`，否则 `boss:chrome:apply` 会拒绝执行。

真实发送建议使用正常 Chrome 登录态：

```bash
npm run boss:chrome:apply -- --threshold 4.0 --daily-limit 20 --dry-run
npm run boss:chrome:apply -- --threshold 4.0 --daily-limit 20 --confirmed-review
```

发送成功判定必须严格：

- 填入输入框不算发送成功。
- 必须点击聊天页底部文字按钮“发送”，不能点到发送图片、附件或其他工具按钮。
- 点击后必须在聊天记录中验证到本岗位定制打招呼文案，才允许写入 `sent` 和申请追踪表 `Sent`。
- 只出现 BOSS 默认招呼语，或自定义文案仍停留在输入框时，记为 `failed` 或 `unverified`，不得计入当日额度和最近 30 天已沟通公司。

发送完成后必须主动反馈：

- 告知用户本轮已经成功联系多少家公司。
- 告知用户：如果 HR 要求发送简历，或用户自己投递的公司要求发送简历，可以提供公司名称或 BOSS 岗位链接。
- 收到公司名称或 BOSS 链接后，根据岗位 JD 和用户 `cv.md` 定制中文简历，输出 `cv.md` 和 PDF。
- 收到 BOSS 岗位链接后，先用 `npm run boss:import:url -- "<url>" --append` 读取详情页完整 JD；读取成功后再用该 JD 匹配 `cv.md`，不得只凭岗位标题或公司名称定制简历。
- 如果 URL 读取失败或 `jd_detail.ok=false`，先让用户登录 BOSS 后重试；仍失败时，让用户复制岗位详情页完整文本，并用 `npm run boss:import:detail -- --clipboard --append` 导入。
- 简历定制只能优化表达、调整顺序、突出真实匹配经历；不得编造经历、技能、证书、薪资、学历或时间。
- 简历定制要自然，不新增“与某公司岗位的匹配重点”“对应 JD 要求”等报告式章节；应把岗位关注点融入个人摘要、核心能力和最相关工作经历中。
- 简历生成按固定管道执行：读取 `cv.md` 和 JD，提取 15-20 个 JD 关键词，映射到真实经历证据，重写个人摘要，选择并重排最相关经历 bullet，构建 6-8 个能力关键词，把 JD 关键词自然注入到真实业务场景、动作和结果中，再生成 HTML 并用 Playwright 转 PDF。
- 交付定制简历时，必须同时给用户一段可直接发给 HR 的 BOSS 配套话术。
- 交付后要提醒用户：发完简历后如 HR 追问自我介绍、到岗时间、薪资、通勤、岗位理解等问题，可以把原话发来继续生成回复。
- 如果进入面试，提示用户可以提供公司名称或 BOSS 链接，继续查询公司基本情况并生成面试准备。

## 公司研究和面试准备

公司研究只在高价值场景触发：岗位评分 `>= 4.5`、用户明确要求、进入面试准备、或岗位/公司存在明显风险。

研究路径：

1. 查公司官网：主营业务、产品、岗位所在业务线、招聘页。
2. 查天眼查 MCP：登记信息、经营状态、股东/董监高、经营风险、司法风险、历史变更、知识产权等公开工商信息。
3. 如果 `tyc-mcp` 返回 `Auth required`、当前会话没有热加载 Authorization、MCP 工具不可用或连续失败，不要反复重试，立即用 `tyc-cli` fallback：

   ```bash
   tyc company companies "公司名" --md
   tyc company registration-info "企业全称或统一社会信用代码" --md
   tyc company listing-info "企业全称或统一社会信用代码" --md
   tyc company financial-summary "企业全称或统一社会信用代码" --md
   tyc risk overview "企业全称或统一社会信用代码" --md
   tyc operation credit-evaluation "企业全称或统一社会信用代码" --md
   tyc history historical-overview "企业全称或统一社会信用代码" --md
   ```

4. 如有风险信号，再查诉讼、裁判文书、立案、行政处罚：

   ```bash
   tyc risk judicial-case "企业全称或统一社会信用代码" --md
   tyc risk judicial-documents "企业全称或统一社会信用代码" --md
   tyc risk case-filing-info "企业全称或统一社会信用代码" --md
   tyc risk administrative-penalty "企业全称或统一社会信用代码" --md
   tyc risk business-exception "企业全称或统一社会信用代码" --md
   tyc risk dishonest-info "企业全称或统一社会信用代码" --md
   tyc risk judgment-debtor-info "企业全称或统一社会信用代码" --md
   tyc risk high-consumption-restriction "企业全称或统一社会信用代码" --md
   tyc risk terminated-cases "企业全称或统一社会信用代码" --md
   ```

   上市公司或风险总览提示存在担保、股权质押、违规处理时，再补充：

   ```bash
   tyc risk guarantee-info "企业全称或统一社会信用代码" --md
   tyc risk stock-pledge-info "企业全称或统一社会信用代码" --md
   tyc company stock-violations "企业全称或统一社会信用代码" --md
   ```

5. 能访问时查企查查等公开工商信息做交叉验证。
6. 联网查近一年新闻、融资、裁员、诉讼、负面舆情。

研究输出不能只写“存在若干风险”。必须写具体信息或明确结论：

- 工商登记：企业全称、统一社会信用代码、状态、法定代表人、注册资本、行业、人员规模、官网。
- 诉讼/司法：案件类型、案由、案号或标题、时间、身份、结果；如只查到数量没有明细，要写明“仅查到数量，未取得明细”。
- 行政处罚/经营异常/被执行/失信：列出事项、时间、机关或结论；未发现则写“未发现公开记录”。
- 裁员/负面舆情：列出具体公开来源、时间、事件、可信度；没有可靠来源时写“未发现可靠公开裁员信息”，不能推断。
- 最后给求职结论：`红灯 / 黄灯 / 绿灯`，说明是否影响面试投入。

授权规则：

- 用户提供天眼查 Authorization 时，只写入用户本机 MCP/CLI 配置，不写入仓库。
- 其他用户没有提供 Authorization 时，引导其到 `https://ai.tianyancha.com/guide` 获取 API Key，并把 `tyc-mcp` 配进自己的 MCP 客户端。
- 如果用户不提供 Authorization，明确告知不会查询天眼查工商、司法、风险数据；继续使用公司官网、公开新闻和 BOSS JD 完成研究。

输出结构：

- 公司基本情况
- 工商与经营信息明细和结论
- 司法、诉讼、行政处罚、经营异常、裁员、负面舆情的具体信号表
- 岗位价值判断
- 主要风险点
- 是否建议继续
- 面试前问题清单

## 数据文件

- `data/boss-candidates.json`：扫描到的候选岗位。
- `data/boss-queue.json`：评分达标的待发送队列。
- `data/boss-review.md`：发送前给用户确认的前 20 家企业清单。
- `data/boss-sent-log.tsv`：发送成功和失败日志，用于去重。
- `data/applications.md`：申请追踪表。
- `reports/`：岗位评估报告。

## 默认规则

- 第一版只支持 BOSS 直聘。
- 默认阈值：`4.0/5`。
- 默认每日发送上限：`20`。
- 跳过外包、派遣、猎头、驻场、HR 长期不活跃、无“立即沟通”的岗位。
- 真实发送前必须展示 `data/boss-review.md` 并获得用户确认。
- 不做验证码破解、风控绕过或平台规避。
- 打招呼文案不默认包含手机号、微信等联系方式。
- 打招呼文案逐岗位生成，依据包括 JD 关注点、画像匹配技能和画像匹配经历；`--dry-run` 会逐条展示。

## 机会可信度筛选

原版 career-ops 的公司/岗位质量判断，本项目改成 BOSS 场景下的“机会可信度”。它不是联网背调每家公司，而是在批量评分阶段先判断这个岗位是否像一个真实、具体、可沟通的机会。

`boss/boss-score.mjs` 会输出 `opportunity_legitimacy`：

- `High Confidence / 高可信`：JD 完整、职责和要求清楚、岗位关键词具体、薪资透明、HR 近期活跃、有可沟通入口。
- `Proceed with Caution / 谨慎推进`：岗位可看，但存在信息不完整、JD 偏泛、薪资不明确、HR 活跃度一般等问题。
- `Suspicious / 可疑机会`：缺完整 JD、无沟通入口、主体不清晰、模板化严重、疑似长期挂岗或营销化招聘表达；不进入自动发送队列。
- 薪资不明确或“面议”的岗位只记录，不自动发送。

深度公司研究仍只在高价值场景触发：岗位评分 `>= 4.5`、用户明确要求、进入面试准备、或岗位/公司存在明显风险。

## 岗位评分权重

| 维度 | 权重 |
|---|---:|
| 岗位职责匹配 | 25% |
| 核心技能匹配 | 25% |
| 薪资匹配 | 15% |
| 城市/通勤/办公方式 | 10% |
| 公司与岗位质量/机会可信度 | 10% |
| HR 活跃与岗位新鲜度 | 10% |
| 风险扣分 | 最高 -20% |

分数解释：

- `4.5+`：强烈推荐，优先发送。
- `4.0-4.4`：推荐，进入批量发送。
- `3.5-3.9`：一般，只记录不自动发送。
- `<3.5`：不建议投递。

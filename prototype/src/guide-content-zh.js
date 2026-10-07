'use strict';
// guide-content-zh.js — Sales AI Console「使用指南」简体中文版。
//
// src/guide-content.js 的完整翻译：5 个分类 / 20 篇文章 / 84 个步骤。
// 结构对齐契约（由 test/guide-content-i18n-en.js 校验）：
//   category id、article id、minutes、步骤数、tip 位置、seeAlso 数组与原文完全一致，
//   仅翻译 title/summary/steps title/steps body/tip。
// 专有名词保持原样：SKU、GHN、Suri、Sales AI Console；sku_base、SECRET_IN_PROMPT、
// NEEDS_HUMAN、bot_off、auto_reply_comment、{{TenKhachHang}} 等为引擎字面 token，不做本地化。
//
//   categories[] : { id, title, articles[] }
//   articles[]   : { id, title, minutes, summary, steps[], seeAlso[] }
//   steps[]      : { title, body, tip? }

const categories = [
  // ============================================================ 1. 快速上手
  {
    id: 'bat-dau-nhanh',
    title: '快速上手',
    articles: [
      {
        id: 'dang-nhap',
        title: '登录控制台',
        minutes: 2,
        summary: '使用店铺分配给您的登录 ID 和密码进入 Sales AI Console。OWNER/ADMIN 可配置全部内容，AGENT 只能查看数据并进行销售。',
        steps: [
          {
            title: '第 1 步 — 打开登录页',
            body: '访问店铺的控制台地址。欢迎页提供"登录 ID + 密码"输入框。输入 ID（登录名形式，如 thao2019，无需邮箱）和密码，然后点击"登录"。',
            tip: '1 分钟内输错超过 5 次系统会临时拦截——等 1 分钟再试即可。',
          },
          {
            title: '第 2 步 — 首次登录',
            body: '如果店铺配置尚未完成，控制台会直接打开"店铺设置"向导（7 步上线清单）。按顺序完成第 1 步到第 7 步，然后点击"开启自动 BOT"，店铺即可上线。',
            tip: '创建的第一个账号就是 OWNER——拥有店铺全部权限。登录后请立即在"设置 → 账号与系统"中修改密码。',
          },
          {
            title: '第 3 步 — 忘记密码',
            body: '点击"忘记密码？→ 重置密码"，输入注册邮箱并点击"生成重置码"。把重置码粘贴到"重置码"输入框，设置新密码（至少 8 位），然后点击"重置密码"。',
          },
          {
            title: '第 4 步 — 认清自己的角色',
            body: 'OWNER 拥有全部权限，ADMIN 负责店铺管理，AGENT（销售人员）只能查看数据并在"会话 + 订单"中工作——不能修改"设置"或"商品"，也看不到上线向导。',
          },
        ],
        seeAlso: ['bat-bot', 'thanh-vien-phan-quy'],
      },
      {
        id: 'ho-so-shop',
        title: '填写店铺资料',
        minutes: 2,
        summary: '向导第 1 步——店铺信息：名称、热线、地址。这是 AI 介绍店铺并打印到订单确认账单上的原始数据。',
        steps: [
          {
            title: '第 1 步 — 打开"店铺设置"向导',
            body: '首次登录后（或在"设置"中点击"完善配置"），您会看到 7 张步骤卡片。第 1 张是"店铺信息"。',
          },
          {
            title: '第 2 步 — 填全 3 个字段',
            body: '店铺名称（例：香氛蜡烛店）、热线（例：090xxxxxxx）、地址（例：胡志明市第一郡 123 ABC）。3 个字段全部必填——漏掉任何一个，卡片仍显示"未完成"。',
          },
          {
            title: '第 3 步 — 保存第 1 步',
            body: '点击"保存第 1 步"。卡片变为绿色"已完成"，向导计数随之增加（例如 1/7）。',
            tip: '店铺名称和热线会出现在 bot 的推荐话术和账单上——请按您希望顾客看到的品牌形象准确填写。',
          },
          {
            title: '第 4 步 — 为 AI 补充店铺资料',
            body: '想让 AI 更深入地了解店铺？进入"设置 → AI 店铺资料"，补充行业、退货政策、配送政策、营业时间等。这里填写的字段优先级高于旧 Prompt 框架——填了即覆盖。',
          },
        ],
        seeAlso: ['viet-ngu-canh', 'ket-noi-fanpage-zalo'],
      },
      {
        id: 'ket-noi-fanpage-zalo',
        title: '连接粉丝页与 Zalo',
        minutes: 3,
        summary: '向导第 2 步（Facebook Messenger）和第 3 步（Zalo OA）。上线清单要求两个渠道至少一个变绿，bot 才有顾客可聊。本实验版运行模拟适配器——Phase 2 再接入真实 API。',
        steps: [
          {
            title: '第 1 步 — 准备 Token',
            body: 'Facebook：在 Meta for Developers 获取 Page ID 和 Page Access Token（需 pages_messaging 权限）。Zalo：在 Zalo OA 管理后台获取 OA ID 和 Access Token。Token 属于机密——只粘贴一次，系统以掩码存储，绝不再次显示。',
          },
          {
            title: '第 2 步 — 保存第 2 步（Facebook）',
            body: '在第 2 张卡片 Facebook Messenger 中，填写 Page ID + Page Access Token，然后点击"保存第 2 步"。',
          },
          {
            title: '第 3 步 — 保存第 3 步（Zalo）',
            body: '在第 3 张卡片 Zalo OA 中，填写 OA ID + Access Token，然后点击"保存第 3 步"。',
            tip: '上线只需要至少一个渠道（第 2 步或第 3 步）。两个都接上，Messenger 和 Zalo 的顾客就由同一个 bot 服务。',
          },
          {
            title: '第 4 步 — 实验版说明',
            body: '当前渠道以模拟（mock）模式运行，您无需真实主页也能走完全流程。接入生产环境（Phase 2）时，已保存的 ID/Token 原样保留——系统只切换为调用真实 API。',
          },
        ],
        seeAlso: ['bat-bot'],
      },
      {
        id: 'them-san-pham',
        title: '添加商品',
        minutes: 4,
        summary: '商品是价格/库存的唯一可信来源。可手动添加或导入 CSV，按顾客的叫法设置别名，缺货时立即停售。',
        steps: [
          {
            title: '第 1 步 — 打开"商品"页',
            body: '侧边栏 → 商品 →"+ 添加商品"按钮。',
          },
          {
            title: '第 2 步 — 填写基础信息',
            body: '商品名称、基础 SKU（sku_base——唯一，例：NEN-S-CANDLE）、价格（VND，须为大于 0 的数字）、库存。可再填尺寸和颜色以生成变体。',
            tip: 'sku_base 是关键：提取订单、导入 CSV 和报表都以它为准——命名要短、好记，之后不要改动。',
          },
          {
            title: '第 3 步 — 添加别名',
            body: '在"别名（顾客的叫法，逗号分隔）"栏填写顾客常用的说法，例：香薰蜡烛、nen thom。当顾客的说法与正式名称不一致时，bot 靠别名匹配。',
          },
          {
            title: '第 4 步 — 用 CSV 批量导入',
            body: '商品 → 导入 CSV，粘贴首行为表头的表格：name,sku,price,stock,size,color,weight。出错行会单独提示并标注行号，不会阻塞有效行。',
          },
          {
            title: '第 5 步 — 需要时停售',
            body: '缺货或停产：拨动商品行右侧开关（在售 → 已暂停）——bot 立即停止推荐该商品。"删除"按钮是软删除：商品退出推荐，但旧订单仍可读取。',
          },
        ],
        seeAlso: ['ai-tu-dong-tao-don', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'cau-hinh-van-chuyen',
        title: '配置 GHN 物流',
        minutes: 2,
        summary: '向导第 5 步——GHN（物流）：shop id + token。开启 Auto-order 后必须变绿，因为订单确认后系统会把运单直接推送到 GHN。',
        steps: [
          {
            title: '第 1 步 — 准备 GHN Shop ID 和 Token',
            body: '登录 GHN 合作伙伴后台，获取 Shop ID（一串数字，例：1234567）和店铺 Token。',
          },
          {
            title: '第 2 步 — 保存第 5 步',
            body: '第 5 张卡片 GHN（物流）：填写 GHN Shop ID + GHN Token，然后点击"保存第 5 步"。',
            tip: 'Token 只写入一次，不再显示——弄丢了就在 GHN 重新生成并覆盖保存。',
          },
          {
            title: '第 3 步 — 理解与 Auto-order 的关系',
            body: '在"设置 → Bot AI"开启 Auto-order 后，上线清单强制要求第 5 步变绿。缺失时会逐字给出原因："第 5 步：auto-order 已开启，需要 GHN token + shop id（或关闭 auto-order）"。',
          },
          {
            title: '第 4 步 — 运单如何流转',
            body: '点击"确认订单"后，系统创建 GHN 运单、把运单号写入订单详情，并接收 GHN webhook 更新状态：配送中 → 已送达。',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'dang-ky-ai',
        title: '注册并接入 AI Key',
        minutes: 3,
        summary: '选择服务商（DeepSeek、OpenAI、Gemini、Grok、Kimi 或 Local），粘贴 API Key 并点击"测试 AI 调用"。上线清单只有在 AI 测试返回 PASS ONLINE 时才变绿。',
        steps: [
          {
            title: '第 1 步 — 选择服务商',
            body: '向导第 6 张卡片 AI Provider：选择 DeepSeek / OpenAI / Local（stub——不发起网络请求）。需要 Gemini、Grok 或 Kimi：进入"设置 → AI 引擎 → 修改配置"，服务商列表由系统动态读取。',
            tip: '每个服务商有各自的默认模型（deepseek-chat、gpt-4o-mini、gemini-2.0-flash、grok-3-mini、kimi-k2…）。"模型"留空即用默认值，填写则覆盖。',
          },
          {
            title: '第 2 步 — 粘贴 API Key',
            body: '在"API Key"栏粘贴形如 sk-… 的 Key。Key 以掩码存储——绝不返回浏览器。然后点击"保存 AI 配置"。',
          },
          {
            title: '第 3 步 — 测试 AI 调用',
            body: '点击"测试 AI 调用"。结果显示绿色 PASS（附服务商名）即 AI ONLINE。若为 ERROR，错误信息就地显示，"设置 → AI 引擎"的 last_error 列会记录具体原因。',
            tip: 'Key 错误、额度用尽或网络被拦截都会在这里暴露——修完再测，只需几秒。',
          },
          {
            title: '第 4 步 — 锁定上线条件',
            body: '上线清单要求第 6 步变绿（AI ONLINE）。暂时没有真实 Key 可先选 Local 试跑，但要正式上线卖货，必须接入一个在线服务商。',
          },
        ],
        seeAlso: ['bat-bot', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'bat-bot',
        title: '开启 bot 正式上线',
        minutes: 2,
        summary: '7 步清单全部完成后，Go-live 卡片解锁"开启自动 BOT"按钮。未完成时系统会逐条列出原因，供您逐项处理。',
        steps: [
          {
            title: '第 1 步 — 跑完最后两项测试',
            body: '第 7 张卡片"会话 + 订单测试"：点击"运行会话测试"（bot 能回答顾客）和"运行订单测试"（能创建 CONFIRMED 订单）。这两个绿灯是开启 bot 的前提。',
          },
          {
            title: '第 2 步 — 阅读 Go-live 卡片',
            body: '还缺什么，Go-live 卡片写得明明白白：店铺名称 + 热线 + 地址未填全、没有在售商品、AI 未 ONLINE、未接入任何渠道（需要 Facebook 或 Zalo）、auto-order 已开但缺 GHN。按提示逐项处理即可。',
          },
          {
            title: '第 3 步 — 点击"开启自动 BOT"',
            body: '清单达标后按钮点亮——点一下，bot 即在已接入渠道上自动回复顾客。控制台提示"BOT 已开启——店铺已上线！"并跳回总览页。',
          },
          {
            title: '第 4 步 — 之后仍在掌控之中',
            body: '想暂停？进入"设置 → Bot AI"，关掉"Bot 自动回复"——所有自动发送立即被拦截（bot_off）。改价或盘点库存时可以放心操作。',
          },
        ],
        seeAlso: ['dang-ky-ai', 'human-takeover'],
      },
    ],
  },

  // ============================================================ 2. 构建 AI
  {
    id: 'xay-dung-ai',
    title: '构建 AI',
    articles: [
      {
        id: 'viet-ngu-canh',
        title: '为 AI 撰写上下文',
        minutes: 4,
        summary: '通过 9 组信息教会 AI 说出店铺的语气：话术风格、称呼、退货政策、营业时间、FAQ、禁语、销售优先级、语言、成交规则。往上下文里粘贴机密信息会被系统当场拦截。',
        steps: [
          {
            title: '第 1 步 — 按表单填写 Prompt',
            body: '设置 → 表单式 Prompt：话术风格（亲切友好）、称呼方式（如何称呼顾客）、销售优先级（礼品组合、M 号蜡烛）、语言（带声调的越南语）、退货政策（7 天内可退换）、营业时间（每天 8:00–21:00）、成交规则（问全姓名/电话/地址后再确认）、禁语（每行一条：不承诺商品数据库以外的价格、不承诺具体送达时间）。完成后点击"保存 Prompt"。',
          },
          {
            title: '第 2 步 — 补充 AI 店铺资料',
            body: '设置 → AI 店铺资料：名称、行业、热线、Logo、配送政策、导购规则、成交规则、FAQ（每行：问题 | 答案）、禁说信息。系统构建上下文时，这里填写的字段会覆盖旧 Prompt 框架。',
            tip: '想为某次活动调整导购方向，只需修改"销售优先级"——不必重写整个上下文。',
          },
          {
            title: '第 3 步 — 用"查看 Prompt"检查',
            body: '点击"查看 Prompt"，读取系统发给模型的最终上下文。这是最真实的一版——调到满意为止。',
          },
          {
            title: '第 4 步 — 绝不粘贴机密',
            body: '不要把 API Key、Token（sk-…、token、api-key…）粘贴到任何上下文输入框——系统会扫描并返回 SECRET_IN_PROMPT 错误。机密只能填在 AI 引擎的 API Key 专用输入框。',
          },
          {
            title: '第 5 步 — 数据别写进 Prompt',
            body: '价格、库存、SKU、促销……不要硬编码在 Prompt 里——bot 一律读取 ProductDB 生成的 FACTS。上下文只负责教语气和导购边界。',
          },
        ],
        seeAlso: ['ly-do-ai-khong-bia-gia', 'ho-so-shop'],
      },
      {
        id: 'ly-do-ai-khong-bia-gia',
        title: '为什么 AI 不会编造价格',
        minutes: 3,
        summary: 'bot 报出的每一个价格/库存数字都 100% 来自 ProductDB 的 FACTS。发送前 Action Gate 逐条审查；AI 拿不准就转人工，绝不瞎猜。',
        steps: [
          {
            title: '第 1 步 — 理解 FACTS',
            body: '每次回复前，系统用 ProductDB 和订单构建 FACTS：价格、库存、SKU、运费、订单状态。AI 只允许引用 FACTS 中的数字——这条规则直接写在系统上下文里。',
          },
          {
            title: '第 2 步 — Action Gate 发送前把关',
            body: 'AI 拟发送的消息必须通过 Action Gate：草稿价格/库存与数据库比对。数字错误、编造 SKU 或承诺错误政策都会被拦截——顾客绝不会收到不准确的回复。',
            tip: 'bot 有一条消息没发出去？看订单详情里的 Audit——Gate 记录了批准/拦截了什么、在哪个阶段。',
          },
          {
            title: '第 3 步 — 数据不够就转人工',
            body: '顾客问 FACTS 里没有的内容（已停售商品、店铺政策之外的事）：bot 请顾客留下电话或标记 NEEDS_HUMAN——会话转为"需人工"状态并进入通知铃铛，交给员工。',
          },
          {
            title: '第 4 步 — 用真实数字守住信任',
            body: '店铺中途改价，系统会按新价格重新报价并请顾客再次确认——绝不按旧价成交之后再道歉。',
          },
        ],
        seeAlso: ['viet-ngu-canh', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'tach-tin-quick-reply',
        title: '拆分消息与快捷回复',
        minutes: 4,
        summary: '一条回复可以拆成多条消息发送，并附带顾客可点的按钮：--- 拆分消息，[[标签]] 快捷回复，[[[标签|payload]]] postback，{{TenKhachHang}} 准确称呼顾客。',
        steps: [
          {
            title: '第 1 步 — 用 --- 拆分多个内容',
            body: '只含 3 个或以上连字符的独立行是分隔符：每段成为一条消息，按顺序依次发送。夹在句子中间的 --- 不会拆分——只有单独占一行时才生效。',
            tip: '用来把账单单独拆成一条、问候语单独一条——顾客读起来不会被大段文字淹没。',
          },
          {
            title: '第 2 步 — 添加快捷回复 [[标签]]',
            body: '在消息中写 [[查看价目表]]，系统渲染成按钮；payload 默认就是标签本身。想让 payload 不同于标签：[[价目表|xem_bang_gia]]。',
          },
          {
            title: '第 3 步 — 使用 postback [[[标签|payload]]]',
            body: '三层括号 [[[标签|payload]]] 生成 postback 按钮——标签展示给顾客，payload 发回服务器。解析器先识别 3 层括号再识别 2 层，token 不会被"吃掉"。',
          },
          {
            title: '第 4 步 — 用 {{TenKhachHang}} 称呼顾客',
            body: '把 {{TenKhachHang}} 变量写进文案，系统替换成顾客姓名；不知道姓名时自动用"您"。该变量在 Facebook 评论回复中同样生效。',
          },
          {
            title: '第 5 步 — 旧回复不怕破坏',
            body: '不含任何标记的消息逐字节原样通过——店铺旧文案模板无需修改，行为与之前完全一致。',
          },
        ],
        seeAlso: ['ai-tu-dong-tao-don', 'viet-ngu-canh'],
      },
      {
        id: 'ai-tu-dong-tao-don',
        title: 'AI 自动创建订单',
        minutes: 4,
        summary: '顾客询问商品 → 选择变体 → 留下电话 → 姓名 & 地址 → bot 发送确认账单。订单以"草稿（待确认）"状态进入订单页，库存保留 24 小时。',
        steps: [
          {
            title: '第 1 步 — 顾客询问，bot 按变体推荐',
            body: 'bot 结合别名 + FACTS，推荐正确的商品和有货的尺寸/颜色。顾客选定后，bot 自动开启下单信息收集流程。',
          },
          {
            title: '第 2 步 — 先要电话号码',
            body: '缺电话号码时，bot 主动询问："麻烦提供一下电话号码，方便确认订单哦"。电话号码是匹配老顾客的钥匙——复购无需从头再问。',
          },
          {
            title: '第 3 步 — 收集姓名 + 地址后发送账单',
            body: '数据齐全后，系统用已校验的数据渲染账单（AI 不自行生成账单）：商品、数量、小计、运费、合计。顾客点头，订单转为"已确认"。',
            tip: '账单始终按成交时刻的数据库渲染——上午改的价格，下午 bot 报的就是新价。',
          },
          {
            title: '第 4 步 — 24 小时保留',
            body: '草稿订单最多保留库存 24 小时（保留截止时间直接显示在订单详情里）。超时未确认，系统自动释放库存并关闭草稿。',
          },
          {
            title: '第 5 步 — Auto-order 推送 GHN',
            body: '开启 Auto-order（设置 → Bot AI）后，草稿订单一出现，系统就准备推送 GHN 运单——因此向导第 5 步必须有 GHN token + shop id。',
          },
        ],
        seeAlso: ['doc-trang-don-hang', 'them-san-pham'],
      },
    ],
  },

  // ============================================================ 3. 订单与物流
  {
    id: 'don-hang-van-chuyen',
    title: '订单与物流',
    articles: [
      {
        id: 'doc-trang-don-hang',
        title: '看懂订单页',
        minutes: 3,
        summary: '六个状态一条生命周期：草稿（待确认）→ 已确认 → 配送中 → 已送达；取消分两条支线——已取消和待取消（物流）。点击订单行即可查看完整详情。',
        steps: [
          {
            title: '第 1 步 — 认识 6 个状态',
            body: '草稿（待确认）——顾客还没点头；已确认——CONFIRMED；配送中——在路上；已送达——完成；已取消——由店铺/顾客侧关闭；待取消（物流）——已发出取消请求，等待物流方确认。',
          },
          {
            title: '第 2 步 — 用筛选标签过滤',
            body: '表格上方的标签行可以快速筛出当前要处理的订单组——集中处理尚未确认的草稿和尚未了结的待取消（物流）订单。',
          },
          {
            title: '第 3 步 — 打开订单详情',
            body: '点击订单行：详情块显示客户（姓名、电话、渠道、地址）、商品（数量、单价、小计）、小计/运费/合计，以及物流区（运单号、状态、创建时间）。',
          },
          {
            title: '第 4 步 — 追溯源会话',
            body: '点击"打开会话"，直达生成该订单的聊天记录——顾客重提需求时直接定位，不用手工翻找。',
            tip: '状态历史块记录每一次状态跳转（谁、何时、为什么）；最近的 Audit 记录 Action Gate 批准/拦截了什么。',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'xac-nhan-va-day-dvvc',
        title: '确认订单并推送物流',
        minutes: 3,
        summary: '点击"确认订单"，系统先用最新库存/价格重新校验，再提交（B 阶段）并创建 GHN 运单。运单缺失时用"重试发货"，不会重复创建。',
        steps: [
          {
            title: '第 1 步 — 关闭草稿订单',
            body: '打开草稿订单 → 确认订单 → 确认。系统在提交前复查库存和最新价格——中午刚改的价也能赶上。',
          },
          {
            title: '第 2 步 — 接收 GHN 运单',
            body: '确认成功后订单转为"已确认"，系统推送 GHN 创建运单；运单号直接显示在物流区，toast 提示"已确认…——运单…"。',
          },
          {
            title: '第 3 步 — 处理已确认但无运单的订单',
            body: '订单已确认但还没有运单（GHN 抖动…）：点击"重试发货"——引擎按原样重跑发货流程，自带防重复机制。',
          },
          {
            title: '第 4 步 — 跟踪到签收',
            body: 'GHN webhook 更新状态：配送中 → 已送达。报表从已确认 + 已送达订单计算营收，不必等妥投才能看到数字。',
          },
        ],
        seeAlso: ['cau-hinh-van-chuyen', 'huy-don-2-chieu'],
      },
      {
        id: 'huy-don-2-chieu',
        title: '双向取消订单',
        minutes: 3,
        summary: '取消草稿是内部事务——库存立即回补。已确认且已有运单的订单必须通过物流方取消，此时订单进入"待取消（物流）"等待确认。',
        steps: [
          {
            title: '第 1 步 — 取消草稿订单',
            body: '打开草稿订单 → 取消订单 → 确认。库存立即回补，bot 恢复正常推荐该商品。',
          },
          {
            title: '第 2 步 — 取消已确认订单（含运单）',
            body: '已确认且有运单的订单：点击"取消订单"会通过 GHN 发起取消。订单转为"待取消（物流）"并附带原因——必须等物流方点头才算完成，谁也不能自行标记"已取消"。',
          },
          {
            title: '第 3 步 — 物流方卡住时重试',
            body: '订单停在"待取消（物流）"：点击"重试物流取消"，按原样重跑引擎流程——不直接改数据库，数据始终安全。',
          },
          {
            title: '第 4 步 — 在订单详情里看结果',
            body: '取消完成后，物流区写明：谁取消、原因、时间；订单显示"已取消"并带红色一行"已取消 · 由…"。物流方 webhook 仍会跟踪运单直到真正关闭。',
            tip: '顾客取消后又改主意了？直接在原会话里新建订单——聊天历史原样保留。',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'doc-trang-don-hang'],
      },
    ],
  },

  // ============================================================ 4. 评论与自动化
  {
    id: 'binh-luan-automation',
    title: '评论与自动化',
    articles: [
      {
        id: '3-cong-tac-comment',
        title: 'Facebook 评论的三个开关',
        minutes: 3,
        summary: '设置 → Facebook 评论——自动：自动回复评论、隐藏负面评论、评论买家转私信。拨动即生效，无需重启。',
        steps: [
          {
            title: '第 1 步 — 自动回复评论',
            body: '开启"自动回复评论"（auto_reply_comment）：帖子下的提问和购买意向由 bot 公开回复，文案使用 {{TenKhachHang}} 变量准确称呼评论者。',
          },
          {
            title: '第 2 步 — 隐藏负面评论',
            body: '开启"隐藏负面评论"（hide_negative_comment）：含有"骗局、骗子、假货、差、烂"等字眼的评论会被隐藏，并自动为员工创建待办——您不必 24 小时盯帖。',
            tip: '负面关键词列表是开放配置——按您的行业口吻添加新词，立即生效。',
          },
          {
            title: '第 3 步 — 把买家转进私信',
            body: '开启"评论买家转私信"（auto_inbox_from_comment）：问"多少钱""还有货吗""我要买"……都是购买意向——系统把他们转入销售私信，转为私密成交。',
          },
          {
            title: '第 4 步 — 价格仍来自数据库，而不是评论区',
            body: '公开回复只是礼貌性语句；价格/库存仍走与私信相同的 FACTS 流程——评论区再吵闹，bot 也不会报错数字。',
          },
        ],
        seeAlso: ['human-takeover', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'follow-up-sau-ban',
        title: '售后跟进',
        minutes: 3,
        summary: '设置 → 自动化——发货后跟进：按小时安排发货后关怀、评价邀请，按天数安排复购提醒。已拒绝广告的顾客永远不会收到营销消息。',
        steps: [
          {
            title: '第 1 步 — 在自动化卡片设置时间',
            body: '设置 → 自动化——发货后跟进：填写"发货后跟进（小时）"（最多 720）和"复购提醒（天）"（最多 365）。',
          },
          {
            title: '第 2 步 — 逐类开启消息',
            body: '发货关怀：订单"已送达"后的问候消息。评价邀请：发货后请求评价。复购提醒：唤起回购——属于 MARKETING 类。完成后点击"保存自动化"。',
            tip: '配置只是设置"时间表"——每条消息仍要通过核心的 24 小时窗口/配额/退订三道闸，没有任何办法骚扰顾客。',
          },
          {
            title: '第 3 步 — 尊重退订顾客',
            body: '拒绝广告的顾客会被标记"已拒绝广告"（在客户页直接可见）：对他们永久停止复购提醒，只有账单、运单这类交易消息照发。',
          },
          {
            title: '第 4 步 — 监控自动化健康度',
            body: '自动化卡片统计计划任务数、退订顾客数，并按类型细分跟进；发送失败时系统按上限重试，之后记录 NEEDS_HUMAN——绝不盲目重发。',
          },
        ],
        seeAlso: ['doc-trang-don-hang', '3-cong-tac-comment'],
      },
      {
        id: 'human-takeover',
        title: '人工接管会话',
        minutes: 3,
        summary: 'AI 拿不准就交还给人：会话变为"需人工"，进入通知铃铛。点击"人工接管"由员工对话，处理完点击"交还给 AI"。',
        steps: [
          {
            title: '第 1 步 — 接收提醒',
            body: '通知铃铛带"需人工"标签——点进去直达会话页，正好是 AI 没能回答（NEEDS_HUMAN）或正由人工处理的会话。',
          },
          {
            title: '第 2 步 — 点击"人工接管"',
            body: '打开会话 → 人工接管。出现"人工接管中"横幅并显示您的名字；从这一刻起，AI 被禁止向该会话发送任何消息。',
          },
          {
            title: '第 3 步 — 像真人一样对话',
            body: '直接给顾客发消息：处理投诉、报特殊价格、同意退换……您说的每个数字都是真人的意见，不经过 AI 的 Gate。',
            tip: '一个会话同时只有一个人持有——不用担心两名员工同时回复同一位顾客。',
          },
          {
            title: '第 4 步 — 处理完点"交还给 AI"',
            body: '处理完成，点击"交还给 AI"，bot 恢复自动流程。当前持有的会话数显示在"设置 → Bot AI"（人工接管）；AI 自主率在"报表 → AI 表现"查看。',
          },
        ],
        seeAlso: ['ly-do-ai-khong-bia-gia', 'doc-bao-cao'],
      },
    ],
  },

  // ============================================================ 5. 报表与管理
  {
    id: 'bao-cao-quan-tri',
    title: '报表与管理',
    articles: [
      {
        id: 'doc-bao-cao',
        title: '看懂报表页',
        minutes: 3,
        summary: '报表汇总 14 天真实数据：营收、各状态订单数、AI 自主成交的百分比、头部客户和头部商品。',
        steps: [
          {
            title: '第 1 步 — 读懂 4 张汇总卡片',
            body: '侧边栏 → 报表：14 天营收（已确认订单）、14 天订单（已确认）、已购买客户、平均订单价值。营收从已确认 + 已送达订单计算。',
          },
          {
            title: '第 2 步 — 读取按日图表',
            body: '柱状图"每日营收"：悬停柱子显示具体日期、金额和订单数。没有营收的日期柱子为空——冷清的日子一眼可见。',
          },
          {
            title: '第 3 步 — 衡量 AI 表现',
            body: 'AI 表现卡片：总会话、AI 自主处理、人工接管，以及"Bot 自主率（%）"指标。它衡量 AI 在无需人工介入的情况下能自主处理多少。',
          },
          {
            title: '第 4 步 — 盯住头部客户/头部商品',
            body: '客户 Top 10（按消费额）和商品 Top 10（按销量）——会员计划和进货计划的现成素材。',
            tip: '数据直接取自系统存储，不是估算——放心拿去开会。',
          },
        ],
        seeAlso: ['thanh-vien-phan-quy', 'doc-trang-don-hang'],
      },
      {
        id: 'thanh-vien-phan-quy',
        title: '成员与权限',
        minutes: 3,
        summary: '设置 → 团队成员：添加 AGENT（销售人员）、ADMIN（管理员）或 OWNER（店主）。AGENT 只读数据，仅在"会话 + 订单"中工作。',
        steps: [
          {
            title: '第 1 步 — 打开添加成员表单',
            body: '设置 → 团队成员 →"添加成员"按钮打开表单：新成员邮箱、密码（至少 8 位）、角色。',
          },
          {
            title: '第 2 步 — 选对角色',
            body: 'AGENT——销售人员（会话 + 订单）；ADMIN——店铺管理；OWNER——店主（全部权限）。只有 OWNER 能创建 OWNER——ADMIN 无权自行册封店主。',
            tip: '最小权限原则：销售人员用 AGENT，只有持有 GHN/AI 账号的人需要 OWNER。',
          },
          {
            title: '第 3 步 — 理解 AGENT 的边界',
            body: 'AGENT 可以查看总览、报表、会话、订单、商品、客户，可以发消息/接管/确认与取消订单；但不能修改"设置"和"商品"，不能添加成员，也看不到上线向导。',
          },
          {
            title: '第 4 步 — 管理账号生命周期',
            body: '店主在"设置 → 账号与系统 → 修改密码"修改自己的密码。忘记密码的人使用登录页上的"重置密码"入口。',
          },
        ],
        seeAlso: ['dang-nhap', 'cai-app-pwa'],
      },
      {
        id: 'cai-app-pwa',
        title: '把应用装到手机上（PWA）',
        minutes: 2,
        summary: 'Sales AI Console 是可安装到主屏幕的 Web 应用（PWA——SalesAI）。装一次，像原生应用一样打开；静态界面有缓存，弱网也能使用。',
        steps: [
          {
            title: '第 1 步 — 在 iPhone/iPad 上安装',
            body: '用 Safari 打开控制台 → 分享按钮 →"添加到主屏幕"→ 添加。SalesAI 图标出现在主屏幕，全屏打开如同原生应用。',
          },
          {
            title: '第 2 步 — 在 Android 上安装',
            body: '用 Chrome 打开 → ⋮ 菜单 →"安装应用"（或"添加到主屏幕"）→ 安装。下次直接从主屏幕进入。',
          },
          {
            title: '第 3 步 — 弱网也能用',
            body: 'Service worker 缓存静态部分（界面、样式、图标）：重新打开更快，4G 弱网时控制台框架仍然可见。会话/订单数据仍需联网刷新。',
          },
          {
            title: '第 4 步 — 单手也方便',
            body: '应用按竖屏设计，订单表格支持横向滚动；AGENT 销售账号打开应用即可在柜台前确认订单、接管会话。',
          },
        ],
        seeAlso: ['thanh-vien-phan-quy', 'human-takeover'],
      },
    ],
  },
];

module.exports = {
  lang: 'zh',
  product: 'Sales AI Console',
  categories,
};

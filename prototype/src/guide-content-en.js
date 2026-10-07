'use strict';
// guide-content-en.js — English edition of the Sales AI Console "User Guide" content.
//
// Full translation of src/guide-content.js: 5 categories / 20 articles / 84 steps.
// STRUCTURE PARITY CONTRACT (enforced by test/guide-content-i18n-en.js):
//   identical category ids, article ids, minutes, step counts, tip placement and
//   seeAlso arrays — only title/summary/steps title/steps body/tip are translated.
// Proper nouns kept as-is: SKU, GHN, Suri, Sales AI Console; system tokens such as
// sku_base, SECRET_IN_PROMPT, NEEDS_HUMAN, bot_off, auto_reply_comment and
// {{TenKhachHang}} are literal engine tokens and must not be localized.
//
//   categories[] : { id, title, articles[] }
//   articles[]   : { id, title, minutes, summary, steps[], seeAlso[] }
//   steps[]      : { title, body, tip? }

const categories = [
  // ============================================================ 1. QUICK START
  {
    id: 'bat-dau-nhanh',
    title: 'Quick Start',
    articles: [
      {
        id: 'dang-nhap',
        title: 'Log in to the Console',
        minutes: 2,
        summary: 'Sign in to Sales AI Console with the login ID and password your shop gives you. OWNER/ADMIN can configure everything; AGENT accounts only view data and sell.',
        steps: [
          {
            title: 'Step 1 — Open the login page',
            body: 'Go to your shop\'s Console address. The welcome screen shows a Login ID + Password form. Enter the ID (login-style, like thao2019 — no email needed) and the password, then click Log in.',
            tip: 'More than 5 failed attempts within one minute triggers a temporary lockout — wait a minute and try again.',
          },
          {
            title: 'Step 2 — First login',
            body: 'If the shop\'s setup is not finished yet, the Console opens straight into the "Shop Setup" wizard (the 7-step go-live checklist). Work through steps 1 to 7 in order, then click TURN ON AUTO BOT and the shop goes live.',
            tip: 'The first account created becomes OWNER — full control over the shop. After logging in, change the password right away under Settings → Account & system.',
          },
          {
            title: 'Step 3 — Forgot your password',
            body: 'Click "Forgot password? → Reset password", enter your registered email and click Create reset code. Paste the code into the Reset code field, enter a new password (at least 8 characters), then click Reset password.',
          },
          {
            title: 'Step 4 — Know your role',
            body: 'OWNER has full control, ADMIN manages the shop, and AGENT (sales staff) only views data and works in Conversations + Orders — no editing Settings or Products, and the go-live wizard stays hidden.',
          },
        ],
        seeAlso: ['bat-bot', 'thanh-vien-phan-quy'],
      },
      {
        id: 'ho-so-shop',
        title: 'Fill in the shop profile',
        minutes: 2,
        summary: 'Wizard step 1 — Shop Info: name, hotline, address. This is the source data the AI uses to introduce your shop and print on order confirmation bills.',
        steps: [
          {
            title: 'Step 1 — Open the Shop Setup wizard',
            body: 'After your first login (or from Settings, click "Complete setup"), you see 7 step cards. Card 1 is Shop Info.',
          },
          {
            title: 'Step 2 — Fill in all 3 fields',
            body: 'Shop name (e.g. Scent Candle Shop), Hotline (e.g. 090xxxxxxx), Address (e.g. 123 ABC, District 1, HCMC). All 3 fields are required — leave one out and the card stays NOT DONE.',
          },
          {
            title: 'Step 3 — Save step 1',
            body: 'Click Save Step 1. The card flips to a green DONE pill and the wizard counter ticks up (e.g. 1/7).',
            tip: 'The shop name and hotline appear in the bot\'s advice and on bills — write exactly the brand you want customers to see.',
          },
          {
            title: 'Step 4 — Add profile details for the AI',
            body: 'Want the AI to understand your shop more deeply? Go to Settings → AI Shop Profile and fill in Industry, Return policy, Shipping policy, Business hours… Fields filled here carry HIGHER priority than the old prompt template — filling wins.',
          },
        ],
        seeAlso: ['viet-ngu-canh', 'ket-noi-fanpage-zalo'],
      },
      {
        id: 'ket-noi-fanpage-zalo',
        title: 'Connect Fanpage & Zalo',
        minutes: 3,
        summary: 'Wizard step 2 (Facebook Messenger) and step 3 (Zalo OA). The go-live checklist needs at least one of the two channels green so the bot has customers to talk to. This lab build runs simulated adapters — Phase 2 wires the real APIs.',
        steps: [
          {
            title: 'Step 1 — Prepare the tokens',
            body: 'Facebook: get the Page ID and Page Access Token from Meta for Developers (pages_messaging permission). Zalo: get the OA ID and Access Token from the Zalo OA admin console. Tokens are secrets — paste them once; the system stores them masked and never shows them again.',
          },
          {
            title: 'Step 2 — Save step 2 (Facebook)',
            body: 'On card 2, Facebook Messenger, enter the Page ID + Page Access Token, then click Save Step 2.',
          },
          {
            title: 'Step 3 — Save step 3 (Zalo)',
            body: 'On card 3, Zalo OA, enter the OA ID + Access Token, then click Save Step 3.',
            tip: 'Going live needs AT LEAST one channel (step 2 or step 3). Connect both, and Messenger and Zalo customers are served by the same bot.',
          },
          {
            title: 'Step 4 — A note about the lab build',
            body: 'Channels currently run in mock mode so you can walk the full flow without a real page. When production wiring lands (Phase 2), the saved IDs/tokens stay exactly as they are — the system just switches to real API calls.',
          },
        ],
        seeAlso: ['bat-bot'],
      },
      {
        id: 'them-san-pham',
        title: 'Add products',
        minutes: 4,
        summary: 'Products are the single source of truth for prices and stock. Add them by hand or import a CSV, set aliases for how customers actually talk, and pause selling the moment something runs out.',
        steps: [
          {
            title: 'Step 1 — Open the Products page',
            body: 'Sidebar → Products → the + Add product button.',
          },
          {
            title: 'Step 2 — Fill in the core fields',
            body: 'Product name, base SKU (sku_base — unique, e.g. NEN-S-CANDLE), Price (VND, must be a number > 0), Stock. You can also fill Size and Color to generate variants.',
            tip: 'sku_base is the key: order extraction, CSV import and reports all depend on it — keep it short, easy to remember, and never change it later.',
          },
          {
            title: 'Step 3 — Add aliases',
            body: 'In the "Aliases (how customers say it, comma-separated)" field, list the informal names customers use, e.g. scented candle, nen thom. The bot matches aliases whenever a customer types something other than the official name.',
          },
          {
            title: 'Step 4 — Bulk import with CSV',
            body: 'Products → Import CSV, paste a table whose first row is the header: name,sku,price,stock,size,color,weight. Failing rows are reported separately with their row numbers and never block the valid ones.',
          },
          {
            title: 'Step 5 — Pause selling when needed',
            body: 'Out of stock or discontinued: flip the toggle on the right of the product row (On sale → Paused) — the bot instantly stops recommending that item. The Delete button is a soft delete: the product leaves recommendations but old orders still read it.',
          },
        ],
        seeAlso: ['ai-tu-dong-tao-don', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'cau-hinh-van-chuyen',
        title: 'Configure GHN shipping',
        minutes: 2,
        summary: 'Wizard step 5 — GHN (shipping carrier): shop id + token. Required green if you enable Auto-order, because once an order is confirmed the system pushes the shipment straight to GHN.',
        steps: [
          {
            title: 'Step 1 — Get the GHN Shop ID and Token',
            body: 'Log in to the GHN partner portal and grab the Shop ID (a numeric string, e.g. 1234567) and the shop Token.',
          },
          {
            title: 'Step 2 — Save step 5',
            body: 'Card 5, GHN (shipping): enter the GHN Shop ID + GHN Token, then click Save Step 5.',
            tip: 'The token is write-once and never displayed again — if you lose it, create a new one in GHN and save it over the old.',
          },
          {
            title: 'Step 3 — How it relates to Auto-order',
            body: 'With Auto-order on in Settings → Bot AI, the go-live checklist forces step 5 to be green. Missing it, you get the reason spelled out word for word: "Step 5: auto-order is on, so a GHN token + shop id are required (or turn auto-order off)".',
          },
          {
            title: 'Step 4 — How shipments flow',
            body: 'When an order is confirmed with CONFIRM ORDER, the system creates a GHN shipment, writes the tracking code into the order detail and receives GHN webhooks to move Shipping → Delivered.',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'dang-ky-ai',
        title: 'Sign up & plug in an AI key',
        minutes: 3,
        summary: 'Pick a provider (DeepSeek, OpenAI, Gemini, Grok, Kimi or Local), paste the API key and click Test AI call. The go-live checklist only turns green when the AI test reports PASS ONLINE.',
        steps: [
          {
            title: 'Step 1 — Choose a provider',
            body: 'Wizard card 6, AI Provider: choose DeepSeek / OpenAI / Local (stub — no network calls). For Gemini, Grok or Kimi, go to Settings → AI Engine → Edit configuration; the provider list is read dynamically from the system.',
            tip: 'Each provider ships its own default model (deepseek-chat, gpt-4o-mini, gemini-2.0-flash, grok-3-mini, kimi-k2…). Leave the Model field empty to use the default; fill it in to override.',
          },
          {
            title: 'Step 2 — Paste the API key',
            body: 'Paste a key shaped like sk-… into the API Key field. Keys are stored masked — never returned to the browser. Then click Save AI configuration.',
          },
          {
            title: 'Step 3 — Test the AI call',
            body: 'Click Test AI call. A green PASS result (with the provider name) means the AI is ONLINE. On ERROR, the message shows right beside it and the last_error column in Settings → AI Engine records the exact cause.',
            tip: 'A wrong key, exhausted credit or a blocked network all surface right here — fix it and test again; it takes seconds.',
          },
          {
            title: 'Step 4 — Lock in the go-live condition',
            body: 'The go-live checklist requires step 6 green (AI ONLINE). Without a real key you can pick Local to try things out, but selling for real at go-live needs an online provider.',
          },
        ],
        seeAlso: ['bat-bot', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'bat-bot',
        title: 'Go live: turn the bot on',
        minutes: 2,
        summary: 'Once the 7-item checklist is complete, the Go-live card unlocks the TURN ON AUTO BOT button. Until then, the system lists the blockers step by step for you to clear one by one.',
        steps: [
          {
            title: 'Step 1 — Run the last two tests',
            body: 'Card 7, Conversation + order test: click Run conversation test (the bot can answer a customer) and Run order test (a CONFIRMED order gets created). Both green pills are mandatory before enabling the bot.',
          },
          {
            title: 'Step 2 — Read the Go-live card',
            body: 'Anything still missing is listed plainly on the Go-live card: shop name + hotline + address incomplete, no product on sale, AI not ONLINE, no channel connected (needs Facebook or Zalo), auto-order on but GHN missing. Fix exactly the item it names and you are done.',
          },
          {
            title: 'Step 3 — Click TURN ON AUTO BOT',
            body: 'Checklist complete, the button lights up — one click and the bot answers customers automatically on the connected channels. The Console announces "BOT IS ON — your shop is live!" and takes you back to Overview.',
          },
          {
            title: 'Step 4 — You stay in control afterwards',
            body: 'Need to pause? Settings → Bot AI, switch off "Bot auto-reply" — every auto-send is blocked instantly (bot_off). Safe while you are editing prices or restocking.',
          },
        ],
        seeAlso: ['dang-ky-ai', 'human-takeover'],
      },
    ],
  },

  // ============================================================ 2. BUILDING THE AI
  {
    id: 'xay-dung-ai',
    title: 'Building the AI',
    articles: [
      {
        id: 'viet-ngu-canh',
        title: 'Write the AI context',
        minutes: 4,
        summary: 'Teach the AI to speak in your shop\'s voice through 9 groups of information: tone of voice, addressing, return policy, business hours, FAQ, forbidden topics, sales priorities, language, order-closing rules. Paste a secret into the context and the system blocks it on the spot.',
        steps: [
          {
            title: 'Step 1 — Fill the guided Prompt form',
            body: 'Settings → Prompt (guided form): Tone (warm and friendly), Addressing (how the assistant speaks to customers), Sales priorities (gift combos, size-M candles), Language (Vietnamese with full diacritics), Return policy (returns within 7 days), Business hours (8am–9pm daily), Order-closing rules (collect full name / phone / address, then confirm), Never say (one per line: never quote a price missing from the product database, never promise an exact delivery time). Then click Save prompt.',
          },
          {
            title: 'Step 2 — Add the AI Shop Profile',
            body: 'Settings → AI Shop Profile: name, industry, hotline, logo, shipping policy, advisory rules, order-closing rules, FAQ (one per line: question | answer), Forbidden information. Fields filled here OVERRIDE the old prompt template when the system builds the context.',
            tip: 'To pivot the advice for one campaign, just edit Sales priorities — no need to rewrite the whole context.',
          },
          {
            title: 'Step 3 — Verify with View prompt',
            body: 'Click View prompt to read the exact final context the system sends to the model. This is the most honest version there is — tune until you are satisfied.',
          },
          {
            title: 'Step 4 — Never paste secrets',
            body: 'Do not paste API keys or tokens (sk-…, token, api-key…) into any context field — the system scans and returns SECRET_IN_PROMPT. Secrets belong only in the API key field of the AI Engine.',
          },
          {
            title: 'Step 5 — Keep numbers out of the prompt',
            body: 'Prices, stock, SKUs, promotions… never hard-code them in the prompt — the bot always reads them from FACTS built by the ProductDB. The context only teaches the voice and the advisory boundaries.',
          },
        ],
        seeAlso: ['ly-do-ai-khong-bia-gia', 'ho-so-shop'],
      },
      {
        id: 'ly-do-ai-khong-bia-gia',
        title: 'Why the AI never invents prices',
        minutes: 3,
        summary: 'Every price/stock number the bot quotes comes 100% from ProductDB via FACTS. The Action Gate screens every message before sending; when the AI is unsure it hands back to a human instead of guessing.',
        steps: [
          {
            title: 'Step 1 — Understand FACTS',
            body: 'Before every reply, the system builds FACTS from the ProductDB and orders: prices, stock, SKUs, shipping fees, order status. The AI may only quote numbers inside FACTS — the rule sits right in the system context.',
          },
          {
            title: 'Step 2 — The Action Gate screens before sending',
            body: 'Every message the AI proposes passes the Action Gate: draft prices/stock are checked against the DB. A wrong number, an invented SKU or a wrong policy promise is blocked — a customer never receives an inaccurate message.',
            tip: 'Bot went quiet on one message? Check Audit in the order detail — the Gate records what it approved or blocked, and at which stage.',
          },
          {
            title: 'Step 3 — Out of data? Hand it to a human',
            body: 'Customer asks something FACTS cannot answer (a paused item, a policy beyond the shop): the bot invites them to leave a phone number or flags NEEDS_HUMAN — the conversation jumps to NEEDS HUMAN and lands in the notification bell for staff.',
          },
          {
            title: 'Step 4 — Keep trust with real numbers',
            body: 'If the shop changes a price mid-conversation, the system re-quotes at the NEW price and asks the customer to confirm again — never closes the order at the old price and apologizes afterwards.',
          },
        ],
        seeAlso: ['viet-ngu-canh', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'tach-tin-quick-reply',
        title: 'Message splitting & quick replies',
        minutes: 4,
        summary: 'One reply can go out as several messages with tappable buttons for the customer: --- splits messages, [[Label]] makes a quick reply, [[[Label|payload]]] makes a postback, and {{TenKhachHang}} greets the customer by name.',
        steps: [
          {
            title: 'Step 1 — Split points with ---',
            body: 'A line holding nothing but 3 or more dashes is a boundary: each block becomes one message, sent in order. A --- inside a sentence does NOT split — it only counts standing alone on its own line.',
            tip: 'Use it to peel the bill into its own message and keep the greeting separate — customers read it without a wall of text.',
          },
          {
            title: 'Step 2 — Add quick replies with [[Label]]',
            body: 'Writing [[See the price list]] in a message renders a button; the default payload is the label itself. Want a payload different from the label: [[Price list|see_price_list]].',
          },
          {
            title: 'Step 3 — Use postbacks [[[Label|payload]]]',
            body: 'Triple brackets [[[Label|payload]]] create a postback button — the label shows to the customer, the payload goes to the server. The parser detects 3 brackets before 2, so tokens never get "eaten".',
          },
          {
            title: 'Step 4 — Greet by name with {{TenKhachHang}}',
            body: 'Drop the {{TenKhachHang}} variable into your copy and the system substitutes the customer\'s name; when the name is unknown it falls back to a friendly "you". The variable also works in Facebook comment replies.',
          },
          {
            title: 'Step 5 — Old replies never break',
            body: 'A message with no markers passes through byte for byte — the shop\'s old copy templates keep working exactly as before, no edits needed.',
          },
        ],
        seeAlso: ['ai-tu-dong-tao-don', 'viet-ngu-canh'],
      },
      {
        id: 'ai-tu-dong-tao-don',
        title: 'The AI creates orders automatically',
        minutes: 4,
        summary: 'Customer asks about an item → picks a variant → leaves a phone number → name & address → the bot sends a confirmation bill. The order lands on the Orders page as Draft (awaiting confirmation), with stock held for 24 hours.',
        steps: [
          {
            title: 'Step 1 — Customer asks, the bot advises the right variant',
            body: 'The bot matches aliases + FACTS to recommend the right item in an in-stock size/color. Once the customer picks, the bot opens the ordering flow by itself.',
          },
          {
            title: 'Step 2 — Ask for the phone number first',
            body: 'Missing a phone number, the bot proactively asks: "May I have your phone number to confirm the order?". The number is the key to matching returning customers — a repeat purchase never starts from zero.',
          },
          {
            title: 'Step 3 — Collect name + address, then send the bill',
            body: 'With the data complete, the system renders the bill from validated data (the AI never invents a bill): product, quantity, subtotal, shipping fee, total. The customer nods and the order moves to Confirmed.',
            tip: 'The bill always renders from the DB at the moment of confirmation — change a price in the morning and by the afternoon the bot quotes the new one.',
          },
          {
            title: 'Step 4 — A 24-hour hold',
            body: 'Draft orders hold stock for at most 24 hours (the hold deadline shows right in the order detail). When time runs out without confirmation, the system releases the stock and closes the draft.',
          },
          {
            title: 'Step 5 — Auto-order pushes to GHN',
            body: 'With Auto-order enabled (Settings → Bot AI), the moment a draft exists the system prepares to push a GHN shipment — which is why wizard step 5 requires a GHN token + shop id.',
          },
        ],
        seeAlso: ['doc-trang-don-hang', 'them-san-pham'],
      },
    ],
  },

  // ============================================================ 3. ORDERS & SHIPPING
  {
    id: 'don-hang-van-chuyen',
    title: 'Orders & Shipping',
    articles: [
      {
        id: 'doc-trang-don-hang',
        title: 'Reading the Orders page',
        minutes: 3,
        summary: 'Six statuses, one lifecycle: Draft (awaiting confirmation) → Confirmed → Shipping → Delivered; cancellations branch two ways, Cancelled and Cancel pending (carrier). Click an order row to read the full detail.',
        steps: [
          {
            title: 'Step 1 — Know the 6 status pills',
            body: 'Draft (awaiting confirmation) — the customer has not nodded yet; Confirmed — CONFIRMED; Shipping — on the way; Delivered — complete; Cancelled — closed from the shop or customer side; Cancel pending (carrier) — a cancellation was requested, waiting for the carrier to acknowledge.',
          },
          {
            title: 'Step 2 — Filter with chips',
            body: 'The chip row above the table filters straight to the group you are working on — focus on unconfirmed Drafts and unresolved Cancel pending (carrier) orders.',
          },
          {
            title: 'Step 3 — Open the order detail',
            body: 'Click the order row: the detail block shows Customer (name, phone, channel, address), Products (qty, unit price, line total), Subtotal / Shipping fee / Total, and the Shipping section (tracking code, status, created time).',
          },
          {
            title: 'Step 4 — Trace the source conversation',
            body: 'The Open conversation button takes you straight to the chat that produced the order — when a customer restates a request, you open the right place instead of digging manually.',
            tip: 'The Status history block logs every transition (who, when, why); recent Audit entries record what the Action Gate approved or blocked.',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'ai-tu-dong-tao-don'],
      },
      {
        id: 'xac-nhan-va-day-dvvc',
        title: 'Confirm orders & push to the carrier',
        minutes: 3,
        summary: 'Click CONFIRM ORDER: the system re-validates the latest stock/price before committing (phase B) and creating the GHN shipment. If the shipment is missing, use RETRY SHIPMENT — never a duplicate.',
        steps: [
          {
            title: 'Step 1 — Close the Draft',
            body: 'Open the Draft → CONFIRM ORDER → confirm. The system re-checks stock and the LATEST price before committing — even a price changed at noon gets caught.',
          },
          {
            title: 'Step 2 — Receive the GHN shipment',
            body: 'Confirmation succeeds, the order moves to Confirmed and the system pushes GHN to create the shipment; the tracking code appears right in the Shipping section and a toast reads "Confirmed … — shipment …".',
          },
          {
            title: 'Step 3 — Handle a Confirmed order without a shipment',
            body: 'Order Confirmed but no shipment yet (GHN hiccup…): click RETRY SHIPMENT — the engine re-runs the exact sending flow, with duplicate-shipment protection built in.',
          },
          {
            title: 'Step 4 — Track until delivered',
            body: 'GHN webhooks update the status: Shipping → Delivered. Reports count revenue from Confirmed + Delivered orders, so there is no need to wait for delivery to see the numbers.',
          },
        ],
        seeAlso: ['cau-hinh-van-chuyen', 'huy-don-2-chieu'],
      },
      {
        id: 'huy-don-2-chieu',
        title: 'Two-way order cancellation',
        minutes: 3,
        summary: 'Cancelling a Draft is an in-house affair — stock is restored immediately. A confirmed order with a shipment must be cancelled through the carrier; the order then sits in Cancel pending (carrier) awaiting acknowledgement.',
        steps: [
          {
            title: 'Step 1 — Cancel a Draft',
            body: 'Open the Draft → CANCEL ORDER → confirm. Stock is restored right away and the bot goes back to recommending that item normally.',
          },
          {
            title: 'Step 2 — Cancel a Confirmed order (with a shipment)',
            body: 'A Confirmed order with a shipment: CANCEL ORDER sends the cancellation through GHN. The order moves to Cancel pending (carrier) with a reason — you must wait for the carrier to nod; nobody may self-write Cancelled.',
          },
          {
            title: 'Step 3 — Retry when the carrier stalls',
            body: 'Order stuck in Cancel pending (carrier): click RETRY CARRIER CANCELLATION to re-run the exact engine flow — never edit the DB directly, the data stays safe.',
          },
          {
            title: 'Step 4 — Read the result in the order detail',
            body: 'Once cancelled, the Shipping block records who cancelled, why and when; the order shows Cancelled with a red line "Cancelled · by …". The carrier webhook keeps watching the shipment until it truly closes.',
            tip: 'Customer changed their mind after cancelling? Create a new order right from the same conversation — the chat history is intact.',
          },
        ],
        seeAlso: ['xac-nhan-va-day-dvvc', 'doc-trang-don-hang'],
      },
    ],
  },

  // ============================================================ 4. COMMENTS & AUTOMATION
  {
    id: 'binh-luan-automation',
    title: 'Comments & Automation',
    articles: [
      {
        id: '3-cong-tac-comment',
        title: 'The three Facebook comment switches',
        minutes: 3,
        summary: 'Settings → Facebook Comments — automated: auto-reply to comments, hide negative comments, move buyers from comments to inbox. Flip a switch and it takes effect instantly, no restart.',
        steps: [
          {
            title: 'Step 1 — Auto-reply to comments',
            body: 'Turn on "Auto-reply to comments" (auto_reply_comment): questions and buying intent under posts get public answers from the bot, and the copy uses the {{TenKhachHang}} variable to greet each commenter by name.',
          },
          {
            title: 'Step 2 — Hide negative comments',
            body: 'Turn on "Hide negative comments" (hide_negative_comment): comments containing words like scam, fake goods, rip-off, terrible… are hidden and a task is created for staff — no more policing the page 24/7.',
            tip: 'The negative keyword list is open configuration — add words that match your niche and it takes effect immediately.',
          },
          {
            title: 'Step 3 — Push buyers into the inbox',
            body: 'Turn on "Move buyers to inbox from comments" (auto_inbox_from_comment): anyone asking "how much", "still available", "I\'ll take it"… shows buying intent — the system moves them to the sales inbox to close the deal in private.',
          },
          {
            title: 'Step 4 — Prices still come from the DB, not the comments',
            body: 'The public answer is just a polite sentence; price/stock still flow through the same FACTS pipeline as private messages — however noisy the comment section gets, the bot never misquotes a number.',
          },
        ],
        seeAlso: ['human-takeover', 'ly-do-ai-khong-bia-gia'],
      },
      {
        id: 'follow-up-sau-ban',
        title: 'Post-sale follow-up',
        minutes: 3,
        summary: 'Settings → Automation — post-delivery follow-up: schedule post-delivery care, review requests and repurchase reminders by days. Customers who declined ads never receive marketing messages.',
        steps: [
          {
            title: 'Step 1 — Set the schedule in the Automation card',
            body: 'Settings → Automation — post-delivery follow-up: fill in "Post-delivery follow-up (hours)" (max 720) and "Repurchase reminder after (days)" (max 365).',
          },
          {
            title: 'Step 2 — Enable each message type',
            body: 'Post-delivery care: a check-in after the order is Delivered. Review request: asks for a review after delivery. Purchase reminder: a repurchase nudge — counts as MARKETING. Then click Save Automation.',
            tip: 'The configuration only sets the SCHEDULE — every message still passes the core\'s 24h Window / Quota / Opt-out gates. There is no way to spam a customer.',
          },
          {
            title: 'Step 3 — Respect opted-out customers',
            body: 'Customers who declined ads are marked "Ad declined" (visible on the Customers page): purchase reminders stop for them permanently — only transactional messages like bills and shipment updates still go out.',
          },
          {
            title: 'Step 4 — Watch automation health',
            body: 'The Automation card counts scheduled jobs and opted-out customers and breaks follow-ups down by type; on a failed send the system retries within limits, then records NEEDS_HUMAN — no blind resending.',
          },
        ],
        seeAlso: ['doc-trang-don-hang', '3-cong-tac-comment'],
      },
      {
        id: 'human-takeover',
        title: 'Take over a conversation',
        minutes: 3,
        summary: 'When the AI is unsure it hands back to a human: the conversation becomes NEEDS HUMAN and lands in the notification bell. Click TAKE OVER to chat as staff; when done, click HAND BACK TO AI.',
        steps: [
          {
            title: 'Step 1 — Get the alert',
            body: 'The notification bell carries a "Needs human" label — click it and you jump straight to the Conversations page, exactly the threads the AI could not finish (NEEDS_HUMAN) or that a human currently holds.',
          },
          {
            title: 'Step 2 — Click TAKE OVER',
            body: 'Open the conversation → TAKE OVER. A banner "AGENT IS TAKING OVER" lights up with your name; from that second the AI is forbidden from sending any message into that conversation.',
          },
          {
            title: 'Step 3 — Chat like a real person',
            body: 'Type messages straight to the customer: handle complaints, quote special prices, approve a return… Every number you say is a human\'s word — it does not pass the AI Gate.',
            tip: 'One conversation is held by exactly one person — no risk of two staff answering the same customer.',
          },
          {
            title: 'Step 4 — HAND BACK TO AI when done',
            body: 'Finished? Click HAND BACK TO AI and the bot resumes the automated flow. The count of held conversations shows in Settings → Bot AI (Human takeover); the AI autonomy rate lives in Reports → AI performance.',
          },
        ],
        seeAlso: ['ly-do-ai-khong-bia-gia', 'doc-bao-cao'],
      },
    ],
  },

  // ============================================================ 5. REPORTS & ADMINISTRATION
  {
    id: 'bao-cao-quan-tri',
    title: 'Reports & Administration',
    articles: [
      {
        id: 'doc-bao-cao',
        title: 'Reading the Reports page',
        minutes: 3,
        summary: 'Reports aggregate 14 days of real data: revenue, orders by status, how much the AI closed on its own, top customers and top products.',
        steps: [
          {
            title: 'Step 1 — Read the 4 summary cards',
            body: 'Sidebar → Reports: 14-day revenue (confirmed orders), 14-day orders (confirmed), paying customers, average order value. Revenue counts Confirmed + Delivered orders.',
          },
          {
            title: 'Step 2 — Read the daily chart',
            body: 'The bar chart "Revenue by day": hover a bar to see the exact date, amount and order count. A day without revenue shows an empty bar — slow days are visible at a glance.',
          },
          {
            title: 'Step 3 — Measure AI performance',
            body: 'The AI performance card: Total conversations, Handled by AI, Taken over by staff, and the Bot autonomy (%) metric. It measures how much the AI handles without human intervention.',
          },
          {
            title: 'Step 4 — Watch top customers / top products',
            body: 'Top 10 customers (by spend) and Top 10 products (by units sold) — ready-made fuel for loyalty programs and restocking plans.',
            tip: 'Numbers come straight from the system store, not estimates — take them into the meeting with confidence.',
          },
        ],
        seeAlso: ['thanh-vien-phan-quy', 'doc-trang-don-hang'],
      },
      {
        id: 'thanh-vien-phan-quy',
        title: 'Team members & roles',
        minutes: 3,
        summary: 'Settings → Team members: add an AGENT (sales staff), ADMIN (manager) or OWNER (shop owner). AGENT accounts only read data and work in Conversations + Orders.',
        steps: [
          {
            title: 'Step 1 — Open the add-member form',
            body: 'Settings → Team members → the Add member button opens a form: new member email, Password (at least 8 characters), Role.',
          },
          {
            title: 'Step 2 — Pick the right role',
            body: 'AGENT — sales staff (conversations + orders); ADMIN — shop manager; OWNER — shop owner (full control). Only an OWNER can create an OWNER — an ADMIN cannot crown a new owner.',
            tip: 'Least-privilege principle: sales staff get AGENT; only whoever holds the GHN/AI accounts needs OWNER.',
          },
          {
            title: 'Step 3 — Understand AGENT limits',
            body: 'AGENT can view Overview, Reports, Conversations, Orders, Products and Customers, and can send messages, take over, confirm and cancel orders; but they CANNOT edit Settings or Products, add members, or see the go-live wizard.',
          },
          {
            title: 'Step 4 — Manage the account lifecycle',
            body: 'The owner changes their own password in Settings → Account & system → Change password. Anyone who forgets theirs uses the Reset password path right on the login page.',
          },
        ],
        seeAlso: ['dang-nhap', 'cai-app-pwa'],
      },
      {
        id: 'cai-app-pwa',
        title: 'Install the app on your phone (PWA)',
        minutes: 2,
        summary: 'Sales AI Console is a web app installable to the home screen (PWA — SalesAI). Install once, open it like a real app; the static UI is cached so it still works on a weak connection.',
        steps: [
          {
            title: 'Step 1 — Install on iPhone/iPad',
            body: 'Open the Console in Safari → the Share button → "Add to Home Screen" → Add. The SalesAI icon sits on the home screen and opens full screen like an app.',
          },
          {
            title: 'Step 2 — Install on Android',
            body: 'Open in Chrome → the ⋮ menu → "Install app" (or "Add to Home Screen") → Install. Next time, launch it straight from the home screen.',
          },
          {
            title: 'Step 3 — Still works on a flaky connection',
            body: 'The service worker caches the static parts (UI, styles, icons): reopening is faster and the console frame still shows on weak 4G. Conversation/order data still needs the network to refresh.',
          },
          {
            title: 'Step 4 — One-handed convenience',
            body: 'The app is built portrait-first with a horizontally scrollable orders table; an AGENT sales account opens the app and confirms orders or takes over conversations right at the counter.',
          },
        ],
        seeAlso: ['thanh-vien-phan-quy', 'human-takeover'],
      },
    ],
  },
];

module.exports = {
  lang: 'en',
  product: 'Sales AI Console',
  categories,
};

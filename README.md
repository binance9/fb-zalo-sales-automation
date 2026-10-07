# FB-Zalo Sales Automation 🛍️🤖

**AI-powered sales automation console for Facebook & Zalo** — auto-reply to customers, close orders 24/7, push orders to shipping carriers (GHN), automate comments, follow up after sales, and track everything in a real-time dashboard.

> 🇻🇳 Dự án mã nguồn mở — bot bán hàng tự động Facebook/Zalo bằng AI. Hướng dẫn tiếng Việt ở cuối trang.

![status](https://img.shields.io/badge/dependencies-zero-brightgreen) ![node](https://img.shields.io/badge/node-%3E%3D18-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

- 🤖 **AI sales chat with personality ("Suri")** — cheerful, human-like auto-replies. Prices & stock are **always** read from your product database — the AI is architecturally prevented from inventing numbers (Action Gate validates every draft before sending).
- 🛒 **Automatic order closing** — the bot collects item → variant → phone → name → address, builds a bill, and creates the order. Humans confirm.
- 🚚 **GHN shipping integration** — create shipment, fees, tracking webhook, two-way cancellation (GHTK/J&T/ViettelPost adapters are scaffolded).
- 💬 **Comment automation** — auto-reply to Facebook comments, auto-HIDE negative comments (scam/insult detection), and pull buying-intent commenters into 1-1 inbox.
- 🔁 **Post-sale follow-ups** — thank-you, review requests, and re-purchase reminders on a schedule (with marketing opt-out).
- 🙋 **Human takeover** — any uncertain conversation goes to a "needs human" worklist; agents take over and hand back with one click.
- 📊 **Real-time reports** — 14-day revenue chart, orders by status, AI autonomy %, top-10 customers & products.
- 📚 **Built-in user guide** — 5 categories / 20 articles + a "Ask AI" guide assistant that answers questions about every feature.
- 🌐 **6 UI languages** — Tiếng Việt, English, 中文, 한국어, हिन्दी, 日本語 (one-click switcher, persisted).
- 👥 **Multi-role team** — OWNER / ADMIN / AGENT with shop-level data isolation, rate-limited login, scrypt-hashed passwords.
- 📱 **PWA** — install on iOS/Android; offline shell.

## 🧱 Tech highlights

- **Zero npm dependencies.** Pure Node.js built-ins (`http`, `crypto`, `fs`, `path`, `child_process`). Clone and run — no `npm install`.
- Store = JSON files per shop (atomic writes + transactions + audit log + DLQ + write-ahead intents, idempotent by `platformEventId`).
- Action Gate: every AI reply is a *proposal* validated against DB facts before sending — no hallucinated prices, no unauthorized discounts.
- 245-case offline regression matrix (14 areas) ships in `prototype/test/`.

## ✅ Requirements

| | |
|---|---|
| OS | Windows 10/11, Linux, or macOS |
| Node.js | **v18+** (tested on v20/v24) — no other runtime |
| RAM | 512 MB+ free (runs comfortably on a laptop/mini PC) |
| Disk | ~50 MB |
| Network | Local only to start. Live Facebook/Zalo/GHN channels need their API credentials (Phase-2 wiring, see below) |

## 🚀 Quick start

```bash
git clone https://github.com/binance9/fb-zalo-sales-automation.git
cd fb-zalo-sales-automation

# Windows
node prototype\server.js

# Linux / macOS
node prototype/server.js
```

Then open **http://localhost:8080** — the first-run page lets you create the shop OWNER account (email + password, stored locally with scrypt hashing). Follow the 7-step onboarding wizard to add products, connect channels, configure shipping and AI.

Run the offline test suite any time:

```bash
npm test        # or: node prototype/test/matrix/index.js  → 245/245 PASS
```

### Optional configuration

Copy `prototype/.env.example` → `prototype/.env.live` and fill in:
- `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` (or configure Gemini/Grok/Kimi in Settings → AI) — powers the live LLM wording of replies. Without a key the bot still works using its built-in rule engine.
- `META_PAGE_ACCESS_TOKEN`, `ZALO_OA_*`, `GHN_TOKEN` — for live channels (currently mock adapters; the onboarding wizard stores the credentials and the go-live gate verifies them).

## 🔐 Security notes

- Runs a plain-HTTP local server intended for **localhost / LAN lab use**. Put it behind a reverse proxy with TLS before exposing publicly.
- Secrets are never rendered back through the API (masked `***last4`); session cookies are HttpOnly; login is rate-limited (5 fails/min → 429).
- `data/` and `.env.live` are git-ignored — your shop data never leaves your machine.

## 📁 Layout

```
prototype/
  server.js        # HTTP server + factory (per-shop app isolation)
  src/             # sales engine: pipeline, action gate, orders, shipping, persona, i18n-data
  ui/              # SPA console + PWA + 6-language i18n dictionary
  test/            # 245-case offline matrix + unit suites
docs/              # design docs, audits, acceptance reports
```

## 🤝 Contributing

PRs welcome — please keep the offline matrix green (`npm test`) and don't lower validation gates. Roadmap (Phase-2): live Meta/Zalo webhook wiring, GHTK/J&T/ViettelPost adapters, guide article translations, ERP webhooks.

## 📄 License

[MIT](LICENSE) — free for personal and commercial use.

---

## 🇻🇳 Hướng dẫn tiếng Việt (tóm tắt)

1. Cài **Node.js 18+** → tải mã nguồn (`git clone` hoặc nút **Code → Download ZIP** trên GitHub).
2. Mở terminal trong thư mục project, chạy: `node prototype/server.js` (không cần `npm install` — 0 dependency).
3. Mở **http://localhost:8080** → tạo tài khoản chủ shop (lần đầu) → làm theo wizard 7 bước (sản phẩm, kênh, vận chuyển, AI) → **BẬT BOT TỰ ĐỘNG**.
4. Đổi ngôn ngữ giao diện: chọn VI/EN/中文/한국어/हिन्दी/日本語 ngay trên thanh đầu trang.
5. Test mọi thứ: `npm test` (245/245 PASS).

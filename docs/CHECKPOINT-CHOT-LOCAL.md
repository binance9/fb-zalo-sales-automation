# CHECKPOINT CHỐT LOCAL — 2026-10-05 20:42:04

## SỐ LIỆU CHUẨN (từ log gốc, 1 lượt chạy/suite — file evidence: docs/CHOT-LOCAL-RESULTS.txt)

| Suite | Case PASS |
|---|---|
| matrix (14 khu vực) | 245/245 |
| e2e-flows A–E | 5/5 |
| product-ready | 32/32 |
| live-adapters | 26/26 |
| p3c-cases | 28/28 |
| p3b-cases | 11/11 |
| gate-a | 7/7 |
| invariants-check | 6/6 |
| 18-cases | 18/18 |
| **TỔNG CASE DUY NHẤT** | **378** |

## ĐỐI SOÁT CHÊNH LỆCH
- Báo cáo trước đây ghi 396: **SAI cộng tay** — đếm trùng suite 18-cases (378 + 18 = 396).
- Số 384: lệch đúng 6 — nghi đếm trùng suite invariants (378 + 6 = 384).
- **SỐ CHUẨN = 378 case duy nhất** (mỗi case đếm 1 lần; các lần chạy lại trong phase không cộng thêm case).

## HASH ĐIỂM CHECKPOINT (SHA256)

```
77f5ff2f7448a63a  prototype/server.js
11d60d123e6ab28f  prototype/src/pipeline.js
6cc603495ac627a9  prototype/src/action-gate.js
1e3d24d4093e269b  prototype/src/order-engine.js
8251d12ec4028eb6  prototype/src/auth.js
c80a91d97b128eec  prototype/src/ai-provider.js
c87f75967f71ca0f  prototype/src/prompt-builder.js
d41abc07a3101042  prototype/src/product-db.js
6feddb4dfce6d01e  prototype/src/channel/meta-adapter.js
6721c8959f8e84fc  prototype/src/channel/zalo-adapter.js
43d2fcd67cbeeebb  prototype/src/shipping/ghn-adapter.js
2195b818ba931591  prototype/ui/app.js
2a09a060224e78c3  prototype/test/matrix/index.js
f007254ebef8c780  prototype/test/e2e-flows.js
3d20e58ed639dc87  prototype/test/product-ready.js
b31e0cb312eb3b10  prototype/START-BOT.bat
4e3cf05f66ede61b  prototype/.env.live
```

## KÊNH THẬT — BLOCKED chờ credential (không giả lập LIVE)
- META: BLOCKED — cần META_APP_ID/SECRET/PAGE_ID/PAGE_ACCESS_TOKEN (đăng ký developer — SMS)
- ZALO: BLOCKED — cần OA + ZALO_ACCESS_TOKEN/REFRESH_TOKEN (OTP)
- GHN: BLOCKED — cần GHN_TOKEN + GHN_SHOP_ID (sandbox dev.ghn.vn)
- Khi đủ: chạy kịch bản P2 từng kênh bằng tài khoản thử, ghi nhãn MOCK/SANDBOX/LIVE — không tự nhắn khách thật, không tạo vận đơn production.

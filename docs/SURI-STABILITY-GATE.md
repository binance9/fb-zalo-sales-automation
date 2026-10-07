
---

## ĐÍNH CHÍNH SAU JEV AUDIT (JEV-STABILITY-AUDIT.md — 6/6 ĐẠT, CODEX trung thực)

1. **[ĐÃ XỬ LÝ — CAO] Zombie load-generator**: PID 22152 (test/_load-generator.js chạy vô hạn do
   DURATION_S mặc định 0) đã bị kill; file sửa mặc định **tự dừng 600s** nếu không truyền tham số.
   Đồng thời đính chính §6: công bố "332 tin/225s" **lệch log** — log thật sent=317@225s + 1 lượt
   zombie còn ghi 1262 tin; lượt nghiệm thu sạch là 245/245 khi chạy độc lập.
2. **[ĐÃ ĐÍNH CHÍNH 3 chỗ mô tả lệch log]**: "run 3 + OB12" (log thật: Onboarding 20/20) ·
   "run 9: OB12" (log thật: gục 5 case Orders) · "332 tin/225s" (xem trên). Log gốc không bị chỉnh.
3. **[ĐÃ VÁ — THẤP-3] hole extractMoney**: "số nhà 25 đường 86033D" — đuôi HOA 'D'/'K' trước đây
   vẫn được đọc là đơn vị tiền → đã siết: chỉ nhận đ/Đ, d/k THƯỜNG có biên phải, vnd/VND.
   Test mới G7 (2 assert) — **STABILITY: 14/14 PASS** sau vá.
4. **[THẤP-4] Không xác minh được CreationDate 2 PID zombie cũ** (đã chết) — chỉ xác nhận hiện
   trạng đã sạch. CHƯA XÁC MINH cho thời điểm sinh zombie, không ảnh hưởng kết luận.

FINAL GATE (cập nhật): **LỖI 1 PASS (MOCK) — root cause zombie + hardening trọn vẹn · LỖI 2 CHƯA SỬA
root (dependency Action Gate LOCKED) + mitigation PASS · LỖI 3 PASS (MOCK)** · Regression: 18/18,
7/7, 28/28, matrix 245/245 ×2 liên tiếp sau vá.

'use strict';
// media.js — mock Vision + mock ASR (case 3, case 4).
// Ghi chú prototype: vision/ASR thật là model đa phương thức (CHƯA XÁC MINH chất lượng tiếng Việt
// theo AI2 mục 4 + AI3 Phụ lục C.5) — trước khi mở auto phải đo trên bộ ảnh/voice mẫu.

// matchImage(imageRef) -> {sku, score} — bảng tra giả theo tên file
const VISION_TABLE = {
  'nen-vanilla-m-do.jpg': { sku: 'NT-VANILLA-M-DO', score: 0.92 },
  'nen-vanilla.jpg': { sku: 'NT-VANILLA-S', score: 0.88 },
  'tra-hoa.jpg': { sku: 'TRA-HOA-SEY-50', score: 0.9 },
};

function mockVision(imageRef) {
  const hit = VISION_TABLE[String(imageRef || '').split('/').pop()];
  if (hit) return { ok: true, sku: hit.sku, score: hit.score };
  return { ok: true, sku: null, score: 0.35 }; // không khớp chắc chắn
}

const ASR_TABLE = {
  'voice-tra.amr': { ok: true, text: 'cho mình 1 hộp trà hoa sấy nhé', confidence: 0.91 },
  'voice-gia.amr': { ok: true, text: 'nến vanilla size M giá bao nhiêu vậy shop', confidence: 0.9 },
};

function mockASR(voiceRef) {
  const hit = ASR_TABLE[String(voiceRef || '').split('/').pop()];
  if (hit) return hit;
  return { ok: false, text: null, confidence: 0, error: 'ASR_UNAVAILABLE' };
}

module.exports = { mockVision, mockASR };

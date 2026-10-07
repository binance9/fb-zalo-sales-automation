'use strict';
// gateway.js — cửa vào duy nhất của hệ thống với nền tảng (AI3 mục 1).
// - Nhận event {channel, type, platformEventId, payload}.
// - DEDUPE tầng nhận theo event_id = channel + ':' + platformEventId (unique index trong store):
//     lần 2 trùng -> KHÔNG xử lý, trả {duplicate:true}, metric dedupe_hit++ (case 10).
// - Chuẩn hoá về một shape duy nhất (AI3 mục 1.3) và đẩy vào hàng đợi nội bộ.
// - Nơi duy nhất "tải media" về data/media/ (mô phỏng gateway dùng token tải file nền tảng).
// Ghi chú prototype: production verify HMAC X-Hub-Signature-256 + trả 200 ngay + worker nền qua bảng jobs
// (AI3 mục 1.2/1.4). Prototype bỏ HTTP + signature (không có server), giữ nguyên chuỗi dedupe -> queue -> worker.

const fs = require('fs');
const path = require('path');

class Gateway {
  constructor({ store, mediaDir, onEvent }) {
    this.store = store;
    this.mediaDir = mediaDir;
    this.queue = [];       // hàng đợi nội bộ các event_id chờ xử lý
    this.onEvent = onEvent; // worker: (normalizedEvent) => void
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  // Trả 200 NGAY tương ứng: persist vào inbox_events rồi mới xếp hàng xử lý.
  receive({ channel, type, platformEventId, payload }) {
    const event_id = `${channel}:${platformEventId}`;
    const res = this.store.insert('inbox_events', {
      event_id,
      channel,
      type: type || 'message',
      conversation_id: null, // điền khi worker normalize
      customer_ref: payload.customer_ref || null,
      raw_body: JSON.stringify(payload || {}),
      normalized_json: null,
      status: 'RECEIVED',
      fail_reason: null,
      received_at: this.store.now(),
      processed_at: null,
    });
    if (res.duplicate) {
      this.store.inc('dedupe_hit');
      return { accepted: false, duplicate: true, event_id, http: 200 };
    }
    this.queue.push(event_id);
    return { accepted: true, duplicate: false, event_id, http: 200 };
  }

  // Worker chạy nền: normalize + tải media + gọi onEvent.
  // SURI ASYNC (LỖI 2): onEvent (pipeline) có thể trả PROMISE ở đường LLM production —
  // sync path GIỮ NGUYÊN (throw đồng bộ vẫn vào catch như cũ); async path gắn CHÍNH logic
  // retry/FAILED hiện có vào .catch (không nuốt lỗi, không unhandledRejection). receive() KHÔNG đụng.
  processQueue() {
    const batch = this.queue.splice(0, this.queue.length);
    const results = [];
    const failRow = (row, err) => {
      row.attempts = (row.attempts || 0) + 1;
      if (row.attempts < 3) {
        row.status = 'RECEIVED';
        row.fail_reason = `retry_${row.attempts}:${String(err && err.message)}`;
        this.queue.push(row.event_id);
      } else {
        row.status = 'FAILED';
        row.fail_reason = String(err && err.message);
        this.store.inc('event_failed');
      }
    };
    for (const event_id of batch) {
      const row = this.store.findOne('inbox_events', e => e.event_id === event_id);
      if (!row || row.status !== 'RECEIVED') continue; // đã xử lý/huỷ
      row.status = 'PROCESSING';
      try {
        const normalized = this.normalize(row);
        row.normalized_json = JSON.stringify(normalized);
        row.conversation_id = normalized.conversation_id;
        row.status = 'PROCESSED';
        row.processed_at = this.store.now();
        results.push(normalized);
        if (this.onEvent) {
          const r = this.onEvent(normalized);
          if (r && typeof r.catch === 'function') {
            r.catch(err => {
              // SỬA LẦN 2 (bug thật, vùng INV-1): retry CÓ HẠN cho lỗi xử lý — như sync path.
              try { failRow(row, err); } catch (e2) { this.store.inc('event_failed'); }
            });
          }
        }
      } catch (err) {
        // SỬA LẦN 2 (bug thật, vùng INV-1): trước đây worker throw -> event bị đánh FAILED
        // và nuốt im lặng (xử lý 0 lần, không retry, không DLQ). Thay bằng retry CÓ HẠN
        // (<= 3 lần tổng): lần đủng lại đưa event về RECEIVED + xếp lại hàng; quá hạn mức
        // mới FAILED + metric event_failed. Dedupe tầng nhận (event_id) KHÔNG đổi — vẫn
        // đúng INV-1 (event trùng vẫn bị loại ở cửa vào).
        failRow(row, err);
      }
    }
    return results;
  }

  normalize(row) {
    const payload = JSON.parse(row.raw_body);
    const customer_ref = payload.customer_ref;
    if (!customer_ref) throw new Error('payload thiếu customer_ref');
    const thread = payload.thread_id || customer_ref;
    const media = payload.media ? JSON.parse(JSON.stringify(payload.media)) : null;
    if (media && media.platform_url) {
      // Gateway là nơi duy nhất chạm token để tải media (AI3 mục 1.3) — mock: ghi bytes giả về local.
      const localPath = this.downloadMedia(media.platform_url);
      media.local_path = localPath;
    }
    const conversation_id = `${row.channel}:${thread}`;
    // BL-1 (P3C): mốc CỬA SỔ 24h per channel+conversation — gateway là nơi DUY NHẤT ghi,
    // và CHỈ khi event THẬT TỪ USER (type 'message'). CẤM cập nhật từ: bot send, system
    // message, agent send, follow-up (đều KHÔNG đi qua receive), webhook receipt
    // (đi đường ingestReceipt riêng, không phải type 'message').
    if (row.type === 'message') {
      const ts = payload.timestamp_platform || row.received_at;
      const st = this.store.findOne('channel_state', s => s.conversation_id === conversation_id);
      if (st) this.store.updateRow('channel_state', st, { last_user_event_ts: ts, updated_at: this.store.now() });
      else this.store.insert('channel_state', {
        conversation_id, channel: row.channel, last_user_event_ts: ts, updated_at: this.store.now(),
      });
    }
    return {
      event_id: row.event_id,
      channel: row.channel,
      type: row.type,
      conversation_id,
      customer_ref,
      payload: {
        kind: payload.kind || 'text',
        text: payload.text || '',
        media,
        platform_message_id: payload.platform_message_id || null,
        timestamp_platform: payload.timestamp_platform || row.received_at,
      },
      received_at: row.received_at,
    };
  }

  downloadMedia(platformUrl) {
    const name = String(platformUrl).split('/').pop().split('?')[0];
    const localPath = path.join(this.mediaDir, name);
    if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, `mock-bytes:${name}`);
    return localPath;
  }
}

module.exports = { Gateway };

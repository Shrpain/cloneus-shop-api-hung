// POST /api/sepay-webhook — webhook Sepay cho giao dịch chuyển khoản TRỰC TIẾP
// vào tài khoản ảo KienLongBank 101499100004646156 (không qua payment link).
// Xác thực: header Authorization phải đúng `Apikey <SEPAY_API_KEY>`.
// Nội dung chuyển khoản chứa mã nạp cố định của khách (SUIEU...) thì cộng ví.
// Luôn trả 200 {success:true} khi đã nhận (kể cả không khớp mã) để Sepay không
// retry vô ích; chỉ trả 400 khi sai xác thực, 503/500 khi thiếu cấu hình hoặc lỗi KV.
import crypto from 'node:crypto';
import { jsonBody, isKvNotConfigured, pushList } from './_lib/common.js';
import { kvGet, kvSet, kvSetNX, kvIncrBy } from './_lib/kv.js';

function authMatches(authorization, sepayKey) {
  const expected = Buffer.from(`Apikey ${sepayKey}`, 'utf8');
  const actual = Buffer.from(String(authorization || ''), 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Chỉ chấp nhận POST' });
  }
  const sepayKey = process.env.SEPAY_API_KEY;
  if (!sepayKey) {
    return res.status(503).json({ success: false, message: 'Chưa cấu hình SEPAY_API_KEY trên server' });
  }
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  if (!authMatches(authorization, sepayKey)) {
    return res.status(400).json({ success: false, message: 'Xác thực webhook không hợp lệ' });
  }

  let body;
  try {
    body = jsonBody(req);
  } catch {
    // Payload lạ: đã nhận, ghi log, không retry.
    console.error('sepay-webhook: body không phải JSON hợp lệ');
    return res.status(200).json({ success: true });
  }
  const ack = () => res.status(200).json({ success: true });

  try {
    const amount = Number(body.transferAmount);
    // Chỉ xử lý tiền vào, số nguyên > 0.
    if (body.transferType !== 'in' || !Number.isInteger(amount) || amount <= 0) return ack();

    // Tìm mã nạp: tách token [A-Z0-9]+ từ content trước, rồi description.
    // Khách copy mã từ trang nạp tiền thì khớp ngay ở đây.
    let username = null;
    let matchedCode = null;
    for (const text of [body.content, body.description]) {
      const tokens = String(text || '')
        .toUpperCase()
        .match(/[A-Z0-9]+/g) || [];
      for (const token of tokens) {
        const owner = await kvGet('code:' + token);
        if (owner) {
          username = owner;
          matchedCode = token;
          break;
        }
      }
      if (username) break;
    }
    // Khách tự gõ mã (có gạch dưới, có khoảng trắng, dính số ngân hàng...):
    // nén bỏ mọi ký tự không phải A-Z0-9 rồi tìm mã SUIEU.../CLONEUS... trong
    // chuỗi đã nén. Ví dụ "SUIEUhung_01" -> "SUIEUHUNG01" vẫn khớp.
    if (!username) {
      for (const text of [body.content, body.description]) {
        const squashed = String(text || '')
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '');
        const cands = squashed.match(/SUIEU[A-Z0-9]{1,17}|CLONEUS[A-Z0-9]{1,15}/g) || [];
        for (const cand of cands) {
          const owner = await kvGet('code:' + cand);
          if (owner) {
            username = owner;
            matchedCode = cand;
            break;
          }
        }
        if (username) break;
      }
    }

    const referenceCode =
      String(body.referenceCode || '').trim() || 'sepay-' + String(body.id ?? Date.now());
    const at = body.transactionDate ? String(body.transactionDate) : new Date().toISOString();

    if (!username) {
      // Không khớp mã nào: lưu để chủ shop đối soát tay, vẫn trả 200.
      await kvSet(
        'unmatched:' + referenceCode,
        JSON.stringify({ content: String(body.content || ''), amount, at, source: 'sepay' }),
      );
      return ack();
    }

    // Chống trùng: 1 id Sepay chỉ cộng ví 1 lần (id không đổi qua mọi lần retry).
    // referenceCode của ngân hàng có thể trùng hoặc rỗng ở 2 giao dịch khác nhau.
    const record = {
      username,
      code: matchedCode,
      amount,
      referenceCode,
      sepayId: body.id ?? null,
      at,
      source: 'sepay',
    };
    const dedupeId = body.id != null ? 'id-' + body.id : referenceCode;
    const fresh = await kvSetNX('topup:direct:' + dedupeId, JSON.stringify(record));
    if (!fresh) return ack(); // đã xử lý rồi

    await kvIncrBy('wallet:' + username, amount);
    await pushList('topups:' + username, { at, amount, source: 'direct', ref: referenceCode });
    if (body.id !== undefined && body.id !== null) {
      await kvSet('processed:sepay:' + String(body.id), '1');
    }
    return ack();
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ success: false, message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('sepay-webhook error:', e);
    return res.status(500).json({ success: false, message: 'Lỗi server khi xử lý webhook' });
  }
}

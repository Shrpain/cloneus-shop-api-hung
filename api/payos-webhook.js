// POST /api/payos-webhook — webhook payOS khi khách thanh toán xong qua link.
// Body: {code, desc, success, data:{...}, signature}.
// Luôn trả 200 {success:true} khi đã nhận (kể cả khi không cộng tiền) để payOS
// không retry vô ích; chỉ trả 400 khi sai chữ ký, 503/500 khi lỗi xác thực cấu hình/KV.
import { jsonBody, isKvNotConfigured, pushList } from './_lib/common.js';
import { kvGet, kvSet, kvSetNX, kvIncrBy } from './_lib/kv.js';
import { verifyWebhookData } from './_lib/payos.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Chỉ chấp nhận POST' });
  }
  let body;
  try {
    body = jsonBody(req);
  } catch {
    return res.status(400).json({ success: false, message: 'Dữ liệu gửi lên không hợp lệ' });
  }
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY;
  if (!checksumKey) {
    return res.status(503).json({ success: false, message: 'Chưa cấu hình PAYOS_CHECKSUM_KEY trên server' });
  }
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  if (!verifyWebhookData(data, body.signature, checksumKey)) {
    return res.status(400).json({ success: false, message: 'Chữ ký webhook không hợp lệ' });
  }
  const ack = () => res.status(200).json({ success: true });

  // Chỉ xử lý giao dịch thành công (cả mã ngoài và mã trong data đều '00').
  if (body.code !== '00' || data.code !== '00') return ack();

  try {
    const raw = await kvGet('topup:' + String(data.orderCode));
    if (!raw) return ack(); // không tìm thấy giao dịch: đã nhận nhưng không cộng tiền
    let topup;
    try {
      topup = JSON.parse(raw);
    } catch {
      console.error('payos-webhook: topup JSON hỏng, orderCode=', data.orderCode);
      return ack();
    }
    if (Number(data.amount) !== Number(topup.amount)) return ack(); // sai số tiền: không cộng
    if (topup.status === 'paid') return ack(); // idempotent: đã cộng rồi

    // Chống trùng theo paymentLinkId (webhook payOS có thể gửi lại).
    if (data.paymentLinkId) {
      const fresh = await kvSetNX('processed:payos:' + data.paymentLinkId, '1');
      if (!fresh) return ack();
    }

    await kvIncrBy('wallet:' + topup.username, Number(topup.amount));
    const paidAt = new Date().toISOString();
    const paid = {
      ...topup,
      status: 'paid',
      paidAt,
      reference: data.reference || data.paymentLinkId || null,
    };
    await kvSet('topup:' + String(data.orderCode), JSON.stringify(paid));
    await pushList('topups:' + topup.username, {
      at: paidAt,
      amount: Number(topup.amount),
      source: 'payos',
      ref: String(data.orderCode),
    });
    return ack();
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ success: false, message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('payos-webhook error:', e);
    return res.status(500).json({ success: false, message: 'Lỗi server khi xử lý webhook' });
  }
}

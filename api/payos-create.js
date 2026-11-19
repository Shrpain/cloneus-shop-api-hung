// POST /api/payos-create {username, amount}
// Tạo link thanh toán payOS để nạp ví. Lưu giao dịch pending vào KV TRƯỚC
// khi gọi payOS; payOS lỗi thì trả lỗi, không tạo link giả.
import { validUsername, jsonBody, newOrderCode, isKvNotConfigured } from './_lib/common.js';
import { kvSet } from './_lib/kv.js';
import { createPaymentLink } from './_lib/payos.js';

const TOPUP_URL = 'https://cloneus-shop-api-hung-ds-projects-e52d8efd.vercel.app/topup.html';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Chỉ chấp nhận POST' });
  }
  let body;
  try {
    body = jsonBody(req);
  } catch {
    return res.status(400).json({ status: 'error', message: 'Dữ liệu gửi lên không hợp lệ' });
  }
  const username = String(body.username || '').trim();
  const amount = Number(body.amount);
  if (!validUsername(username)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tên tài khoản không hợp lệ (3-32 ký tự, chỉ gồm chữ, số và dấu gạch dưới)',
    });
  }
  if (!Number.isInteger(amount) || amount < 1000 || amount > 50000000) {
    return res.status(400).json({
      status: 'error',
      message: 'Số tiền nạp phải là số nguyên từ 1.000đ đến 50.000.000đ',
    });
  }
  const clientId = process.env.PAYOS_CLIENT_ID;
  const apiKey = process.env.PAYOS_API_KEY;
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY;
  if (!clientId || !apiKey || !checksumKey) {
    return res.status(500).json({ status: 'error', message: 'Chưa cấu hình payOS trên server' });
  }

  const orderCode = newOrderCode();
  const description = `NAP ${orderCode}`;
  const cancelUrl = TOPUP_URL;
  const returnUrl = `${TOPUP_URL}?topup=${orderCode}`;
  const record = {
    username,
    amount,
    status: 'pending',
    paymentLinkId: null,
    description,
    createdAt: new Date().toISOString(),
  };

  // Lưu pending TRƯỚC khi gọi payOS để webhook về sau luôn tìm thấy giao dịch.
  try {
    await kvSet('topup:' + orderCode, JSON.stringify(record));
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ status: 'error', message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('payos-create KV error:', e);
    return res.status(500).json({ status: 'error', message: 'Lỗi database, vui lòng thử lại sau' });
  }

  let data;
  try {
    data = await createPaymentLink(
      { amount, cancelUrl, description, orderCode, returnUrl },
      { clientId, apiKey, checksumKey },
    );
  } catch (e) {
    console.error('payos-create error:', e);
    return res.status(502).json({
      status: 'error',
      message: 'Không tạo được link thanh toán: ' + (e && e.message ? e.message : 'lỗi payOS'),
    });
  }

  // Ghi paymentLinkId vào giao dịch (best-effort, không làm hỏng response).
  try {
    await kvSet('topup:' + orderCode, JSON.stringify({ ...record, paymentLinkId: data.paymentLinkId }));
  } catch (e) {
    console.error('payos-create: không ghi được paymentLinkId:', e);
  }

  return res.status(200).json({
    status: 'success',
    orderCode,
    amount,
    description,
    qrCode: data.qrCode,
    checkoutUrl: data.checkoutUrl || 'https://pay.payos.vn/web/' + data.paymentLinkId,
    paymentLinkId: data.paymentLinkId,
    accountNumber: data.accountNumber,
    accountName: data.accountName,
  });
}

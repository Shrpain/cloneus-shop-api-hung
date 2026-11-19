// GET /api/order-status?orderCode=... — tra 1 giao dịch nạp hoặc 1 đơn mua.
// GET /api/order-status?username=... — tổng quan khách: số dư, mã nạp,
// các đơn mua và các lần nạp gần nhất.
import { validUsername, getBalance, isKvNotConfigured } from './_lib/common.js';
import { kvGet } from './_lib/kv.js';
import { getTopupCode } from './_lib/topupcode.js';

async function readJson(key) {
  const raw = await kvGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const orderCode = String(req.query.orderCode || '').trim();
  const username = String(req.query.username || '').trim();

  try {
    if (orderCode) {
      // Tra topup trước, rồi tới order.
      const topup = await readJson('topup:' + orderCode);
      if (topup) {
        return res.status(200).json({
          type: 'topup',
          status: topup.status,
          amount: topup.amount,
          username: topup.username,
        });
      }
      const order = await readJson('order:' + orderCode);
      if (order) {
        const out = {
          type: 'order',
          status: order.status,
          productName: order.productName,
          amount: order.amount,
          username: order.username,
        };
        if (order.status === 'delivered' && order.account) out.account = order.account;
        if (order.transId) out.transId = order.transId;
        return res.status(200).json(out);
      }
      return res.status(404).json({
        status: 'error',
        message: 'Không tìm thấy đơn hàng hoặc giao dịch nạp tiền với mã này',
      });
    }

    if (username) {
      if (!validUsername(username)) {
        return res.status(400).json({
          status: 'error',
          message: 'Tên tài khoản không hợp lệ (3-32 ký tự, chỉ gồm chữ, số và dấu gạch dưới)',
        });
      }
      const balance = await getBalance(username);
      const topupCode = await getTopupCode(username);

      const orderCodes = (await readJson('orders:' + username)) || [];
      const orders = [];
      for (const code of (Array.isArray(orderCodes) ? orderCodes : []).slice(0, 50)) {
        const o = await readJson('order:' + code);
        if (!o) continue;
        const item = {
          orderCode: code,
          productId: o.productId,
          productName: o.productName,
          amount: o.amount,
          status: o.status,
          createdAt: o.createdAt,
        };
        if (o.deliveredAt) item.deliveredAt = o.deliveredAt;
        if (o.status === 'delivered' && o.account) item.account = o.account;
        if (o.transId) item.transId = o.transId;
        if (o.error) item.error = o.error;
        orders.push(item);
      }

      const topups = (await readJson('topups:' + username)) || [];
      return res.status(200).json({
        status: 'success',
        username,
        balance,
        topupCode,
        orders,
        topups: Array.isArray(topups) ? topups : [],
      });
    }

    return res.status(400).json({ status: 'error', message: 'Thiếu tham số orderCode hoặc username' });
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ status: 'error', message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('order-status error:', e);
    return res.status(500).json({ status: 'error', message: 'Không tra được trạng thái, vui lòng thử lại sau' });
  }
}

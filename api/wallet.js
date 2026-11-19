// GET /api/wallet?username=... — số dư ví của khách (0 nếu chưa có ví).
import { validUsername, getBalance, isKvNotConfigured } from './_lib/common.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const username = String(req.query.username || '').trim();
  if (!validUsername(username)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tên tài khoản không hợp lệ (3-32 ký tự, chỉ gồm chữ, số và dấu gạch dưới)',
    });
  }
  try {
    const balance = await getBalance(username);
    return res.status(200).json({ status: 'success', username, balance });
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ status: 'error', message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('wallet error:', e);
    return res.status(500).json({ status: 'error', message: 'Không đọc được số dư ví, vui lòng thử lại sau' });
  }
}

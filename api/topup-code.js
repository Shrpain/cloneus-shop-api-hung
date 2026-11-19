// GET /api/topup-code?username=... và POST /api/topup-code {username}
// Trả mã nạp cố định của khách (dùng làm nội dung chuyển khoản). Idempotent:
// gọi lại nhiều lần trả đúng mã cũ.
import { validUsername, jsonBody, isKvNotConfigured } from './_lib/common.js';
import { getTopupCode } from './_lib/topupcode.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  let username;
  try {
    if (req.method === 'GET') {
      username = String(req.query.username || '').trim();
    } else {
      username = String((jsonBody(req).username) || '').trim();
    }
  } catch {
    return res.status(400).json({ status: 'error', message: 'Dữ liệu gửi lên không hợp lệ' });
  }
  if (!validUsername(username)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tên tài khoản không hợp lệ (3-32 ký tự, chỉ gồm chữ, số và dấu gạch dưới)',
    });
  }
  try {
    const code = await getTopupCode(username);
    return res.status(200).json({ status: 'success', username, code });
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ status: 'error', message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('topup-code error:', e);
    return res.status(500).json({ status: 'error', message: 'Không tạo được mã nạp, vui lòng thử lại sau' });
  }
}

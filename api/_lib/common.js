// api/_lib/common.js — validate, đọc body, mã đơn, giá bán và tiện ích KV dùng chung.
import { kvGet, kvSet } from './kv.js';

export function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(u);
}

// Vercel đã parse JSON sẵn thì dùng req.body; nếu là string thì JSON.parse.
// Trả {} khi không có body. Throw khi string không phải JSON hợp lệ.
export function jsonBody(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b === 'string') {
    if (!b.trim()) return {};
    return JSON.parse(b);
  }
  if (typeof b === 'object') return b;
  return {};
}

// Mã đơn duy nhất: mili-giây * 1000 + số ngẫu nhiên 0-999, số nguyên < 2^53.
export function newOrderCode() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// Giá bán server-side — KHÔNG bao giờ tin số tiền client gửi.
export const SELL_PRICES = { 8: 9999, 16: 129000 };
export const PRODUCT_NAMES = { 8: 'Muse AI 1 ty token', 16: 'Muse AI 30 ty token' };

export function isKvNotConfigured(e) {
  return !!e && e.message === 'KV_NOT_CONFIGURED';
}

// Trả response lỗi KV chuẩn: thiếu env -> 503, lỗi khác -> 500. Trả true khi đã xử lý.
export function kvErrorResponse(res, e) {
  if (isKvNotConfigured(e)) {
    return res.status(503).json({ status: 'error', message: 'Chưa cấu hình KV (database) trên server' });
  }
  console.error('KV error:', e);
  return res.status(500).json({ status: 'error', message: 'Lỗi database, vui lòng thử lại sau' });
}

// Số dư ví (VND, số nguyên), 0 nếu chưa có ví.
export async function getBalance(username) {
  const raw = await kvGet('wallet:' + username);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// Thêm 1 mục vào đầu danh sách JSON trong KV (orders:<user> / topups:<user>),
// giữ tối đa `max` mục (mặc định 50).
export async function pushList(key, item, max = 50) {
  let arr = [];
  try {
    const raw = await kvGet(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    }
  } catch {
    arr = [];
  }
  arr.unshift(item);
  await kvSet(key, JSON.stringify(arr.slice(0, max)));
  return arr;
}

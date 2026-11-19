// api/_lib/topupcode.js — nội dung chuyển khoản thống nhất của từng khách
// (dùng để Sepay webhook đối soát). Dạng SUIEU + username viết hoa,
// tối đa 22 ký tự, chỉ gồm A-Z0-9. Mã CLONEUS cũ vẫn được giữ để đối
// soát các giao dịch đã chuyển trước đây.
import crypto from 'node:crypto';
import { kvGet, kvSet, kvSetNX } from './kv.js';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CHARS[crypto.randomInt(0, CHARS.length)];
  return s;
}

export function normalizeUsername(u) {
  return String(u || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function deriveCode(username) {
  const norm = normalizeUsername(username);
  if (!norm) return 'SUIEU' + randomCode(8);
  return ('SUIEU' + norm).slice(0, 22);
}

// Tạo và lưu mapping code -> username (idempotent: cùng username gọi lại
// trả đúng mã cũ). Nếu mã đã thuộc về username khác thì thử biến thể
// base.slice(0, 20) + 2 ký tự ngẫu nhiên, tối đa 5 lần.
export async function assignTopupCode(username) {
  const base = deriveCode(username);
  let code = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await kvGet('code:' + code);
    if (existing === null) {
      const ok = await kvSetNX('code:' + code, username);
      if (ok) {
        await kvSet('usercode:' + username, code);
        return code;
      }
      // Race: có người khác vừa chiếm mã này, đọc lại ở vòng sau.
      continue;
    }
    if (existing === username) {
      await kvSet('usercode:' + username, code);
      return code;
    }
    code = base.slice(0, 20) + randomCode(2);
  }
  throw new Error('Không tạo được mã nạp, vui lòng thử lại');
}

// Lấy mã nạp của khách, tạo mới nếu chưa có. Mã CLONEUS cũ được chuyển
// sang mã SUIEU (mapping cũ vẫn giữ để webhook đối soát giao dịch cũ).
export async function getTopupCode(username) {
  const existing = await kvGet('usercode:' + username);
  if (existing && existing.indexOf('CLONEUS') !== 0) return existing;
  return assignTopupCode(username);
}

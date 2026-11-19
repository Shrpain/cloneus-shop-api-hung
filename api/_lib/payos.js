// api/_lib/payos.js — ký / xác thực payOS bằng Node crypto, không cài thêm package.
import crypto from 'node:crypto';

// Chuỗi ký tạo payment link, đúng thứ tự payOS yêu cầu:
// amount, cancelUrl, description, orderCode, returnUrl.
export function signPaymentRequest({ amount, cancelUrl, description, orderCode, returnUrl }, checksumKey) {
  const raw = `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
  return crypto.createHmac('sha256', checksumKey).update(raw).digest('hex');
}

// Sắp xếp key đệ quy (cho object lồng nhau / phần tử mảng) trước khi stringify.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// Giá trị 1 trường trong data webhook: null/undefined/'null'/'undefined' -> '',
// object/mảng -> JSON.stringify (mảng: stringify từng phần tử đã sort key),
// còn lại -> String(value).
function webhookValue(v) {
  if (v === undefined || v === null || v === 'null' || v === 'undefined') return '';
  if (Array.isArray(v)) return JSON.stringify(sortDeep(v));
  if (typeof v === 'object') return JSON.stringify(sortDeep(v));
  return String(v);
}

// Xác thực chữ ký webhook payOS: sort key theo alphabet (JS .sort() mặc định),
// bỏ key có value undefined, nối `key=value` bằng &, HMAC-SHA256 hex,
// so sánh bằng crypto.timingSafeEqual. Trả true/false, không throw.
export function verifyWebhookData(data, signature, checksumKey) {
  if (!data || typeof data !== 'object' || !signature || !checksumKey) return false;
  const keys = Object.keys(data)
    .filter((k) => data[k] !== undefined)
    .sort();
  const raw = keys.map((k) => `${k}=${webhookValue(data[k])}`).join('&');
  const expected = crypto.createHmac('sha256', checksumKey).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Tạo payment link payOS. Trả `data` khi code === '00', ngược lại throw Error
// với message của payOS (endpoint gọi hàm này phải trả lỗi, không tạo link giả).
export async function createPaymentLink(
  { amount, cancelUrl, description, orderCode, returnUrl },
  { clientId, apiKey, checksumKey },
) {
  const signature = signPaymentRequest(
    { amount, cancelUrl, description, orderCode, returnUrl },
    checksumKey,
  );
  const expiredAt = Math.floor(Date.now() / 1000) + 15 * 60; // hết hạn sau 15 phút
  const res = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
    method: 'POST',
    headers: {
      'x-client-id': clientId,
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ orderCode, amount, description, cancelUrl, returnUrl, expiredAt, signature }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('payOS trả về dữ liệu không hợp lệ');
  }
  if (!data || data.code !== '00' || !data.data) {
    throw new Error(String((data && (data.desc || data.message)) || 'Tạo link thanh toán payOS thất bại'));
  }
  return data.data;
}

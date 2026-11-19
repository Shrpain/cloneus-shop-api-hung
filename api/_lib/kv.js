// api/_lib/kv.js — client Upstash Redis qua REST API (Vercel KV).
// Dùng fetch thuần, không cài thêm package. Mọi hàm throw Error('KV_NOT_CONFIGURED')
// khi thiếu KV_REST_API_URL hoặc KV_REST_API_TOKEN để endpoint trả 503 rõ ràng.
function kvConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV_NOT_CONFIGURED');
  return { url: String(url).replace(/\/$/, ''), token };
}

async function kvRequest(path) {
  const { url, token } = kvConfig();
  const res = await fetch(url + path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('KV_BAD_RESPONSE');
  }
  if (!res.ok) throw new Error('KV_ERROR: ' + (data.error || res.status));
  return data.result;
}

// GET /get/<key> -> string | null (key chưa có trả null).
export async function kvGet(key) {
  const r = await kvRequest(`/get/${encodeURIComponent(key)}`);
  return r === null || r === undefined ? null : String(r);
}

// GET /set/<key>/<value> -> true khi Upstash trả "OK".
export async function kvSet(key, value, opts = {}) {
  let path = `/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`;
  if (opts.ex) path += `?ex=${encodeURIComponent(String(opts.ex))}`;
  const r = await kvRequest(path);
  return r === 'OK';
}

// GET /setnx/<key>/<value> -> true chỉ khi key chưa tồn tại (tạo mới thành công).
export async function kvSetNX(key, value) {
  const r = await kvRequest(`/setnx/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`);
  return r === 1 || r === '1' || r === true;
}

// GET /incrby/<key>/<delta> -> số nguyên mới sau khi cộng (delta có thể âm).
export async function kvIncrBy(key, delta) {
  const r = await kvRequest(`/incrby/${encodeURIComponent(key)}/${encodeURIComponent(String(delta))}`);
  const n = Number(r);
  if (!Number.isFinite(n)) throw new Error('KV_BAD_RESPONSE');
  return n;
}

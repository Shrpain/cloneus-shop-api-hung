// POST /api/login — đăng nhập CloneUS ngay trên shop, về trang tài khoản của shop.
// Luồng giống api/register.js: GET trang login lấy csrf_token, POST AJAX auth.php
// như nút #btnLoginPage của CloneUS ({action:'Login', csrf_token, username, password}).
// CloneUS trả JSON {status, msg}; status 'success' thì đăng nhập OK, 'verify' thì
// tài khoản cần xác minh thêm, còn lại là sai tài khoản/mật khẩu.
// Mật khẩu KHÔNG được ghi log, không lưu ở đâu, không trả về frontend.
// Trả JSON {status:'success', username} hoặc {status:'error', message}.

const LOGIN_URL = 'https://cloneus.net/client/login';
const AUTH_AJAX_URL = 'https://cloneus.net/ajaxs/client/auth.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function baseHeaders() {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  };
}

function collectCookies(res, jar) {
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie();
  } else {
    const h = res.headers.get('set-cookie');
    if (h) raw = [h];
  }
  for (const c of raw) {
    const pair = String(c).split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

// Fetch có theo dõi redirect thủ công, giữ nguyên cookie của phiên.
async function fetchSession(url, options, jar, maxRedirects = 5) {
  let currentUrl = url;
  let opts = { ...(options || {}) };
  for (let i = 0; i <= maxRedirects; i++) {
    const headers = { ...(opts.headers || {}) };
    const ck = cookieHeader(jar);
    if (ck) headers.Cookie = ck;
    const res = await fetch(currentUrl, {
      ...opts,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    collectCookies(res, jar);
    const loc = res.headers.get('location');
    const status = res.status;
    if (status >= 300 && status < 400 && loc) {
      const next = new URL(loc, currentUrl).toString();
      const method = String(opts.method || 'GET').toUpperCase();
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        opts = { method: 'GET', headers: opts.headers };
      }
      currentUrl = next;
      continue;
    }
    return { res, url: currentUrl };
  }
  throw new Error('Quá nhiều lần chuyển hướng');
}

// Trích csrf_token trong HTML trang login (hidden input chỉ có id="csrf_token",
// không có name — phải khớp theo id trước, giống api/register.js).
function extractCsrfToken(html) {
  let m = html.match(/<input[^>]*\bname=["']csrf_token["'][^>]*\bvalue=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']csrf_token["']/i);
  if (m) return m[1];
  m = html.match(/<input[^>]*\bid=["']csrf_token["'][^>]*\bvalue=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bid=["']csrf_token["']/i);
  if (m) return m[1];
  m = html.match(/csrf_token["']?\s*[:=]\s*["']([^"'\s;]+)["']/i);
  if (m) return m[1];
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Chỉ chấp nhận POST' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ status: 'error', message: 'Dữ liệu gửi lên không hợp lệ.' });
    }
  }
  body = body && typeof body === 'object' ? body : {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Vui lòng nhập tên tài khoản và mật khẩu.' });
  }

  try {
    const jar = new Map();

    // Bước 1: mở trang đăng nhập, lấy csrf_token trong lúc chạy.
    const { res: loginRes } = await fetchSession(
      LOGIN_URL,
      { method: 'GET', headers: baseHeaders() },
      jar,
    );
    const loginHtml = await loginRes.text();
    const csrfToken = extractCsrfToken(loginHtml);
    if (!csrfToken) {
      return res.status(502).json({
        status: 'error',
        message: 'Không đọc được trang đăng nhập trên CloneUS lúc này. Vui lòng thử lại sau.',
      });
    }

    // Bước 2: gửi đúng AJAX như nút #btnLoginPage của CloneUS.
    const params = new URLSearchParams();
    params.append('action', 'Login');
    params.append('csrf_token', csrfToken);
    params.append('username', username);
    params.append('password', password);
    const { res: ajaxRes } = await fetchSession(
      AUTH_AJAX_URL,
      {
        method: 'POST',
        headers: {
          ...baseHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: LOGIN_URL,
        },
        body: params,
      },
      jar,
    );
    const ajaxText = await ajaxRes.text();
    let data = null;
    try {
      data = JSON.parse(ajaxText);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object') {
      return res.status(502).json({
        status: 'error',
        message: 'CloneUS trả về dữ liệu không nhận diện được. Vui lòng thử lại sau.',
      });
    }

    const msg = String(data.msg || data.message || '');
    if (data.status === 'success') {
      return res.status(200).json({ status: 'success', username });
    }
    if (data.status === 'verify') {
      return res.status(403).json({
        status: 'error',
        message:
          msg ||
          'Tài khoản cần xác minh thêm trên CloneUS. Vui lòng đăng nhập trực tiếp trên CloneUS để xác minh.',
      });
    }
    return res.status(401).json({
      status: 'error',
      message: msg || 'Tên tài khoản hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.',
    });
  } catch (e) {
    return res.status(502).json({
      status: 'error',
      message: 'Không kết nối được tới CloneUS lúc này. Vui lòng thử lại sau.',
    });
  }
}

// POST /api/register — đăng ký tài khoản CloneUS tự động dưới ref 1267.
// API CloneUS không có endpoint đăng ký, nên proxy này làm việc với form web:
//  1. Mở https://cloneus.net/?aff=1267 để phiên nhận ref (cookie/session).
//  2. Đọc form đăng ký tại /client/register TRONG LÚC CHẠY: lấy action, method
//     và toàn bộ <input> (name, type, value). KHÔNG hard-code tên trường POST
//     của CloneUS — trường hiển thị chỉ được nhận diện bằng từ khóa gợi ý
//     (xem HINTS bên dưới); tên trường thật luôn lấy từ thuộc tính name của
//     từng <input> trong form.
//  3. POST form dạng url-encoded kèm cookie của phiên và Referer, theo dõi
//     redirect thủ công và thu thập cookie mới.
//  4. Xác định thành công/thất bại từ nội dung trả về; nếu thành công thì thử
//     lấy tên tài khoản hiển thị trên trang chủ (best-effort, không bịa số dư).
// Trả JSON {status, message, username} (+ balance chỉ khi trích được).
// Mật khẩu KHÔNG được ghi log, không lưu ở đâu, không trả về frontend.

const AFF_URL = 'https://cloneus.net/?aff=1267';
const REGISTER_URL = 'https://cloneus.net/client/register';
const HOME_URL = 'https://cloneus.net/';
const DIRECT_REGISTER_URL = 'https://cloneus.net/client/register?aff=1267';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Từ khóa gợi ý CHỈ dùng để nhận diện trường trong form đã parse lúc chạy.
// Đây không phải tên trường POST cố định của CloneUS.
const HINTS = {
  email: ['email', 'mail'],
  password: ['password', 'pass', 'pwd', 'mật khẩu', 'mat_khau'],
  username: ['username', 'user', 'tài khoản', 'tai_khoan', 'ten_dang_nhap', 'tên đăng nhập', 'account', 'login'],
  confirm: ['confirm', 'confirmation', 'repeat', 'retype', 'again', 'nhập lại', 'xác nhận'],
};

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
      // 307/308: giữ nguyên method và body.
      currentUrl = next;
      continue;
    }
    return { res, url: currentUrl };
  }
  throw new Error('Quá nhiều lần chuyển hướng');
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(tag))) {
    const key = m[1].toLowerCase();
    attrs[key] =
      m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

function parseForms(html) {
  const forms = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let fm;
  while ((fm = formRe.exec(html))) {
    const fAttrs = parseAttrs(fm[1]);
    const inner = fm[2];
    const labels = new Map();
    const labelRe = /<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi;
    let lm;
    while ((lm = labelRe.exec(inner))) {
      const lAttrs = parseAttrs(lm[1]);
      if (lAttrs.for) labels.set(lAttrs.for, lm[2].replace(/<[^>]+>/g, ' ').trim());
    }
    const inputs = [];
    const inputRe = /<input\b([^>]*)\/?>/gi;
    let im;
    while ((im = inputRe.exec(inner))) {
      const a = parseAttrs(im[1]);
      if (!a.name) continue;
      inputs.push({
        name: a.name,
        type: (a.type || 'text').toLowerCase(),
        value: a.value || '',
        id: a.id || '',
        placeholder: a.placeholder || '',
      });
    }
    forms.push({
      action: fAttrs.action || '',
      method: (fAttrs.method || 'get').toLowerCase(),
      inputs,
      labels,
    });
  }
  return forms;
}

function haystack(inp, labels) {
  return [inp.name, inp.id, inp.placeholder, labels.get(inp.id) || '']
    .join(' ')
    .toLowerCase();
}

function hasHint(text, hints) {
  return hints.some((h) => text.includes(h));
}

// Fallback: một số trang không dùng thẻ <form> mà chỉ có các <input> rồi gửi
// bằng JavaScript. Khi đó gom mọi <input> trên toàn trang thành một form ảo
// POST về chính URL trang đăng ký.
function parseInputsPageWide(html) {
  const inputs = [];
  const inputRe = /<input\b([^>]*)\/?>/gi;
  let im;
  while ((im = inputRe.exec(html))) {
    const a = parseAttrs(im[1]);
    if (!a.name) continue;
    inputs.push({
      name: a.name,
      type: (a.type || 'text').toLowerCase(),
      value: a.value || '',
      id: a.id || '',
      placeholder: a.placeholder || '',
    });
  }
  return inputs;
}

// Tìm đoạn code xử lý đăng ký trong các thẻ <script> nội tuyến và trong file
// main.js của trang (tải bằng fetch phía server). Chỉ dùng khi form thường
// đọc không ra, để chẩn đoán endpoint AJAX thật.
// Endpoint đăng ký AJAX thật của CloneUS (tìm được trong script nội tuyến của
// trang đăng ký — form không có thẻ <form>, nút #btnRegister gửi bằng jQuery):
// POST https://cloneus.net/ajaxs/client/auth.php
// data: { action: 'Register', csrf_token, username, email, password, repassword }
// Trả JSON { status: 'success'|'error', msg }.
const AUTH_AJAX_URL = 'https://cloneus.net/ajaxs/client/auth.php';

// Trích csrf_token trong HTML trang đăng ký (hidden input hoặc biến JS).
// Lưu ý: input ẩn của CloneUS chỉ có id="csrf_token" mà KHÔNG có name,
// nên phải khớp theo id chứ không chỉ theo name.
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
  m = html.match(/<meta[^>]*\bname=["']csrf-token["'][^>]*\bcontent=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
}

// Đoạn ngữ cảnh quanh "csrf_token" để chẩn đoán khi trích token thất bại.
function findCsrfContexts(html) {
  const out = [];
  const low = html.toLowerCase();
  let idx = low.indexOf('csrf_token');
  let guard = 0;
  while (idx >= 0 && guard < 3) {
    out.push(html.slice(Math.max(0, idx - 120), idx + 180));
    idx = low.indexOf('csrf_token', idx + 10);
    guard++;
  }
  return out;
}

function findRegisterSnippets(html) {
  const out = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  // Lấy toàn bộ handler của nút #btnRegister (chứa cả đoạn $.ajax gửi đăng ký).
  while ((m = scriptRe.exec(html))) {
    const code = m[1];
    if (!code) continue;
    const bi = code.indexOf('btnRegister');
    if (bi >= 0) out.push(code.slice(Math.max(0, bi - 200), bi + 3000));
  }
  // Dự phòng: các đoạn có chữ register trong script nội tuyến.
  if (!out.length) {
    const sRe2 = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m2;
    while ((m2 = sRe2.exec(html))) {
      const code = m2[1];
      if (!code || code.length < 20) continue;
      const low = code.toLowerCase();
      let idx = low.indexOf('register');
      let guard = 0;
      while (idx >= 0 && guard < 3) {
        out.push(code.slice(Math.max(0, idx - 250), idx + 450));
        idx = low.indexOf('register', idx + 8);
        guard++;
      }
    }
  }
  return out.slice(0, 4);
}

async function fetchMainJsSnippets(jar) {
  try {
    const { res } = await fetchSession(
      'https://cloneus.net/mod/js/main.js?v=2',
      { method: 'GET', headers: baseHeaders() },
      jar,
    );
    const js = await res.text();
    const low = js.toLowerCase();
    const snippets = [];
    let idx = low.indexOf('register');
    let guard = 0;
    while (idx >= 0 && guard < 3) {
      snippets.push(js.slice(Math.max(0, idx - 250), idx + 450));
      idx = low.indexOf('register', idx + 8);
      guard++;
    }
    return { length: js.length, httpStatus: res.status, snippets };
  } catch (e) {
    return { length: 0, httpStatus: 0, snippets: [], error: String((e && e.message) || e) };
  }
}

function pageDiagnostics(html, regRes, regUrl) {
  const snippet = stripTags(html).slice(0, 300);
  let aroundPassword = '';
  const pi = html.toLowerCase().indexOf('password');
  if (pi >= 0) aroundPassword = html.slice(Math.max(0, pi - 200), pi + 300);
  const scripts = [];
  const sRe = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let sm;
  while ((sm = sRe.exec(html)) && scripts.length < 10) scripts.push(sm[1]);
  return {
    httpStatus: regRes.status,
    contentType: regRes.headers.get('content-type') || '',
    htmlLength: html.length,
    finalUrl: regUrl,
    snippet,
    formCount: (html.match(/<form/gi) || []).length,
    inputCount: (html.match(/<input/gi) || []).length,
    hasPasswordInput: /type=["']password["']/i.test(html),
    hasFormTag: /<form/i.test(html),
    aroundPassword,
    scripts,
  };
}

// Chọn form đăng ký: form có nhiều trường mật khẩu/email nhất, ưu tiên form
// có action chứa "register".
function pickRegisterForm(forms) {
  let best = null;
  let bestScore = -1;
  for (const f of forms) {
    let score = 0;
    for (const inp of f.inputs) {
      if (inp.type === 'password') score += 2;
      if (inp.type === 'email') score += 1;
    }
    if (f.action.toLowerCase().includes('register')) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  if (!best || bestScore <= 0) return null;
  return best;
}

function mapFields(form) {
  const mapped = { username: null, email: null, password: null, confirm: null };
  const hidden = [];
  const submit = [];
  const passwordInputs = [];
  for (const inp of form.inputs) {
    if (inp.type === 'hidden') {
      hidden.push(inp);
      continue;
    }
    if (inp.type === 'submit' || inp.type === 'button' || inp.type === 'image') {
      submit.push(inp);
      continue;
    }
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'file') continue;
    const text = haystack(inp, form.labels);
    if (inp.type === 'email' || hasHint(text, HINTS.email)) {
      if (!mapped.email) mapped.email = inp;
      continue;
    }
    if (inp.type === 'password' || hasHint(text, HINTS.password)) {
      passwordInputs.push({ inp, text });
      continue;
    }
    if (hasHint(text, HINTS.username)) {
      if (!mapped.username) mapped.username = inp;
      continue;
    }
    if (!mapped.username && (inp.type === 'text' || inp.type === 'tel' || inp.type === '')) {
      mapped.username = inp;
    }
  }
  // Phân biệt mật khẩu và nhập lại: theo từ khóa gợi ý hoặc thứ tự xuất hiện.
  for (const { inp, text } of passwordInputs) {
    const isConfirm =
      hasHint(text, HINTS.confirm) || /(^|[\s_-])re([\s_-]|$)/.test(text);
    if (isConfirm && !mapped.confirm) mapped.confirm = inp;
    else if (!mapped.password) mapped.password = inp;
    else if (!mapped.confirm) mapped.confirm = inp;
  }
  return { mapped, hidden, submit };
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAlerts(html) {
  const msgs = [];
  const re =
    /<[^>]+class=["'][^"']*(alert|error|danger|invalid|toast|notify|message)[^"']*["'][^>]*>([\s\S]*?)<\/\w+>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = stripTags(m[2]);
    if (t && t.length > 2 && t.length < 400 && !msgs.includes(t)) msgs.push(t);
  }
  return msgs;
}

function analyzeResult(html, finalUrl) {
  const text = stripTags(html);
  const low = text.toLowerCase();
  const SUCCESS = [
    'đăng ký thành công',
    'tạo tài khoản thành công',
    'đăng ký tài khoản thành công',
    'tài khoản đã được tạo',
    'chúc mừng bạn đã đăng ký',
  ];
  if (SUCCESS.some((p) => low.includes(p))) {
    return {
      ok: true,
      message:
        'Đăng ký thành công! Tài khoản của bạn đã được tạo trên CloneUS dưới link giới thiệu ref 1267.',
    };
  }
  const alerts = extractAlerts(html).filter((a) => !/thành công/i.test(a));
  if (alerts.length) return { ok: false, message: alerts.join(' ') };
  const ERROR_PHRASES = [
    'đã tồn tại',
    'đã được sử dụng',
    'đã được đăng ký',
    'mật khẩu không khớp',
    'không khớp',
    'không hợp lệ',
    'vui lòng nhập',
    'thất bại',
    'đăng ký thất bại',
    'có lỗi xảy ra',
  ];
  if (ERROR_PHRASES.some((p) => low.includes(p))) {
    return {
      ok: false,
      message:
        'Đăng ký chưa thành công. Vui lòng kiểm tra lại thông tin (tên tài khoản hoặc email có thể đã được dùng) và thử lại.',
    };
  }
  let path = '';
  try {
    path = new URL(finalUrl).pathname;
  } catch {
    path = '';
  }
  if (path && !path.includes('register')) {
    return {
      ok: true,
      message:
        'Đăng ký thành công! Tài khoản của bạn đã được tạo trên CloneUS dưới link giới thiệu ref 1267.',
    };
  }
  if (/type=["']password["']/i.test(html)) {
    return {
      ok: false,
      message: 'Đăng ký chưa thành công. Vui lòng kiểm tra lại thông tin và thử lại.',
    };
  }
  return {
    ok: false,
    message: 'Không xác định được kết quả đăng ký. Vui lòng thử đăng ký trực tiếp trên CloneUS.',
  };
}

// Best-effort: kiểm tra tên tài khoản hiển thị trên trang chủ sau khi đăng ký.
async function fetchAccountInfo(jar, username) {
  try {
    const { res } = await fetchSession(HOME_URL, { method: 'GET', headers: baseHeaders() }, jar);
    const html = await res.text();
    const text = stripTags(html);
    if (!text.includes(username)) return null;
    let balance = null;
    const m = text.match(/số dư[^0-9]{0,60}(\d[\d.,]*)\s*đ/i);
    if (m) balance = m[1] + 'đ';
    return { balance };
  } catch {
    return null;
  }
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
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');

  if (!/^[A-Za-z0-9_]{3,}$/.test(username)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tên tài khoản phải có ít nhất 3 ký tự, chỉ gồm chữ, số và dấu gạch dưới.',
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: 'error', message: 'Địa chỉ email không đúng định dạng.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ status: 'error', message: 'Mật khẩu phải có ít nhất 6 ký tự.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ status: 'error', message: 'Mật khẩu nhập lại không khớp.' });
  }

  const fail = (message, status = 500) =>
    res.status(status).json({
      status: 'error',
      message,
      username,
      directUrl: DIRECT_REGISTER_URL,
    });

  try {
    const jar = new Map();

    // Bước 1: mở link giới thiệu để phiên nhận ref 1267.
    await fetchSession(AFF_URL, { method: 'GET', headers: baseHeaders() }, jar);

    // Bước 2: đọc form đăng ký trong lúc chạy.
    const { res: regRes, url: regUrl } = await fetchSession(
      REGISTER_URL,
      { method: 'GET', headers: baseHeaders() },
      jar,
    );
    const regHtml = await regRes.text();
    const csrfToken = extractCsrfToken(regHtml);
    if (csrfToken) {
      // Luồng chính: gửi đúng AJAX như nút #btnRegister của trang chính.
      const ajaxParams = new URLSearchParams();
      ajaxParams.append('action', 'Register');
      ajaxParams.append('csrf_token', csrfToken);
      ajaxParams.append('username', username);
      ajaxParams.append('email', email);
      ajaxParams.append('password', password);
      ajaxParams.append('repassword', confirmPassword);
      const ajaxRes = await fetchSession(
        AUTH_AJAX_URL,
        {
          method: 'POST',
          headers: {
            ...baseHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: regUrl,
          },
          body: ajaxParams,
        },
        jar,
      );
      const ajaxText = await ajaxRes.res.text();
      let ajaxData = null;
      try {
        ajaxData = JSON.parse(ajaxText);
      } catch {
        ajaxData = null;
      }
      if (ajaxData && typeof ajaxData === 'object') {
        const msg = String(ajaxData.msg || ajaxData.message || '');
        const ok = ajaxData.status === 'success' || ajaxData.success === true;
        if (ok) {
          const info = await fetchAccountInfo(jar, username);
          const out = {
            status: 'success',
            message:
              msg ||
              'Đăng ký thành công! Tài khoản của bạn đã được tạo trên CloneUS dưới link giới thiệu ref 1267.',
            username,
          };
          if (info && info.balance) out.balance = info.balance;
          return res.status(200).json(out);
        }
        return fail(msg || 'Đăng ký chưa thành công. Vui lòng kiểm tra lại thông tin và thử lại.');
      }
      // Trả về không phải JSON: rơi xuống luồng form-parse dự phòng bên dưới.
    }
    let form = pickRegisterForm(parseForms(regHtml));
    let usedPageWideFallback = false;
    if (!form) {
      // Fallback: trang không có thẻ <form> (gửi bằng JavaScript) — gom input toàn trang.
      const wideInputs = parseInputsPageWide(regHtml);
      const wideForm = { action: REGISTER_URL, method: 'post', inputs: wideInputs, labels: new Map() };
      const wideMapped = mapFields(wideForm);
      if (wideMapped.mapped.username && wideMapped.mapped.email && wideMapped.mapped.password && wideMapped.mapped.confirm) {
        form = wideForm;
        usedPageWideFallback = true;
      }
    }
    if (!form) {
      // Chẩn đoán tạm thời: trả kèm trạng thái và đoạn đầu của trang đã tải
      // để biết vì sao không thấy form (trang chặn bot, trang JS, lỗi...).
      // Đồng thời tìm đoạn code đăng ký trong script nội tuyến và main.js.
      const diag = pageDiagnostics(regHtml, regRes, regUrl);
      diag.inlineRegisterSnippets = findRegisterSnippets(regHtml);
      diag.mainJs = await fetchMainJsSnippets(jar);
      diag.csrfTokenFound = !!csrfToken;
      diag.csrfContexts = findCsrfContexts(regHtml);
      return res.status(502).json({
        status: 'error',
        message:
          'Không đọc được form đăng ký trên CloneUS lúc này. Vui lòng đăng ký trực tiếp tại ' +
          DIRECT_REGISTER_URL,
        username,
        directUrl: DIRECT_REGISTER_URL,
        debug: diag,
      });
    }
    const { mapped, hidden, submit } = mapFields(form);
    if (!mapped.username || !mapped.email || !mapped.password || !mapped.confirm) {
      return res.status(502).json({
        status: 'error',
        message:
          'Không nhận diện được đầy đủ các trường trong form đăng ký trên CloneUS. Vui lòng đăng ký trực tiếp tại ' +
          DIRECT_REGISTER_URL,
        username,
        directUrl: DIRECT_REGISTER_URL,
        debug: {
          ...pageDiagnostics(regHtml, regRes, regUrl),
          usedPageWideFallback,
          formAction: form.action,
          formInputs: form.inputs.map((i) => i.name + ':' + i.type),
        },
      });
    }

    // Bước 3: gửi form dạng url-encoded, tên trường lấy từ form đã parse.
    const params = new URLSearchParams();
    for (const inp of hidden) params.append(inp.name, inp.value);
    params.append(mapped.username.name, username);
    params.append(mapped.email.name, email);
    params.append(mapped.password.name, password);
    params.append(mapped.confirm.name, confirmPassword);
    for (const s of submit) params.append(s.name, s.value || '');

    const actionUrl = new URL(form.action || regUrl, regUrl).toString();
    let postRes;
    let finalUrl;
    if (form.method === 'get') {
      const u = new URL(actionUrl);
      for (const [k, v] of params) u.searchParams.append(k, v);
      ({ res: postRes, url: finalUrl } = await fetchSession(
        u.toString(),
        { method: 'GET', headers: { ...baseHeaders(), Referer: regUrl } },
        jar,
      ));
    } else {
      ({ res: postRes, url: finalUrl } = await fetchSession(
        actionUrl,
        {
          method: 'POST',
          headers: {
            ...baseHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: regUrl,
          },
          body: params,
        },
        jar,
      ));
    }

    const contentType = postRes.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      let data = null;
      try {
        data = JSON.parse(await postRes.text());
      } catch {
        data = null;
      }
      if (data && typeof data === 'object') {
        const msg = String(data.message || data.msg || '');
        const ok =
          data.status === 'success' || data.success === true || /thành công/i.test(msg);
        if (ok) {
          return res.status(200).json({
            status: 'success',
            message:
              msg ||
              'Đăng ký thành công! Tài khoản của bạn đã được tạo trên CloneUS dưới link giới thiệu ref 1267.',
            username,
          });
        }
        return fail(msg || 'Đăng ký chưa thành công. Vui lòng kiểm tra lại thông tin và thử lại.');
      }
    }

    // Bước 4: xác định kết quả từ nội dung HTML trả về.
    const resultHtml = await postRes.text();
    const result = analyzeResult(resultHtml, finalUrl);
    if (!result.ok) return fail(result.message);

    const info = await fetchAccountInfo(jar, username);
    const out = { status: 'success', message: result.message, username };
    if (info && info.balance) out.balance = info.balance;
    return res.status(200).json(out);
  } catch (e) {
    return fail(
      'Không kết nối được tới CloneUS lúc này. Vui lòng thử lại sau hoặc đăng ký trực tiếp tại ' +
        DIRECT_REGISTER_URL,
      502,
    );
  }
}

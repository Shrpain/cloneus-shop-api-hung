// GET /api/otp-services?type=mail|phone — danh sách dịch vụ thuê OTP.
// Gộp 2 endpoint cũ /api/mail-otp-services và /api/phone-otp-services thành 1
// function cho vừa giới hạn 12 function của Vercel Hobby. Đường dẫn cũ vẫn chạy
// nhờ rewrite trong vercel.json (mail -> ?type=mail, phone -> ?type=phone).
// mail:  GET https://cloneus.net/api/v1/mail-otp.php?action=services&api_key=KEY
// phone: GET https://cloneus.net/api/v1/otp.php?action=services&api_key=KEY
// Trả nguyên văn JSON của CloneUS (kể cả lỗi "Dịch vụ thuê OTP đang tạm đóng!").
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const type = req.query.type || '';
  const upstreamPath = type === 'mail' ? 'mail-otp.php' : type === 'phone' ? 'otp.php' : '';
  if (!upstreamPath) {
    return res.status(400).json({ status: 'error', message: 'Thiếu tham số type (mail hoặc phone)' });
  }
  const apiKey = process.env.CLONEUS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ status: 'error', message: 'Chưa cấu hình CLONEUS_API_KEY trên server' });
  }
  try {
    const url = `https://cloneus.net/api/v1/${upstreamPath}?action=services&api_key=${encodeURIComponent(apiKey)}`;
    const upstream = await fetch(url, { method: 'GET' });
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ status: 'error', message: 'CloneUS trả về dữ liệu không hợp lệ', detail: text.slice(0, 200) });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ status: 'error', message: 'Không gọi được API CloneUS: ' + (e && e.message ? e.message : 'unknown') });
  }
}

// GET /api/products — danh sách sản phẩm LIVE từ CloneUS
// Không bao giờ trả khóa API ra ngoài. Khóa chỉ đọc từ process.env.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }
  const apiKey = process.env.CLONEUS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ status: 'error', message: 'Chưa cấu hình CLONEUS_API_KEY trên server' });
  }
  try {
    const url = `https://cloneus.net/api/products.php?api_key=${encodeURIComponent(apiKey)}`;
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

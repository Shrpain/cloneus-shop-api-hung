// POST /api/buy-with-wallet {username, productId}
// Mua tài khoản Muse AI bằng số dư ví. Thứ tự bắt buộc:
//  1. kiểm tra kho live trên CloneUS (hết hàng -> 400, không trừ ví)
//  2. trừ ví (số dư < giá -> 400, không trừ; trừ xong mà âm thì hoàn lại)
//  3. lưu order status 'pending' vào KV
//  4. gọi CloneUS buy_product — thành công thì giao tài khoản, thất bại thì hoàn tiền.
// Giá lấy server-side từ SELL_PRICES, chỉ bán productId '8' và '16'.
import {
  validUsername,
  jsonBody,
  newOrderCode,
  SELL_PRICES,
  PRODUCT_NAMES,
  isKvNotConfigured,
  pushList,
} from './_lib/common.js';
import { kvGet, kvSet, kvIncrBy } from './_lib/kv.js';

async function checkStock(apiKey, productId) {
  const url = `https://cloneus.net/api/product.php?api_key=${encodeURIComponent(apiKey)}&product=${encodeURIComponent(productId)}`;
  const upstream = await fetch(url, { method: 'GET' });
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error('CloneUS trả về dữ liệu không hợp lệ');
    e.code = 'BAD_UPSTREAM';
    throw e;
  }
  if (!upstream.ok) {
    const e = new Error('Không gọi được API CloneUS');
    e.code = 'UPSTREAM_HTTP';
    throw e;
  }
  if (data && data.status && data.status !== 'success') {
    const e = new Error(String(data.msg || data.message || 'CloneUS báo lỗi khi kiểm tra kho'));
    e.code = 'UPSTREAM_ERROR';
    throw e;
  }
  const product = Array.isArray(data.product) ? data.product[0] : data.product;
  const amount = product ? Number(product.amount) : NaN;
  if (!Number.isFinite(amount)) {
    const e = new Error('CloneUS trả về dữ liệu kho không hợp lệ');
    e.code = 'BAD_UPSTREAM';
    throw e;
  }
  return amount;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Chỉ chấp nhận POST' });
  }
  let body;
  try {
    body = jsonBody(req);
  } catch {
    return res.status(400).json({ status: 'error', message: 'Dữ liệu gửi lên không hợp lệ' });
  }
  const username = String(body.username || '').trim();
  const productId = String(body.productId ?? '');
  if (!validUsername(username)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tên tài khoản không hợp lệ (3-32 ký tự, chỉ gồm chữ, số và dấu gạch dưới)',
    });
  }
  if (productId !== '8' && productId !== '16') {
    return res.status(400).json({ status: 'error', message: 'Sản phẩm không hợp lệ' });
  }
  const price = SELL_PRICES[productId];
  const productName = PRODUCT_NAMES[productId];

  const apiKey = process.env.CLONEUS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ status: 'error', message: 'Chưa cấu hình CLONEUS_API_KEY trên server' });
  }

  // 1. Kiểm tra kho live trước khi đụng tới ví.
  let stock;
  try {
    stock = await checkStock(apiKey, productId);
  } catch (e) {
    console.error('buy-with-wallet stock error:', e);
    return res.status(502).json({ status: 'error', message: e.message || 'Không kiểm tra được kho CloneUS' });
  }
  if (stock <= 0) {
    return res.status(400).json({ status: 'error', message: 'Sản phẩm đã hết hàng, vui lòng thử lại sau' });
  }

  // 2. Trừ ví + 3. lưu order pending. Lỗi ở bước lưu pending thì hoàn tiền ngay.
  const orderCode = newOrderCode();
  const order = {
    username,
    productId,
    productName,
    amount: price,
    status: 'pending',
    account: null,
    createdAt: new Date().toISOString(),
  };
  try {
    const balance = Number(await kvGet('wallet:' + username)) || 0;
    if (balance < price) {
      return res.status(400).json({ status: 'error', message: 'Số dư ví không đủ, vui lòng nạp tiền' });
    }
    const after = await kvIncrBy('wallet:' + username, -price);
    if (after < 0) {
      await kvIncrBy('wallet:' + username, price); // hoàn lại
      return res.status(400).json({ status: 'error', message: 'Số dư ví không đủ, vui lòng nạp tiền' });
    }
    try {
      await kvSet('order:' + orderCode, JSON.stringify(order));
    } catch (e) {
      await kvIncrBy('wallet:' + username, price); // hoàn tiền vì chưa lưu được order
      throw e;
    }
  } catch (e) {
    if (isKvNotConfigured(e)) {
      return res.status(503).json({ status: 'error', message: 'Chưa cấu hình KV (database) trên server' });
    }
    console.error('buy-with-wallet KV error:', e);
    return res.status(500).json({ status: 'error', message: 'Lỗi database, vui lòng thử lại sau' });
  }

  // 4. Gọi CloneUS buy_product (đúng định dạng .staging-buy/buy.js).
  const failOrder = async (errorMsg) => {
    try {
      await kvIncrBy('wallet:' + username, price); // hoàn tiền
    } catch (e) {
      console.error('buy-with-wallet: HOÀN TIỀN THẤT BẠI, orderCode=', orderCode, e);
    }
    try {
      await kvSet('order:' + orderCode, JSON.stringify({ ...order, status: 'failed', error: errorMsg }));
    } catch (e) {
      console.error('buy-with-wallet: không lưu được order failed, orderCode=', orderCode, e);
    }
  };

  let data;
  try {
    const form = new FormData();
    form.append('action', 'buyProduct');
    form.append('id', productId);
    form.append('amount', '1');
    form.append('api_key', apiKey);
    const upstream = await fetch('https://cloneus.net/api/buy_product', { method: 'POST', body: form });
    const text = await upstream.text();
    try {
      data = JSON.parse(text);
    } catch {
      await failOrder('CloneUS trả về dữ liệu không hợp lệ');
      return res.status(502).json({ status: 'error', message: 'CloneUS trả về dữ liệu không hợp lệ' });
    }
    if (!upstream.ok) {
      const msg = String((data && (data.msg || data.message)) || 'CloneUS báo lỗi khi mua hàng');
      await failOrder(msg);
      return res.status(502).json({ status: 'error', message: msg });
    }
  } catch (e) {
    console.error('buy-with-wallet CloneUS error:', e);
    await failOrder('Không gọi được API CloneUS');
    return res.status(502).json({ status: 'error', message: 'Không gọi được API CloneUS, tiền đã được hoàn lại ví' });
  }

  const ok = data && data.status === 'success' && Array.isArray(data.data);
  if (!ok) {
    const msg = String((data && (data.msg || data.message)) || 'CloneUS không trả về tài khoản');
    await failOrder(msg);
    return res.status(400).json({ status: 'error', message: msg });
  }

  const transId = data.trans_id || data.transId || null;
  const delivered = {
    ...order,
    status: 'delivered',
    account: data.data,
    transId,
    deliveredAt: new Date().toISOString(),
  };
  try {
    await kvSet('order:' + orderCode, JSON.stringify(delivered));
    await pushList('orders:' + username, orderCode);
  } catch (e) {
    // Tài khoản đã mua thành công từ CloneUS; chỉ lỗi ghi sổ phụ — vẫn trả
    // tài khoản cho khách, ghi log để đối soát tay.
    console.error('buy-with-wallet: đã giao nhưng không ghi được order vào KV, orderCode=', orderCode, e);
  }
  return res.status(200).json({
    status: 'success',
    orderCode,
    productId,
    productName,
    amount: price,
    account: data.data,
    transId,
  });
}

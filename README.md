# CloneUS Reseller Shop — Hưng

Shop bán tài khoản Muse AI: khách đăng ký, nạp tiền và mua hàng ngay trên
web của Hưng. Hưng nhập hàng qua API CloneUS bằng số dư của mình và giữ
phần chênh lệch (mô hình reseller, không phải affiliate).

## Giá bán (đã chốt)

| Sản phẩm | Giá vốn | Giá bán |
| --- | --- | --- |
| id 8 — 1 tỷ token | 4.999đ | 9.999đ |
| id 16 — 30 tỷ token | 90.000đ | 129.000đ |

Giá bán chỉ nằm ở server (`SELL_PRICES` trong `api/_lib/common.js`),
không bao giờ tin số tiền client gửi lên.

## Nạp tiền vào ví

- **Một mã QR chung** cho mọi tài khoản (VietQR KienLongBank) +
  **một nội dung chuyển khoản thống nhất: `SUIEU` + tên tài khoản**
  (ví dụ `SUIEUTESTREF1268`). Webhook tự cộng tiền vào ví khi nhận
  được giao dịch có nội dung khớp.
- Link thanh toán payOS là phương án phụ (nạp đúng một số tiền cụ thể).
- Lưu ý: tài khoản KienLongBank đang liên kết Sepay kiểu API (không SMS)
  nên Sepay chỉ nhận giao dịch qua tài khoản ảo VA, không nhận tiền
  chuyển thẳng vào tài khoản chính — xem thêm trong `topup.html` và
  webhook Sepay khi cấu hình.

## Luồng mua hàng

1. Khách đăng ký / đăng nhập ngay trên shop (`/api/register`, `/api/login`
   xác thực với CloneUS ở phía server, không chuyển hướng sang CloneUS).
2. Khách nạp tiền vào ví (xem trên).
3. Khách mua bằng số dư ví (`/api/buy-with-wallet`): shop gọi API CloneUS
   mua tài khoản bằng số dư của Hưng rồi giao tài khoản cho khách.
4. Số dư CloneUS của Hưng chỉ được dùng để giao đơn khách đã trả tiền.

## Trang và endpoint

- Trang: `index.html`, `topup.html`, `account.html`, `register.html`,
  `login.html`.
- API (11 function, giới hạn gói Vercel Hobby là 12):
  `products`, `otp-services` (`?type=mail|phone`), `register`, `login`,
  `wallet`, `topup-code`, `buy-with-wallet`, `order-status`,
  `payos-create`, `payos-webhook`, `sepay-webhook`.
  Endpoint mua trực tiếp `/api/buy` đã đóng (404).
- Dữ liệu ví/đơn/mã nạp lưu ở KV (Upstash Redis) qua `api/_lib/kv.js`.

## Deploy

```bash
python3 deploy.py
```

Deploy lên Vercel project `cloneus-shop-api-hung`. Payload JSON có giới
hạn 131.072 byte (giới hạn 1 argument của Linux) — mọi thay đổi phải cắt
gọn trước, nếu vượt deploy sẽ bị từ chối. `deploy.py` minify HTML/JS
lúc deploy, trừ `api/register.js` (không bao giờ minify, không sửa file này).

## Biến môi trường (chỉ tên, không ghi giá trị)

- `CLONEUS_API_KEY` — key API CloneUS (chỉ server dùng).
- `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` — payOS.
- `SEPAY_API_KEY` — xác thực webhook Sepay (`Authorization: Apikey ...`).
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Upstash KV.

Không bao giờ commit file `.env` hay bất kỳ key/mật khẩu/số tài khoản
thật nào vào repo. Xem `.env.example` và `.gitignore`.

## Quy tắc

- Không chuyển hướng người dùng sang trang CloneUS — mọi luồng
  (đăng ký, đăng nhập, nạp tiền, mua hàng, tài khoản) ở lại trên shop.
  Chỉ dùng API và tài nguyên (ảnh/icon) của CloneUS.
- Không dùng ảnh tạo bằng AI — chỉ dùng ảnh/icon CloneUS có sẵn.
- Không sửa `api/register.js`.

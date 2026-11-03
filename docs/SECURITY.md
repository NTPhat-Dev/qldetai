# Bảo mật bản demo QL Đề Tài

## Biện pháp hiện có

- Web mặc định chỉ gắn với `127.0.0.1:5173`. API, ba PostgreSQL và các endpoint nội bộ không xuất cổng ra máy chủ.
- Mỗi dịch vụ có cặp khóa RSA riêng. Identity ký token người dùng; các dịch vụ chỉ giữ public key của Identity để xác minh. Token gọi nội bộ có `service`, `purpose`, `audience` và hạn một phút. Không chia sẻ private key giữa các dịch vụ.
- Đăng nhập, xác minh MFA và kiểm tra mật khẩu hiện tại được giới hạn số lần thử trong cửa sổ năm phút. Bộ đếm nằm trong PostgreSQL Identity, nên tồn tại qua lần khởi động lại dịch vụ. Tài khoản chưa tồn tại vẫn được kiểm tra bằng một hash giả để giảm lộ thông tin qua thời gian phản hồi.
- Mật khẩu dùng Argon2id; TOTP được mã hóa AES-256-GCM; mã khôi phục chỉ dùng một lần. Khóa tài khoản, đổi hoặc đặt lại mật khẩu thu hồi token cũ.
- Nginx gửi CSP, chống nhúng trang, `nosniff`, giới hạn quyền trình duyệt và `no-store`. API không cấp CORS cho nguồn gốc khác. Container Node chạy không có quyền root, hệ thống tệp chỉ đọc và không có Linux capabilities.

## Truy cập từ điện thoại hoặc máy khác

Đăng nhập qua HTTP trên mạng LAN có thể làm lộ mật khẩu và token. Giữ `WEB_BIND=127.0.0.1` trong `.env` và đặt một reverse proxy HTTPS trên **cùng máy Ubuntu** để nhận kết nối từ xa. Ví dụ với Caddy đã cài trên Ubuntu và một tên miền trỏ tới máy ảo:

```caddyfile
demo.example.com {
    reverse_proxy 127.0.0.1:5173
}
```

Thay `demo.example.com` bằng tên miền thật. Đặt `WEBAUTHN_ORIGIN=https://demo.example.com` và `WEBAUTHN_RP_ID=demo.example.com` trong `.env`, rồi chạy lại `bash start-server.sh`. Nếu dùng VirtualBox NAT, chỉ chuyển tiếp cổng 80/443 của reverse proxy tới máy ảo; nếu dùng Bridged Adapter, mở 80/443 trên firewall của máy ảo. Chỉ cấp quyền cho mạng/người dùng cần demo. Không chuyển tiếp cổng 5173, 3100–3103 hoặc 5432. Caddy cần xác minh tên miền và đường tới các cổng thích hợp để lấy chứng chỉ công khai; xem [hướng dẫn HTTPS tự động](https://caddyserver.com/docs/automatic-https) và [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Nếu chưa có tên miền hoặc chứng chỉ được các máy khách tin cậy, chỉ dùng tại `http://localhost:5173` trên máy chạy ứng dụng hoặc thiết lập một đường hầm riêng có HTTPS. Passkey trên máy khách cần ngữ cảnh HTTPS hợp lệ. Đổi `WEB_BIND` sang `0.0.0.0` sẽ mở HTTP trực tiếp ra mạng và không phải cấu hình bảo mật tương đương.

## Passkey bằng điện thoại

Khi thêm Passkey, ứng dụng yêu cầu WebAuthn ưu tiên thiết bị từ xa (`hybrid`) và chỉ lưu đăng ký mà trình duyệt báo là từ thiết bị ngoài máy tính, hỗ trợ `hybrid`. Bật Bluetooth trên cả hai thiết bị, đặt gần nhau; trong hộp thoại của Chrome/Edge chọn điện thoại hoặc thiết bị khác và quét mã QR bằng camera điện thoại. Mã QR này do trình duyệt/hệ điều hành tạo cho phiên WebAuthn; mã QR Google Authenticator trong ứng dụng là chức năng khác. Khi đăng nhập, ứng dụng ưu tiên Passkey điện thoại; Passkey cũ vẫn dùng được nếu tài khoản chưa thêm Passkey điện thoại để tránh khóa tài khoản trong lúc chuyển đổi.

Ứng dụng web không thể tự bật Bluetooth, tạo mã QR WebAuthn đúng chuẩn, xác minh trực tiếp radio Bluetooth đã hoạt động, hoặc buộc trình duyệt hiển thị QR trong mọi lần đăng nhập. Trình duyệt có thể dùng điện thoại đã ghép đôi và bỏ bước quét QR. Thông tin `hybrid`/`authenticatorAttachment` do trình duyệt báo giúp định hướng luồng và lọc đăng ký, nhưng không phải bằng chứng mật mã rằng một điện thoại cụ thể đã được dùng. Cần thử với điện thoại và trình duyệt thật; bài kiểm thử tự động không giả lập được bước quét QR/Bluetooth.

## Nâng cấp từ bản cũ

Chạy lại `start-service-manager.cmd` trên Windows hoặc `bash start-server.sh` trên Ubuntu trước khi gọi `docker compose` trực tiếp. Trình khởi động bổ sung bốn cặp khóa RSA vào `.env` mà không đổi mật khẩu database, khóa TOTP hay xóa volume. Token đăng nhập cũ dùng khóa đối xứng sẽ không còn hợp lệ; người dùng đăng nhập lại. Giữ `.env` và các bản sao lưu ngoài Git, chỉ cho người quản trị máy đọc. Nếu trước đây web mở trên mọi địa chỉ, sau nâng cấp nó chỉ còn ở localhost; làm theo mục HTTPS ở trên để truy cập từ xa.

## Kiểm thử và giới hạn

Chạy `node tests/soa-faults.mjs --browser` từ thư mục gốc để kiểm thử trên một Compose project và các volume tạm riêng. Bộ kiểm thử gồm phân quyền, token giả mạo/chỉnh sửa, thử mật khẩu nhiều lần, CORS, header, tranh chấp chỗ cuối, ngắt kết nối từng database và khởi động lại. Nó không quét mọi thư viện hệ điều hành, không chứng minh không có lỗ hổng zero-day, không thay thế pentest độc lập, và không kiểm tra cấu hình TLS/firewall bên ngoài Compose.

Các rủi ro còn lại: cùng máy Docker là điểm lỗi chung; các dịch vụ vẫn dùng một mật khẩu PostgreSQL chung dù mỗi database và mạng riêng; người có quyền quản lý Docker có thể đọc biến môi trường chứa khóa; hàng chờ đăng ký khi mất mạng nằm trên trình duyệt. Môi trường thực tế cần quản lý bí mật chuyên dụng, sao lưu/khôi phục đã diễn tập, giám sát, cập nhật image và kiểm thử xâm nhập định kỳ.

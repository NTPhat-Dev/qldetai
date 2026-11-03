# QL Đề Tài

Hệ thống quản lý đề tài cho quản trị viên, giảng viên và sinh viên. Giao diện tiếng Việt, Arial, nền trang đăng nhập từ ảnh có sẵn của dự án.

## Chạy trên Windows

Clone repository, mở thư mục gốc và chạy `start-service-manager.cmd` (trong PowerShell: `.\start-service-manager.cmd`). Trình khởi chạy kiểm tra .NET SDK, WSL 2 và Docker Desktop; khi thiếu, nó hướng dẫn hoặc cài các thành phần cần thiết bằng WinGet. Một số bước cài hệ thống có thể yêu cầu quyền quản trị và khởi động lại Windows. Sau đó chạy lại cùng tệp.

Trình quản lý tạo `.env` cục bộ với khóa và mật khẩu ngẫu nhiên nếu chưa có, mở Docker Desktop khi cần, dựng các dịch vụ, chờ sẵn sàng và chỉ tạo `admin.demo` khi database Identity chưa có quản trị viên. Mật khẩu ban đầu chỉ hiển thị một lần; hãy lưu lại và đổi ngay. Trình quản lý cho phép theo dõi trạng thái, bật/tắt từng dịch vụ, xem nhật ký và thử lại khi có lỗi. Nó không xóa volume dữ liệu.

## Chạy trên Ubuntu Server

Cài Docker Engine kèm Compose plugin, Git và OpenSSL; cho tài khoản đang dùng quyền chạy Docker hoặc dùng `sudo` khi khởi động. Tại thư mục gốc dự án, chạy:

```bash
bash start-server.sh
```

Lần chạy đầu tạo `.env` và bốn cặp khóa dịch vụ ngẫu nhiên, dựng ba PostgreSQL và các dịch vụ, khởi tạo schema, tạo quản trị viên nếu chưa có và in mật khẩu tạm một lần. Lần sau chạy lại lệnh đó để nâng cấp image và tiếp tục dùng các volume hiện có. Web mặc định chỉ nhận kết nối từ chính Ubuntu Server. Để mở từ điện thoại hoặc máy khác, cấu hình reverse proxy HTTPS theo `docs/SECURITY.md`; không chuyển tiếp trực tiếp cổng HTTP của ứng dụng qua VirtualBox NAT.

## Địa chỉ và dữ liệu

Web trên chính máy chạy Docker: `http://localhost:5173` (hoặc cổng `WEB_PORT` trong `.env`); quản trị: `/admin`; sinh viên và giảng viên: `/login`. Mặc định cổng web chỉ gắn với `127.0.0.1`; API và PostgreSQL chỉ ở mạng Docker nội bộ. Nếu cần truy cập từ mạng khác, dùng HTTPS ở lớp reverse proxy và cấu hình `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID` đúng tên miền.

Identity, Academic và Registration có PostgreSQL container, database và volume riêng. Schema được tạo trên volume mới và nâng cấp bằng migration khi ứng dụng khởi động với volume cũ. Khởi động lại, build lại image hoặc clone code không xóa volume. **Không chạy `docker compose down -v` khi cần giữ dữ liệu.** Sao lưu các volume trước khi nâng cấp môi trường có dữ liệu thật.

## Kiểm thử

`docs/VERIFICATION.md` ghi các lệnh kiểm thử và giới hạn của kiểm thử chịu lỗi. Bộ kiểm thử tích hợp tạo một Compose project và ba volume ngẫu nhiên riêng, rồi chỉ dọn project kiểm thử đó. Không chạy thử ngắt database trên môi trường demo có dữ liệu cần giữ.

Kiến trúc và mức bảo đảm SOA: `docs/SOA_ARCHITECTURE.md`.

Các biện pháp bảo mật, cách triển khai HTTPS và giới hạn còn lại: `docs/SECURITY.md`.

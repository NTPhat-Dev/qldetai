# QL Đề Tài

Hệ thống quản lý đề tài học thuật: cổng quản trị, cổng sinh viên/giảng viên và PostgreSQL.

## Khởi chạy trên máy mới

Yêu cầu .NET 10 SDK và Docker Desktop. Clone repository rồi chạy `start-service-manager.cmd` (PowerShell: `.\start-service-manager.cmd`). Ứng dụng WinForms sẽ tự:

1. Tạo `.env` cục bộ với mật khẩu PostgreSQL, khóa JWT và khóa mã hóa TOTP ngẫu nhiên nếu máy chưa có cấu hình.
2. Khởi động Docker Desktop nếu đã cài nhưng chưa chạy.
3. Dựng và bật ba PostgreSQL riêng, các domain service, API Gateway và web; chờ đến khi tất cả báo khỏe.
4. Khởi tạo schema vào các volume trống và tạo tài khoản quản trị `admin.demo` nếu Identity DB chưa có quản trị viên.
5. Hiện mật khẩu quản trị ngẫu nhiên một lần trong trình quản lý. Lưu lại, đăng nhập và đổi mật khẩu ngay.

Giao diện hệ thống ở `http://localhost:5173`. Đây là cổng duy nhất được công khai; API và PostgreSQL chỉ giao tiếp nội bộ trong Docker. Cửa sổ WinForms chuẩn bị môi trường ở máy mới và bật/tắt các dịch vụ Docker. Nếu frontend dự án đã chạy tại cổng 5173, trình quản lý giữ nguyên tiến trình hiện tại và chỉ khởi tạo các dịch vụ còn thiếu. Cấu hình và dữ liệu có sẵn được giữ nguyên.

## Giữ và chuyển database

Mỗi domain service lưu dữ liệu trong PostgreSQL server và named volume riêng: `qldetai_identity_data`, `qldetai_academic_data`, `qldetai_registration_data`. Dựng lại image hoặc clone code lần sau không xóa volume. Trình quản lý không có thao tác xóa volume; tránh `docker compose down -v` nếu cần giữ dữ liệu.

Mỗi service khởi tạo schema riêng từ `services/<domain>/schema.sql` trên volume mới. Cấu trúc dữ liệu của các domain không dùng chung database hoặc khóa ngoại liên dịch vụ.

## Phát triển trực tiếp

- Chạy giao diện: `http://localhost:5173` hoặc `http://localhost:5173/admin`.
- Web/Nginx chuyển tiếp `/api` tới API Gateway trong mạng Docker. Các API và database không công khai cổng máy chủ.

## Kiến trúc SOA

Frontend chỉ gọi API Gateway. Identity sở hữu tài khoản và bảo mật; Academic sở hữu khoa, lớp, học kỳ, đợt và đề tài; Registration sở hữu đơn và lịch sử. Mỗi service có PostgreSQL server và volume riêng, chỉ cổng web `5173` được công khai. Ranh giới dữ liệu chi tiết nằm trong `docs/SOA_ARCHITECTURE.md`.

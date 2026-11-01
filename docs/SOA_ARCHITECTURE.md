# Kiến trúc dịch vụ

## Mục tiêu

Chuyển hệ thống hiện tại từ một API Koa truy vấn trực tiếp một PostgreSQL chung sang các dịch vụ nghiệp vụ độc lập. Mỗi dịch vụ sở hữu PostgreSQL server, schema và vòng đời dữ liệu riêng. Dịch vụ khác chỉ truy cập dữ liệu qua API; không dùng khóa ngoại, truy vấn chéo database hoặc dùng chung connection string.

## Ranh giới dịch vụ

| Thành phần | Sở hữu | API/luồng chính | Database |
|---|---|---|---|
| Identity | Tài khoản, vai trò, trạng thái, xác thực, MFA, hồ sơ cá nhân | Đăng nhập, mật khẩu, passkey, TOTP, cấp tài khoản, hồ sơ | `identity-db` |
| Academic | Khoa, lớp, học kỳ, đợt, đề tài, thời hạn đề tài | Quản trị học vụ, công bố và tra cứu đề tài | `academic-db` |
| Registration | Đăng ký đề tài, quyết định, lịch sử, sức chứa và các điều kiện đăng ký | Gửi/hủy/duyệt đăng ký | `registration-db` |
| API Gateway | Không sở hữu dữ liệu nghiệp vụ; xác thực JWT và định tuyến/tổng hợp phản hồi | Giữ hợp đồng `/api` hiện tại cho frontend | Không có |
| Web | Tài nguyên giao diện tĩnh | React, chuyển tiếp `/api` tới gateway | Không có |

Các ID tham chiếu giữa dịch vụ là UUID bất biến, không phải khóa ngoại. Academic lưu `lecturer_id`; Registration lưu `student_id`, `topic_id`, `round_id` và snapshot cần thiết cho lịch sử. Registration hỏi Academic về trạng thái đề tài/đợt và áp dụng điều kiện đăng ký trong transaction cục bộ. Với thao tác cần cập nhật nhiều dịch vụ, gateway điều phối theo saga và có bước bù; không giả lập transaction phân tán.

## Giao tiếp và khả năng chịu lỗi

- Frontend chỉ gọi API Gateway; không gọi thẳng service nội bộ.
- Gateway kiểm tra JWT, role và chuyển tiếp identity claims qua mạng nội bộ.
- Service chỉ mở cổng trong mạng Compose; chỉ Gateway và health checks được truy cập chúng.
- Mỗi service có `/health` (liveness) và `/ready` (database readiness), timeout và giới hạn kết nối độc lập.
- Request giữa dịch vụ có timeout rõ ràng; lỗi dịch vụ phụ thuộc trả 503, không trả dữ liệu giả.
- Các endpoint thay đổi dữ liệu nhận `Idempotency-Key` khi gateway điều phối saga để có thể thử lại an toàn.

## Di chuyển dữ liệu và cutover

1. Giữ nguyên volume PostgreSQL cũ; tạo backup có thể khôi phục trước khi chuyển.
2. Tạo ba PostgreSQL server/volume mới và bootstrap schema riêng cho từng dịch vụ.
3. Chuyển dữ liệu theo quyền sở hữu; kiểm tra số dòng, khóa duy nhất và quan hệ UUID.
4. Chạy dịch vụ mới song song trên cổng nội bộ, kiểm tra health và hợp đồng API.
5. Chỉ đổi Gateway/frontend sang service mới sau khi smoke test nghiệp vụ đạt.
6. Giữ cấu hình/volume cũ để rollback; chỉ dọn sau một giai đoạn vận hành ổn định và có xác nhận riêng.

Bootstrap không tự xóa volume, không chạy `down -v`, không ghi ngược vào database cũ. Không đưa mật khẩu hay dữ liệu thật vào Git.

## Trạng thái triển khai

- Identity, Academic và Registration có mỗi service một PostgreSQL server và một named volume riêng.
- API Gateway là điểm vào duy nhất cho `/api`; Nginx nội bộ chuyển tiếp tới Gateway. Chỉ cổng web `5173` được công khai.
- Dữ liệu tài khoản, MFA/Passkey, khoa/lớp, đề tài, đợt và đăng ký đã được chuyển từ database cũ sang các volume domain.
- Luồng đăng nhập, MFA, bảo mật, quản lý khoa/lớp/đợt/tài khoản, hồ sơ, đề tài và đăng ký được phục vụ qua Gateway/domain services.
- Trình quản lý dịch vụ không còn khởi chạy Koa monolith hoặc database dùng chung. Khi nâng cấp máy cũ, nó loại bỏ container API/database cũ nhưng giữ lại volume cũ như bản lưu; không xóa volume tự động.
- Dùng `docker compose --profile soa up -d --build` để bật nền tảng. Không dùng `down -v`; thao tác đó xóa dữ liệu các service.

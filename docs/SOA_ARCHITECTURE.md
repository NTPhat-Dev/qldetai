# Kiến trúc SOA của QL Đề Tài

## Đánh giá trước đợt chỉnh sửa này

Dự án đã tách Identity, Academic và Registration thành ba dịch vụ với ba PostgreSQL riêng, nên đã có nền tảng SOA. Tuy nhiên, ranh giới chưa được bảo vệ đầy đủ: hợp đồng nội bộ chưa xác thực, token đang chờ MFA vẫn có thể vào API nghiệp vụ, lỗi phụ thuộc có thể chờ lâu hoặc trả sai trạng thái, tổng hợp dữ liệu tạo vòng gọi giữa Academic và Registration, và đóng đợt/ẩn đề tài có thể chạy đua với đăng ký. Luồng quản trị thiếu khóa/đặt lại tài khoản và màn hình theo dõi đơn. Đợt chỉnh sửa này củng cố các ranh giới và bổ sung các chức năng đó trên cấu trúc ba database hiện có, giữ nguyên dữ liệu trong volume.

## Ranh giới và quyền sở hữu dữ liệu

| Dịch vụ | Dữ liệu sở hữu | PostgreSQL |
|---|---|---|
| Identity | Tài khoản, vai trò, hồ sơ, mật khẩu, TOTP, Passkey, nhật ký bảo mật | `identity-db` và volume `qldetai_identity_data` |
| Academic | Khoa, lớp, học kỳ, đợt đăng ký, đề tài | `academic-db` và volume `qldetai_academic_data` |
| Registration | Đơn đăng ký, quyết định, lịch sử, quyền nhận đơn theo đợt/đề tài | `registration-db` và volume `qldetai_registration_data` |
| API Gateway | Định tuyến và tổng hợp API; không lưu nghiệp vụ | Không có |
| Web | Giao diện React và chuyển tiếp `/api` | Không có |

Mỗi PostgreSQL là một container, database và volume riêng trên cùng máy Docker. Không có khóa ngoại hay truy vấn SQL xuyên dịch vụ. Tham chiếu xuyên miền bằng UUID và dữ liệu tóm tắt cần cho lịch sử đăng ký. Chỉ web công khai cổng máy chủ; các database và API ở mạng Docker nội bộ. Có thể triển khai từng thành phần trên máy riêng trong tương lai, nhưng bản Compose hiện tại vẫn có điểm lỗi chung là máy Docker.

## Hợp đồng giữa các dịch vụ

- Trình duyệt chỉ gọi `/api` qua Nginx và Gateway. Gateway chỉ định tuyến các đường dẫn công khai cho từng dịch vụ.
- Các đường dẫn `/internal/v1/...` yêu cầu token dịch vụ ký riêng, có đối tượng nhận và thời hạn ngắn. Token đăng nhập của người dùng không được dùng như token dịch vụ. Gateway không công khai đường dẫn nội bộ.
- Mọi API nghiệp vụ kiểm tra vai trò và trạng thái tài khoản ở phía máy chủ. Token còn hạn của tài khoản đã khóa hoặc đã đổi mật khẩu bị từ chối nhờ phiên bản token.
- Các lời gọi giữa dịch vụ có thời gian chờ giới hạn. `/health` thể hiện tiến trình còn sống; `/ready` kiểm tra khả năng phục vụ và các phụ thuộc cần thiết.

## Giao dịch đăng ký và lỗi từng phần

Registration là nơi quyết định một đơn có được nhận hay không. Giao dịch PostgreSQL của dịch vụ này khóa theo đợt và đề tài, kiểm tra giới hạn một đơn hoạt động cho mỗi sinh viên trong một đợt, đếm chỗ còn trống rồi mới ghi. Mã yêu cầu `requestId` cho phép gửi lại cùng nội dung sau khi mất phản hồi mà không tạo thêm đơn; dùng cùng mã cho nội dung khác bị từ chối.

Trạng thái mở đợt hoặc công bố đề tài thuộc Academic. Khi đóng/ẩn, Academic yêu cầu Registration khóa tiếp nhận theo cùng khóa đăng ký trước khi đổi trạng thái. Nếu không liên lạc được Registration, thao tác đóng/ẩn thất bại có kiểm soát thay vì công bố một trạng thái không nhất quán. Nếu khóa tiếp nhận đã ghi nhưng cập nhật metadata ở Academic thất bại, tiếp nhận vẫn đóng để bảo toàn điều kiện; quản trị cần thử lại thao tác để đồng bộ. Đây là phối hợp giữa hai dịch vụ; không phải giao dịch ACID xuyên database.

Khi database Registration ngắt kết nối, API không xác nhận đăng ký thành công. Giao diện giữ danh sách đề tài đã tải trong trình duyệt và giữ yêu cầu ở trạng thái **chờ xử lý** trong localStorage để gửi lại khi kết nối hồi phục. Hàng chờ này gắn với trình duyệt và tài khoản đang dùng; xóa dữ liệu trình duyệt hoặc đổi máy trước khi gửi lại sẽ mất yêu cầu chưa tới máy chủ. Sau khi gửi lại, chỉ phản hồi từ Registration mới xác nhận thành công. Khi Identity mất kết nối, hệ thống từ chối xác thực để tránh dùng phiên đã bị thu hồi.

## Khởi tạo và nâng cấp

Schema khởi tạo từ `services/<domain>/schema.sql` khi volume tương ứng còn trống. Khi volume đã có dữ liệu, mỗi dịch vụ chạy migration bổ sung có khóa đồng bộ lúc khởi động. Chạy lại Compose không xóa dữ liệu và không tạo lại tài khoản quản trị. Tuyệt đối không dùng `docker compose down -v` trên dữ liệu cần giữ. Sao lưu cả ba volume trước khi nâng cấp bản đang dùng thực tế.

## Mức bảo đảm hiện tại

Đây là SOA theo ranh giới nghiệp vụ, quyền sở hữu dữ liệu và hợp đồng API. Nó chưa có cơ chế chịu lỗi ở cấp máy chủ: một máy Docker hỏng thì toàn bộ hệ thống dừng. Hàng chờ đăng ký ở trình duyệt không thay cho hàng đợi bền vững phía máy chủ. Chưa có điều phối giao dịch phân tán hoặc tự động chuyển sang máy dự phòng. Các giới hạn này cần được tính đến nếu triển khai sản xuất nhiều người dùng.

Xem `docs/VERIFICATION.md` để chạy kiểm thử cài mới, phân quyền, tranh chấp chỗ cuối và ngắt kết nối từng dịch vụ/database.

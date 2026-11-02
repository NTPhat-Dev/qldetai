# Nghiệp vụ hiện có của QL Đề Tài

## Vai trò

| Vai trò | Trang đăng nhập | Chức năng chính |
|---|---|---|
| Quản trị | `/admin` | Xem tổng quan và đơn; quản lý khoa, lớp, đợt; cấp, khóa, mở và đặt lại mật khẩu tài khoản |
| Giảng viên | `/login` | Tạo/sửa bản nháp, công bố/ẩn đề tài; xem và quyết định đơn thuộc đề tài mình |
| Sinh viên | `/login` | Tìm đề tài, đăng ký, hủy đơn đang chờ, xem lịch sử và quản lý hồ sơ |

Đăng nhập sai hoặc đăng nhập đúng tài khoản ở cổng dành cho vai trò khác đều có cùng thông báo “Sai tên đăng nhập hoặc mật khẩu.” Quyền và quyền sở hữu bản ghi được kiểm tra ở API, không dựa vào việc ẩn nút trên giao diện.

## Tài khoản và bảo mật

Mã hồ sơ sinh viên/giảng viên sinh tự động và là tên đăng nhập duy nhất. Mật khẩu tạm chỉ được trả về khi cấp hoặc đặt lại tài khoản; lần đăng nhập đầu phải đổi sang mật khẩu ít nhất 12 ký tự. Tài khoản có thể bị khóa và mở lại; khóa, đổi và đặt lại mật khẩu thu hồi phiên cũ. Người dùng có thể cấu hình TOTP, mã khôi phục và Passkey ở phần cài đặt cá nhân. Passkey cần ngữ cảnh an toàn của trình duyệt như HTTPS hoặc localhost.

## Khoa, lớp và đợt

Tên khoa được kiểm tra trùng sau khi chuẩn hóa dấu, chữ hoa/thường và khoảng trắng. Mã khoa, mã lớp, mã học kỳ và mã đợt được hệ thống tạo; quản trị chọn học kỳ 1 hoặc 2 và khai báo ngày học kỳ, thời gian mở/đóng nhận đăng ký. Đợt mặc định đóng; quản trị mở khi sẵn sàng. Thời gian đăng ký đề tài do đợt được chọn quyết định.

## Đề tài và đơn

Giảng viên tạo bản nháp với tên, mô tả, đợt và **số lượng** bắt buộc lớn hơn 0. Mã đề tài sinh tự động. Giảng viên có thể sửa bản nháp trước khi công bố. Đề tài chỉ nhận đơn khi đã công bố, đợt đang mở và còn trong thời gian nhận đơn. Không ẩn đề tài đang có đơn chờ hoặc đã duyệt.

Sinh viên chỉ có một đơn chờ hoặc đã duyệt trong cùng đợt. Registration khóa giao dịch khi đếm số chỗ, nên nhiều sinh viên cùng gửi vào một chỗ cuối chỉ có một đơn được nhận. Sinh viên có thể hủy đơn đang chờ; giảng viên phụ trách được duyệt hoặc từ chối đơn và khi từ chối phải ghi lý do. Lịch sử ghi trạng thái, người thực hiện, thời điểm và ghi chú.

Khi lỗi kết nối tạm thời, giao diện giữ danh sách đề tài đã tải và yêu cầu đăng ký ở trạng thái chờ xử lý trong trình duyệt. Nó thử gửi lại với cùng mã yêu cầu khi dịch vụ phục hồi; không hiển thị thành công trước khi máy chủ xác nhận. Hàng chờ chưa gửi không được đồng bộ giữa thiết bị.

## Giới hạn chức năng

Chưa có thông báo đẩy/email, báo cáo xuất tệp, lưu trữ đề tài hoặc cấu hình thời hạn riêng cho từng đề tài. Nhật ký quyết định đăng ký và sự kiện bảo mật có trong database, nhưng chưa có màn hình báo cáo chuyên sâu. Dự án hiện triển khai các luồng học vụ và bảo mật nêu trên; những hạng mục này cần thiết kế và nghiệm thu riêng nếu muốn bổ sung.

Kiến trúc và kiểm thử: `docs/SOA_ARCHITECTURE.md`, `docs/VERIFICATION.md`.

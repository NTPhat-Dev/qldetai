# Đặc tả chức năng và nghiệp vụ — QL Đề Tài

## Mục tiêu

Quản trị viên tổ chức tài khoản và học vụ; giảng viên quản lý đề tài, xử lý đăng ký; sinh viên tìm, đăng ký và theo dõi đề tài. Giao diện tiếng Việt, màu chủ đạo trắng/đen. Thay đổi cấu trúc PostgreSQL được thực hiện trực tiếp trong pgAdmin theo quy ước dự án.

## Vai trò và cổng

| Vai trò | Cổng | Nghiệp vụ |
|---|---|---|
| Quản trị viên | Cổng riêng `/admin` | Cấp/khóa tài khoản, quản lý khoa/lớp/học kỳ/đợt, giám sát đề tài và đăng ký, xem lịch sử. |
| Sinh viên | Cổng dùng chung `/login` | Tìm đề tài; gửi/hủy đăng ký hợp lệ; theo dõi phản hồi và lịch sử; quản lý hồ sơ/cài đặt. |
| Giảng viên | Cổng dùng chung `/login` | Tạo/công bố đề tài; xem, duyệt/từ chối đăng ký; quản lý hồ sơ/cài đặt. |

Cổng người dùng chung định tuyến theo vai trò. API phải kiểm tra quyền, quyền sở hữu bản ghi và trạng thái nghiệp vụ ở phía máy chủ.

## Tài khoản và bảo mật

- Quản trị viên tạo tài khoản trực tiếp. Sinh viên nhận mã ngẫu nhiên `SV` + chữ số; giảng viên nhận `GV` + chữ số. Mã hồ sơ cũng là tên đăng nhập, phải duy nhất. Không dùng email làm tên đăng nhập.
- Cấp tài khoản tạo mã hồ sơ, username và mật khẩu tạm ngẫu nhiên. Mật khẩu tạm chỉ hiện một lần; người dùng bắt buộc đổi ở lần đăng nhập đầu. Chỉ lưu mật khẩu đã băm; mật khẩu mới tối thiểu 12 ký tự.
- Người dùng có thể bật/tắt xác thực hai lớp bằng TOTP tương thích Google Authenticator và đăng ký một hoặc nhiều Passkey (WebAuthn). Mã khôi phục dùng một lần; cho phép thu hồi Passkey. Cần quản lý phiên và ghi nhật ký sự kiện.
- Tài khoản có trạng thái hoạt động/khóa. Đổi mật khẩu hoặc khóa tài khoản cần thu hồi phiên thích hợp.

## Khoa, lớp, học kỳ và đợt

- Tên khoa không được trùng sau chuẩn hóa dấu, chữ hoa/thường và khoảng trắng. Mã khoa tự sinh từ chữ đầu tên khoa cộng số tăng dần (ví dụ `CNTT1`).
- Tạo lớp bằng cách chọn khoa; mã lớp theo `<mã viết tắt khoa>-K<số>` (ví dụ `CNTT-K1`). Lớp sinh viên chọn phải thuộc đúng khoa.
- Học kỳ có mã, tên và ngày bắt đầu/kết thúc. Mỗi học kỳ có thể có nhiều đợt; mã đợt duy nhất trong học kỳ. Thời điểm mở phải trước thời điểm đóng. Đợt đóng mặc định, admin chủ động mở/đóng.
- Đề tài có thể có thời hạn riêng theo đợt. Thời hạn hiệu lực là giao các khoảng thời gian của đợt, đề tài và cấu hình riêng: mở muộn nhất, đóng sớm nhất. Nếu cấu hình riêng cấm đề tài thì không nhận đơn.
- Không xóa khoa/lớp/học kỳ đang được dữ liệu tham chiếu; ưu tiên ngừng hoạt động hoặc lưu trữ.

## Đề tài

Giảng viên tạo bản nháp với mã, tiêu đề, mô tả, sức chứa và khoảng mở/đóng mặc định; đề tài thuộc khoa của giảng viên. Vòng đời: `Bản nháp → Đã công bố → Đóng đăng ký → Lưu trữ`. Chỉ đề tài đã công bố, còn hạn, không bị khóa và còn sức chứa mới nhận đăng ký. Không ẩn đề tài có đơn đang chờ/đã duyệt. Cần hạn chế sửa nội dung ảnh hưởng đến người đã đăng ký và lưu vết thay đổi.

## Đăng ký

- Sinh viên lọc/tìm đề tài, xem giảng viên, mô tả, sức chứa, đợt và hạn trước khi gửi đơn.
- Trạng thái: `CHO_DUYET → DA_DUYET | TU_CHOI`; sinh viên được hủy đơn đang chờ nếu chính sách cho phép. Mọi chuyển trạng thái cần người thực hiện và thời điểm; từ chối cần lý do.
- Mỗi sinh viên có tối đa một đơn đang chờ/đã duyệt trong mỗi đợt. Backend phải kiểm tra hiệu lực, điều kiện, sức chứa và chủ thể đăng nhập. Tạo đơn phải nguyên tử, chống vượt sức chứa khi nhiều yêu cầu đồng thời.
- Giảng viên chỉ xử lý đơn của đề tài mình phụ trách. Hủy/từ chối giải phóng chỗ theo chính sách; không xóa lịch sử.

## Chức năng theo cổng

### Quản trị

1. Tổng quan số tài khoản, đề tài, đợt và đơn cần xử lý.
2. Tạo tài khoản SV/GV; sinh mã đăng nhập và mật khẩu tạm; tra cứu tài khoản.
3. Tìm tài khoản, xem hồ sơ, khóa/mở, hỗ trợ đặt lại thông tin đăng nhập và thu hồi phiên.
4. Quản lý khoa, lớp, học kỳ và đợt; cấu hình thời gian, mở/đóng.
5. Giám sát đề tài, công bố và đăng ký; thao tác can thiệp phải có lý do và dấu vết.
6. Xem lịch sử nghiệp vụ, nhật ký bảo mật và báo cáo.

### Sinh viên

1. Tổng quan hồ sơ, lớp, đợt đang mở và trạng thái đơn.
2. Tìm/lọc/xem chi tiết đề tài.
3. Gửi/hủy đăng ký hợp lệ; theo dõi kết quả và lịch sử.
4. Đổi mật khẩu, cấu hình MFA, quản lý phiên.

### Giảng viên

1. Tổng quan đề tài, đơn chờ và hạn gần nhất.
2. Tạo/sửa bản nháp, công bố/đóng đề tài, đặt sức chứa và hạn.
3. Xem hồ sơ đơn, duyệt/từ chối kèm lý do; xem sinh viên đã được duyệt và lịch sử.
4. Cập nhật hồ sơ chuyên môn, đổi mật khẩu, cấu hình MFA, quản lý phiên.

## Thông báo và kiểm toán

Thông báo cho sinh viên khi đơn được tiếp nhận, duyệt, từ chối, hủy hoặc khi thay đổi đề tài/hạn ảnh hưởng đến họ; thông báo cho giảng viên khi có đơn mới. Kênh trong ứng dụng là cơ bản; chỉ gửi email khi người dùng có địa chỉ hợp lệ và tự nguyện khai báo. Lịch sử nghiệp vụ và nhật ký bảo mật là hai mục đích riêng.

## Dữ liệu khái niệm

Tài khoản/vai trò; hồ sơ sinh viên, giảng viên, quản trị; khoa/lớp; học kỳ/đợt; đề tài; hạn riêng theo đề tài/đợt; đăng ký; lịch sử trạng thái; thông báo; phiên; thông tin Passkey/TOTP; mã khôi phục; nhật ký kiểm toán. Tạo tài khoản+hồ sơ và gửi đăng ký+cập nhật sức chứa cần giao dịch nhất quán.

## Tình trạng triển khai

- **Đã nối giao diện/API:** đăng nhập theo vai trò, đổi mật khẩu, hồ sơ cá nhân; cài đặt Google Authenticator, mã khôi phục và Passkey; tạo khoa/lớp/tài khoản SV/GV; học kỳ/đợt; tạo/công bố đề tài; đăng ký theo hạn/sức chứa; giảng viên duyệt/từ chối; sinh viên hủy đơn chờ.
- **Đã điều chỉnh qua pgAdmin:** email tài khoản được phép để trống; tài khoản mới không tạo email giả. Bảng thử nghiệm xin cấp tài khoản đã được gỡ khi bảng rỗng.
- **Còn thiếu:** cấu hình thời hạn riêng từng đề tài/đợt; chỉnh sửa/lưu trữ đề tài; lịch sử có ghi chú và trang tra cứu; thông báo; quản lý khóa tài khoản/phiên; báo cáo.

## Tiêu chí nghiệm thu

1. Vai trò chỉ truy cập dữ liệu/chức năng được phép.
2. Mã SV/GV duy nhất và là username; mật khẩu tạm chỉ xem một lần, đổi bắt buộc ở lần đầu.
3. Khoa trùng khác dấu/hoa-thường bị chặn; mã lớp theo đúng quy tắc.
4. Ngoài hạn kết hợp hoặc vượt sức chứa thì đăng ký bị từ chối kể cả khi gọi API trực tiếp.
5. Không có hai đơn đang chờ/được duyệt của cùng sinh viên trong cùng đợt.
6. Quyết định nghiệp vụ và thao tác bảo mật có thể truy vết.
7. Passkey/TOTP không lưu bí mật dạng thuần và có quy trình thu hồi/khôi phục.

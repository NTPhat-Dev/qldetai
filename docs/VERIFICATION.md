# Kiểm thử QL Đề Tài

## Kiểm tra mã nguồn

Trong thư mục `frontend`, chạy `npm ci`, `npm run lint`, `npm test` và `npm run build`. Trong thư mục gốc, chạy `dotnet run --project service-manager/tests/ServiceManager.Checks.csproj -c Release` nếu dùng Windows và .NET SDK 10. Thêm `-- --render` để lưu ảnh xem trước trình quản lý vào thư mục tạm của Windows mà không khởi động dịch vụ thật. Các service Node có thể kiểm tra cú pháp bằng `node --check` trên từng tệp JavaScript thay đổi.

## Kiểm thử tích hợp SOA và chịu lỗi

Yêu cầu Docker Engine/Compose đang chạy và Node.js trên máy thực thi. Tại thư mục gốc:

```text
node tests/soa-faults.mjs
```

Muốn kiểm tra giao diện bằng trình duyệt thật, vào thư mục `tests` chạy `npm ci`, cài Chromium qua `npx playwright install chromium` nếu chưa có, rồi chạy tại thư mục gốc:

```text
node tests/soa-faults.mjs --browser
```

Trên Windows đã cài Microsoft Edge hoặc Chrome có thể đặt `PLAYWRIGHT_CHANNEL=msedge` hoặc `PLAYWRIGHT_CHANNEL=chrome` để dùng trình duyệt hiện có. Bộ kiểm thử tạo tên Compose project ngẫu nhiên theo mẫu `qldetai-verify-...`, cổng web ngẫu nhiên và ba volume riêng; cuối phiên chỉ dọn project đó. Nó không dừng database của project demo. Tệp kết quả `test-results/soa-faults.json` và ảnh giao diện khi chạy `--browser` nằm trong `test-results/`, không đưa lên Git.

Bộ kiểm thử hiện bao phủ: cài mới và ba database độc lập; tạo quản trị lần đầu và buộc đổi mật khẩu; vai trò và đường dẫn nội bộ; tạo khoa, lớp, tài khoản, đợt, đề tài; 12 sinh viên cùng tranh một chỗ cuối; gửi lại cùng mã yêu cầu; quyền giảng viên, từ chối/hủy và lịch sử; tắt lần lượt Registration DB, Academic DB, Academic service và Identity DB; đóng/mở đợt khi phụ thuộc gián đoạn; thời gian trả lỗi có giới hạn và phục hồi sau khi bật lại; khóa/mở tài khoản, đặt lại mật khẩu và thu hồi phiên; bật/tắt TOTP, xác thực hai bước, mã khôi phục dùng một lần; khởi động lại dịch vụ vẫn giữ dữ liệu và migration có thể chạy lại. Kiểm thử bảo mật xác nhận token giả mạo/chỉnh sửa bị từ chối, một dịch vụ không thể ký thay dịch vụ khác, giới hạn lần thử mật khẩu/MFA, header bảo vệ, CORS và việc giả địa chỉ IP không vượt qua giới hạn đăng nhập. Bài trình duyệt kiểm tra bố cục màn hình nhỏ, nền đăng nhập, font Arial và yêu cầu chờ xử lý qua lần tải lại trang.

Lần chạy ngày 03/11/2026 trên Windows với Docker Desktop và Chrome: `node tests/soa-faults.mjs --browser` đạt **13/13** nhóm kiểm tra. Các kiểm tra riêng của frontend đạt **4/4**, trình quản lý dịch vụ đạt **15/15**. `npm audit` của frontend và services báo **0** cảnh báo đã biết tại thời điểm chạy. Đây là kết quả trên Compose project dùng dữ liệu thử mới; hãy chạy lại khi thay đổi môi trường triển khai hoặc code.

## Cách hiểu kết quả

Phản hồi `503` khi database thật sự không phục vụ là có chủ đích: máy chủ không xác nhận một thao tác chưa ghi thành công. Giao diện có thể hiển thị danh sách đã tải và ghi yêu cầu đăng ký vào hàng chờ cục bộ để thử lại. Chỉ khi phản hồi xác nhận từ máy chủ mới hiển thị đăng ký thành công. Bộ kiểm thử ngắt từng thành phần và khôi phục nó; chưa mô phỏng hỏng cả máy chủ Docker, mất đĩa, phân vùng mạng kéo dài hoặc nhiều bản sao dịch vụ. Cần kiểm thử riêng các tình huống đó trước khi dùng trong sản xuất.

# Web client

Giao diện React/TypeScript của cổng quản trị và cổng sinh viên/giảng viên.

- Chạy phát triển: `npm.cmd install`, sau đó `npm.cmd run dev`.
- Build giao diện: `npm.cmd run build`.
- Dùng Docker Compose để chạy toàn bộ hệ thống và truy cập `http://localhost:5173`; Nginx chuyển tiếp `/api` tới API Gateway trong mạng nội bộ.
- Trong Docker, Nginx phục vụ giao diện và chuyển tiếp `/api` tới container API.

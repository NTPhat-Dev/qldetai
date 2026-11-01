using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace Qldetai.ServiceManager;

internal sealed class MainForm : Form
{
    private static readonly Color Ink = Color.FromArgb(0, 229, 255);
    private static readonly Color Paper = Color.FromArgb(5, 8, 12);
    private static readonly Color SoftPaper = Color.FromArgb(12, 18, 24);
    private static readonly Color White = Color.FromArgb(8, 13, 18);
    private static readonly Color Muted = Color.FromArgb(127, 166, 174);
    private static readonly Color Rule = Color.FromArgb(31, 61, 70);
    private static readonly Color Healthy = Color.FromArgb(52, 211, 112);
    private static readonly Color Fault = Color.FromArgb(255, 76, 92);

    private readonly ServiceCoordinator _coordinator;
    private readonly Label _dockerState = new();
    private readonly Label _setupTitle = new();
    private readonly Label _setupMessage = new();
    private readonly ProgressBar _progress = new();
    private readonly Label _log = new();
    private readonly FlowLayoutPanel _serviceCards = new();
    private readonly Button _retryButton = new();
    private readonly Button _startAllButton = new();
    private readonly Button _rebuildButton = new();
    private readonly Button _openWebButton = new();
    private readonly Button _openAdminButton = new();
    private readonly System.Windows.Forms.Timer _refreshTimer = new() { Interval = 3000 };
    private readonly Dictionary<string, (Label Status, Button Toggle)> _serviceControls = new(StringComparer.Ordinal);
    private bool _busy;
    private bool _dockerAvailable;
    private string? _lastError;

    public MainForm()
    {
        _coordinator = new ServiceCoordinator();
        Text = "QL Đề Tài · Trình quản lý dịch vụ";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(880, 620);
        Size = new Size(1000, 720);
        BackColor = Paper;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
        AutoScaleMode = AutoScaleMode.Dpi;
        DoubleBuffered = true;

        BuildInterface();
        Shown += async (_, _) => await RunStackAsync(forceBuild: false);
        _refreshTimer.Tick += async (_, _) => await RefreshServicesAsync();
        _refreshTimer.Start();
        FormClosed += (_, _) => _refreshTimer.Stop();
    }

    private void BuildInterface()
    {
        var page = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 6,
            Padding = new Padding(22, 16, 22, 18),
            BackColor = Paper,
        };
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 126));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        page.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        Controls.Add(page);

        page.Controls.Add(BuildMasthead(), 0, 0);
        page.Controls.Add(BuildIntro(), 0, 1);
        page.Controls.Add(BuildSetupPanel(), 0, 2);
        page.Controls.Add(BuildServiceHeading(), 0, 3);
        page.Controls.Add(BuildServiceCards(), 0, 4);
        page.Controls.Add(BuildFooter(), 0, 5);
    }

    private Control BuildMasthead()
    {
        var bar = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 0, 0, 6), BackColor = Paper };
        var mark = new Label
        {
            Text = "QLĐT  /  SERVICE MANAGER",
            Dock = DockStyle.Left,
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Ink,
            Font = new Font("Consolas", 9.5F, FontStyle.Bold),
        };
        _dockerState.Text = "●  ĐANG KIỂM TRA DOCKER";
        _dockerState.Dock = DockStyle.Right;
        _dockerState.AutoSize = true;
        _dockerState.TextAlign = ContentAlignment.MiddleRight;
        _dockerState.ForeColor = Ink;
        _dockerState.Font = new Font("Consolas", 9F, FontStyle.Regular);
        bar.Controls.Add(_dockerState);
        bar.Controls.Add(mark);
        return bar;
    }

    private Control BuildIntro()
    {
        var intro = new Panel { Dock = DockStyle.Fill, BackColor = Paper };
        var title = new Label
        {
            Text = "QUẢN LÝ DỊCH VỤ",
            Location = new Point(0, 1),
            Size = new Size(360, 28),
            Font = new Font("Segoe UI Semibold", 17F, FontStyle.Bold),
            ForeColor = Color.White,
        };
        var description = new Label
        {
            Text = "Khởi tạo môi trường · Theo dõi và điều khiển SOA",
            Location = new Point(2, 30),
            Size = new Size(540, 18),
            ForeColor = Muted,
            Font = new Font("Segoe UI", 9F),
        };
        intro.Controls.Add(title);
        intro.Controls.Add(description);
        return intro;
    }

    private Control BuildSetupPanel()
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = SoftPaper,
            Padding = new Padding(14),
        };
        panel.Paint += (_, e) => ControlPaint.DrawBorder(e.Graphics, panel.ClientRectangle, Rule, ButtonBorderStyle.Solid);

        var eyebrow = Eyebrow("00   /   KHỞI TẠO MÔI TRƯỜNG");
        eyebrow.Location = new Point(16, 11);
        eyebrow.Size = new Size(480, 18);
        _setupTitle.Text = "Đang chuẩn bị môi trường…";
        _setupTitle.Location = new Point(16, 34);
        _setupTitle.Size = new Size(560, 30);
        _setupTitle.Font = new Font("Segoe UI Semibold", 16F, FontStyle.Bold);
        _setupTitle.ForeColor = Ink;
        _setupMessage.Text = "Khởi tạo cấu hình và bật toàn bộ dịch vụ.";
        _setupMessage.Location = new Point(17, 68);
        _setupMessage.Size = new Size(560, 36);
        _setupMessage.ForeColor = Muted;
        _setupMessage.Font = new Font("Segoe UI", 9.5F);

        _progress.Location = new Point(17, 108);
        _progress.Size = new Size(500, 6);
        _progress.Style = ProgressBarStyle.Marquee;
        _progress.MarqueeAnimationSpeed = 24;

        ConfigureButton(_retryButton, "Thử lại", isPrimary: true);
        _retryButton.Size = new Size(112, 34);
        _retryButton.Location = new Point(735, 22);
        _retryButton.Visible = false;
        _retryButton.Click += async (_, _) => await RunStackAsync(forceBuild: false);

        ConfigureButton(_startAllButton, "Bật toàn bộ", isPrimary: true);
        _startAllButton.Size = new Size(125, 34);
        _startAllButton.Location = new Point(595, 22);
        _startAllButton.Click += async (_, _) => await RunStackAsync(forceBuild: false);

        ConfigureButton(_rebuildButton, "Dựng lại", isPrimary: false);
        _rebuildButton.Size = new Size(112, 34);
        _rebuildButton.Location = new Point(735, 66);
        _rebuildButton.Click += async (_, _) => await RunStackAsync(forceBuild: true);

        panel.Controls.AddRange([eyebrow, _setupTitle, _setupMessage, _progress, _retryButton, _startAllButton, _rebuildButton]);
        return panel;
    }

    private Control BuildServiceHeading()
    {
        var row = new Panel { Dock = DockStyle.Fill, BackColor = Paper };
        var title = new Label
        {
            Text = "DỊCH VỤ",
            Location = new Point(0, 10),
            Size = new Size(200, 24),
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Bold),
            ForeColor = Ink,
        };
        ConfigureButton(_openWebButton, "MỞ ỨNG DỤNG", false);
        _openWebButton.Size = new Size(132, 30);
        _openWebButton.Location = new Point(676, 5);
        _openWebButton.Click += (_, _) => OpenLocalPage($"http://localhost:{_coordinator.WebHostPort}");
        ConfigureButton(_openAdminButton, "MỞ QUẢN TRỊ", false);
        _openAdminButton.Size = new Size(132, 30);
        _openAdminButton.Location = new Point(818, 5);
        _openAdminButton.Click += (_, _) => OpenLocalPage($"http://localhost:{_coordinator.WebHostPort}/admin");
        row.Controls.AddRange([title, _openWebButton, _openAdminButton]);
        return row;
    }

    private Control BuildServiceCards()
    {
        _serviceCards.Dock = DockStyle.Fill;
        _serviceCards.FlowDirection = FlowDirection.LeftToRight;
        _serviceCards.WrapContents = true;
        _serviceCards.AutoScroll = true;
        _serviceCards.Padding = new Padding(0, 2, 0, 4);
        _serviceCards.BackColor = Paper;
        foreach (var service in new[]
        {
            new ServiceStatus("identity-db", "Identity PostgreSQL", "NỘI BỘ · 5432", false, "stopped", 0),
            new ServiceStatus("academic-db", "Academic PostgreSQL", "NỘI BỘ · 5432", false, "stopped", 0),
            new ServiceStatus("registration-db", "Registration PostgreSQL", "NỘI BỘ · 5432", false, "stopped", 0),
            new ServiceStatus("identity-service", "Identity service", "NỘI BỘ · 3101", false, "stopped", 0),
            new ServiceStatus("academic-service", "Academic service", "NỘI BỘ · 3102", false, "stopped", 0),
            new ServiceStatus("registration-service", "Registration service", "NỘI BỘ · 3103", false, "stopped", 0),
            new ServiceStatus("api-gateway", "API Gateway", "NỘI BỘ · 3100", false, "stopped", 0),
            new ServiceStatus("web", "Web client", $"{_coordinator.WebHostPort} → 80", false, "stopped", 0),
        }) _serviceCards.Controls.Add(CreateServiceCard(service));
        return _serviceCards;
    }

    private Control CreateServiceCard(ServiceStatus service)
    {
        var card = new Panel
        {
            Width = 440,
            Height = 78,
            Margin = new Padding(0, 0, 12, 9),
            Padding = new Padding(0),
            BackColor = SoftPaper,
        };
        card.Paint += (_, e) => ControlPaint.DrawBorder(e.Graphics, card.ClientRectangle, Rule, ButtonBorderStyle.Solid);

        var role = Eyebrow(service.Id switch
        {
            "identity-db" or "academic-db" or "registration-db" => "DATABASE   /   DOMAIN",
            "identity-service" or "academic-service" or "registration-service" => "API   /   SERVICE",
            "api-gateway" => "EDGE   /   GATEWAY",
            _ => "WEB   /   FRONTEND",
        });
        role.Location = new Point(14, 43);
        role.Size = new Size(145, 16);
        role.Font = new Font("Consolas", 7.5F, FontStyle.Bold);
        var status = new Label
        {
            Text = "●  ĐANG TẮT",
            Location = new Point(265, 12),
            Size = new Size(160, 17),
            ForeColor = Fault,
            Font = new Font("Consolas", 8F, FontStyle.Bold),
        };
        var title = new Label
        {
            Text = service.Name,
            Location = new Point(14, 9),
            Size = new Size(245, 26),
            Font = new Font("Segoe UI Semibold", 12F, FontStyle.Bold),
            ForeColor = Color.White,
        };
        var port = new Label
        {
            Text = $"CỔNG  {service.Port}",
            Location = new Point(164, 43),
            Size = new Size(140, 16),
            ForeColor = Muted,
            Font = new Font("Consolas", 7.5F),
        };
        var toggle = new Button
        {
            Text = "Bật dịch vụ",
            Location = new Point(312, 37),
            Size = new Size(112, 28),
            FlatStyle = FlatStyle.Flat,
            BackColor = Paper,
            ForeColor = Ink,
            Cursor = Cursors.Hand,
            Font = new Font("Segoe UI", 8.5F, FontStyle.Bold),
            Tag = service.Id,
        };
        toggle.FlatAppearance.BorderColor = Rule;
        toggle.FlatAppearance.MouseOverBackColor = Color.FromArgb(15, 34, 42);
        toggle.Click += async (_, _) => await ToggleServiceAsync((string)toggle.Tag!, !toggle.Text.StartsWith("Tắt", StringComparison.Ordinal));
        card.Controls.AddRange([role, status, title, port, toggle]);
        _serviceControls[service.Id] = (status, toggle);
        return card;
    }

    private Control BuildFooter()
    {
        var footer = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 12, 0, 0) };
        var note = new Label
        {
            Text = "CHỈ QUẢN LÝ DOCKER TRÊN MÁY NÀY     ·     DỮ LIỆU DATABASE ĐƯỢC GIỮ TRONG VOLUME",
            Dock = DockStyle.Left,
            AutoSize = true,
            ForeColor = Muted,
            Font = new Font("Consolas", 8F),
        };
        _log.Text = "Sẵn sàng khởi chạy.";
        _log.Dock = DockStyle.Right;
        _log.AutoSize = true;
        _log.TextAlign = ContentAlignment.MiddleRight;
        _log.ForeColor = Muted;
        _log.Font = new Font("Segoe UI", 8.5F);
        footer.Controls.Add(_log);
        footer.Controls.Add(note);
        return footer;
    }

    private async Task RunStackAsync(bool forceBuild)
    {
        if (_busy) return;
        SetBusy(true);
        _lastError = null;
        _retryButton.Visible = false;
        _setupTitle.Text = forceBuild ? "Đang dựng lại toàn bộ…" : "Đang khởi động dịch vụ…";
        _setupTitle.ForeColor = Ink;
        _setupMessage.Text = "Tạo cấu hình, kiểm tra Docker và chờ các dịch vụ khỏe.";
        _setupMessage.ForeColor = Muted;
        _progress.Style = ProgressBarStyle.Marquee;
        _progress.MarqueeAnimationSpeed = 24;
        _log.Text = forceBuild ? "Đang yêu cầu build lại Docker image." : "Đang bật môi trường phát triển.";
        var progress = new Progress<string>(message => _setupMessage.Text = message);
        try
        {
            var result = await _coordinator.StartAllAsync(forceBuild, progress, CancellationToken.None);
            _setupTitle.Text = "Môi trường đã sẵn sàng";
            _setupTitle.ForeColor = Healthy;
            _setupMessage.Text = result.AdminMessage;
            _log.Text = result.BuiltImages ? "Đã dựng image và khởi chạy toàn bộ dịch vụ." : "Đã bật lại toàn bộ dịch vụ hiện có.";
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.MarqueeAnimationSpeed = 0;
            _progress.Value = 100;
            if (result.Credentials is not null) using (var dialog = new CredentialsForm(result.Credentials)) dialog.ShowDialog(this);
        }
        catch (Exception error)
        {
            _lastError = error.Message;
            _setupTitle.Text = "Chưa khởi tạo xong";
            _setupTitle.ForeColor = Fault;
            _setupMessage.Text = error.Message;
            _setupMessage.ForeColor = Fault;
            _log.Text = "Cần xử lý trạng thái được báo ở trên.";
            _retryButton.Visible = true;
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.MarqueeAnimationSpeed = 0;
            _progress.Value = 0;
        }
        finally
        {
            SetBusy(false);
            await RefreshServicesAsync();
        }
    }

    private async Task ToggleServiceAsync(string id, bool start)
    {
        if (_busy) return;
        SetBusy(true);
        try
        {
            await _coordinator.SetServiceAsync(id, start, CancellationToken.None);
            _setupTitle.Text = start ? "Đang bật dịch vụ…" : "Đang dừng dịch vụ…";
            _setupTitle.ForeColor = Ink;
            _setupMessage.Text = $"{id}: thao tác đã gửi tới Docker Compose.";
        }
        catch (Exception error)
        {
            _setupTitle.Text = "Không thao tác được dịch vụ";
            _setupTitle.ForeColor = Fault;
            _setupMessage.Text = error.Message;
        }
        finally
        {
            SetBusy(false);
            await RefreshServicesAsync();
        }
    }

    private async Task RefreshServicesAsync()
    {
        if (IsDisposed || Disposing || _busy) return;
        _dockerAvailable = await _coordinator.IsDockerAvailableAsync(CancellationToken.None);
        _dockerState.Text = _dockerAvailable ? "●  DOCKER ĐÃ KẾT NỐI" : "●  DOCKER CHƯA SẴN SÀNG";
        _dockerState.ForeColor = _dockerAvailable ? Healthy : Fault;
        var statuses = await _coordinator.GetServiceStatusesAsync(CancellationToken.None);
        foreach (var service in statuses)
        {
            if (!_serviceControls.TryGetValue(service.Id, out var controls)) continue;
            controls.Status.Text = service.Running
                ? service.External ? "●  ĐANG CHẠY · LOCAL" : $"●  {HealthName(service.Health)}"
                : "●  ĐANG TẮT";
            controls.Status.ForeColor = !service.Running || service.Health.Equals("unhealthy", StringComparison.OrdinalIgnoreCase)
                ? Fault
                : service.External || service.Health.Equals("healthy", StringComparison.OrdinalIgnoreCase) ? Healthy : Ink;
            controls.Toggle.Text = service.Running ? "Tắt dịch vụ" : "Bật dịch vụ";
            controls.Toggle.Enabled = _dockerAvailable && !_busy && !service.External;
        }
        _startAllButton.Enabled = _dockerAvailable && !_busy;
        _rebuildButton.Enabled = _dockerAvailable && !_busy;
        if (!_dockerAvailable && _lastError is null && _setupTitle.Text == "Môi trường đã sẵn sàng")
        {
            _setupTitle.Text = "Docker đang tạm gián đoạn";
            _setupMessage.Text = "Dữ liệu vẫn nằm trong volume. Mở Docker Desktop để khôi phục dịch vụ.";
        }
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        _retryButton.Enabled = !busy;
        _startAllButton.Enabled = !busy && _dockerAvailable;
        _rebuildButton.Enabled = !busy && _dockerAvailable;
        foreach (var controls in _serviceControls.Values) controls.Toggle.Enabled = !busy && _dockerAvailable;
    }

    private static string HealthName(string health) => health.ToLowerInvariant() switch
    {
        "healthy" => "ĐANG CHẠY · KHỎE",
        "external" => "ĐANG CHẠY · LOCAL",
        "unhealthy" => "CẦN KIỂM TRA",
        _ => "ĐANG KHỞI ĐỘNG",
    };

    private static Label Eyebrow(string text) => new()
    {
        Text = text,
        ForeColor = Muted,
        Font = new Font("Consolas", 8F, FontStyle.Bold),
        AutoEllipsis = true,
    };

    private static void ConfigureButton(Button button, string text, bool isPrimary)
    {
        button.Text = text;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = isPrimary ? Ink : Rule;
        button.FlatAppearance.MouseOverBackColor = isPrimary ? Color.FromArgb(59, 242, 255) : Color.FromArgb(15, 34, 42);
        button.BackColor = isPrimary ? Ink : SoftPaper;
        button.ForeColor = isPrimary ? Paper : Ink;
        button.Cursor = Cursors.Hand;
        button.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
    }

    private static void OpenLocalPage(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show(error.Message, "Không mở được trang", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    private sealed class CredentialsForm : Form
    {
        public CredentialsForm(InitialAdmin credentials)
        {
            Text = "Tài khoản quản trị đầu tiên";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(570, 330);
            BackColor = Paper;
            ForeColor = Ink;
            Font = new Font("Segoe UI", 9.5F);

            var eyebrow = Eyebrow("CHỈ HIỆN MỘT LẦN");
            eyebrow.Location = new Point(24, 20);
            eyebrow.Size = new Size(500, 18);
            var title = new Label
            {
                Text = "Lưu thông tin đăng nhập",
                Location = new Point(24, 48),
                Size = new Size(510, 38),
                Font = new Font("Georgia", 21F),
                UseCompatibleTextRendering = true,
            };
            var note = new Label
            {
                Text = "Mật khẩu tạm sẽ không hiển thị lại. Sau khi đăng nhập, hệ thống yêu cầu bạn đổi mật khẩu.",
                Location = new Point(25, 92),
                Size = new Size(510, 42),
                ForeColor = Muted,
            };
            var usernameBox = CredentialBox(credentials.Username);
            usernameBox.Location = new Point(25, 151);
            var passwordBox = CredentialBox(credentials.Password);
            passwordBox.Location = new Point(25, 199);
            var open = new Button { Text = "Mở cổng quản trị", Location = new Point(25, 256), Size = new Size(160, 36) };
            ConfigureButton(open, open.Text, true);
            open.Click += (_, _) => OpenLocalPage(credentials.Url);
            var copy = new Button { Text = "Sao chép mật khẩu", Location = new Point(195, 256), Size = new Size(160, 36) };
            ConfigureButton(copy, copy.Text, false);
            copy.Click += (_, _) => { Clipboard.SetText(credentials.Password); copy.Text = "Đã sao chép"; };
            var done = new Button { Text = "Đã lưu", Location = new Point(445, 256), Size = new Size(90, 36), DialogResult = DialogResult.OK };
            ConfigureButton(done, done.Text, false);
            Controls.AddRange([eyebrow, title, note, usernameBox, passwordBox, open, copy, done]);
            AcceptButton = done;
        }

        private static TextBox CredentialBox(string value) => new()
        {
            Text = value,
            ReadOnly = true,
            BorderStyle = BorderStyle.FixedSingle,
            BackColor = White,
            ForeColor = Ink,
            Font = new Font("Consolas", 10F),
            Size = new Size(510, 32),
        };
    }
}

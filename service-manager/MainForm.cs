using System.Diagnostics;

namespace Qldetai.ServiceManager;

internal sealed class MainForm : Form
{
    private static readonly Color Ink = Color.FromArgb(239, 246, 247);
    private static readonly Color Paper = Color.FromArgb(7, 12, 15);
    private static readonly Color Surface = Color.FromArgb(18, 27, 31);
    private static readonly Color Muted = Color.FromArgb(158, 177, 183);
    private static readonly Color Rule = Color.FromArgb(51, 69, 74);
    private static readonly Color Cyan = Color.FromArgb(70, 218, 227);
    private static readonly Color Green = Color.FromArgb(79, 219, 141);
    private static readonly Color Red = Color.FromArgb(255, 108, 119);
    private readonly ServiceCoordinator _coordinator = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Label _dockerState = new();
    private readonly Label _setupTitle = new();
    private readonly Label _setupMessage = new();
    private readonly Label _serviceSummary = new();
    private readonly ProgressBar _progress = new();
    private readonly TextBox _log = new();
    private readonly Button _retryButton = new();
    private readonly Button _startAllButton = new();
    private readonly Button _stopAllButton = new();
    private readonly Button _rebuildButton = new();
    private readonly Button _refreshButton = new();
    private readonly System.Windows.Forms.Timer _refreshTimer = new() { Interval = 5000 };
    private readonly Dictionary<string, (Label Status, Button Toggle, Button Logs)> _serviceControls = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ServiceStatus> _states = new(StringComparer.Ordinal);
    private readonly ToolTip _tips = new();
    private bool _busy;
    private bool _refreshing;
    private bool _dockerAvailable;
    private string? _lastRefreshError;

    public MainForm(bool startOnShow = true)
    {
        Text = "DEMO · Trình quản lý dịch vụ";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(860, 680);
        Size = new Size(1020, 850);
        BackColor = Paper;
        ForeColor = Ink;
        Font = new Font("Arial", 10F);
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        DoubleBuffered = true;
        BuildInterface();
        AppendLog("Cấu hình và dữ liệu hiện có được giữ trong thư mục dự án / Docker volume.");
        Shown += async (_, _) =>
        {
            if (!startOnShow) return;
            await RunStackAsync(false);
            if (!IsDisposed) _refreshTimer.Start();
        };
        _refreshTimer.Tick += async (_, _) => await RefreshServicesAsync();
        FormClosing += (_, _) => { _refreshTimer.Stop(); _lifetime.Cancel(); };
        FormClosed += (_, _) => { _refreshTimer.Dispose(); _tips.Dispose(); };
    }

    private void BuildInterface()
    {
        var page = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(24), BackColor = Paper };
        page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));
        page.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        page.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 142));
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 25));
        page.Controls.Add(BuildHeader(), 0, 0);
        page.Controls.Add(BuildSummary(), 0, 1);
        page.Controls.Add(BuildActions(), 0, 2);
        page.Controls.Add(BuildServices(), 0, 3);
        page.Controls.Add(BuildLog(), 0, 4);
        page.Controls.Add(Label("Môi trường trên máy này  ·  Dữ liệu được lưu riêng theo từng dịch vụ", 8.5F, false, Muted), 0, 5);
        Controls.Add(page);
    }

    private Control BuildHeader()
    {
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 65));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35));
        var text = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        text.RowStyles.Add(new RowStyle(SizeType.Absolute, 20));
        text.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        text.Controls.Add(Label("DEMO", 9, true, Muted));
        text.Controls.Add(Label("Trình quản lý dịch vụ", 23, true));
        _dockerState.Text = "●  Chưa kiểm tra Docker";
        _dockerState.Dock = DockStyle.Fill;
        _dockerState.TextAlign = ContentAlignment.MiddleRight;
        _dockerState.ForeColor = Muted;
        header.Controls.Add(text, 0, 0);
        header.Controls.Add(_dockerState, 1, 0);
        return header;
    }

    private Control BuildSummary()
    {
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Surface, Padding = new Padding(16, 10, 16, 12), ColumnCount = 2, RowCount = 3, Margin = new Padding(0, 6, 0, 8) };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 98));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 5));
        _setupTitle.Text = "Chuẩn bị môi trường";
        _setupTitle.Font = new Font("Arial", 15, FontStyle.Bold);
        _setupTitle.ForeColor = Color.White;
        _setupTitle.Dock = DockStyle.Fill;
        _setupTitle.AutoEllipsis = true;
        _setupMessage.Text = "Khởi tạo cấu hình, kiểm tra Docker và bật các dịch vụ.";
        _setupMessage.ForeColor = Color.FromArgb(204, 204, 204);
        _setupMessage.Dock = DockStyle.Fill;
        _setupMessage.AutoEllipsis = true;
        _setupMessage.Font = new Font("Arial", 9);
        _progress.Dock = DockStyle.Fill;
        _progress.Style = ProgressBarStyle.Continuous;
        _progress.Margin = new Padding(0);
        ConfigureButton(_retryButton, "Thử lại", true);
        _retryButton.Visible = false;
        _retryButton.Click += async (_, _) => await RunStackAsync(false);
        panel.Controls.Add(_setupTitle, 0, 0);
        panel.Controls.Add(_setupMessage, 0, 1);
        panel.Controls.Add(_progress, 0, 2);
        panel.Controls.Add(_retryButton, 1, 0);
        panel.SetRowSpan(_retryButton, 2);
        _retryButton.Anchor = AnchorStyles.Right;
        return panel;
    }

    private Control BuildActions()
    {
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true, Margin = new Padding(0, 0, 0, 10), Padding = new Padding(0, 4, 0, 4) };
        ConfigureButton(_startAllButton, "Bật toàn bộ", true);
        ConfigureButton(_stopAllButton, "Dừng toàn bộ", false);
        ConfigureButton(_rebuildButton, "Dựng lại image", false);
        ConfigureButton(_refreshButton, "Làm mới", false);
        var openWeb = new Button();
        var openAdmin = new Button();
        ConfigureButton(openWeb, "Mở ứng dụng", false);
        ConfigureButton(openAdmin, "Mở quản trị", false);
        _startAllButton.Click += async (_, _) => await RunStackAsync(false);
        _stopAllButton.Click += async (_, _) => await ExecuteAsync("Đang dừng dịch vụ…", async () => { await _coordinator.StopAllAsync(_lifetime.Token); SetSummary("Đã dừng toàn bộ", "Các database và dữ liệu trong volume được giữ nguyên."); });
        _rebuildButton.Click += async (_, _) => await RunStackAsync(true);
        _refreshButton.Click += async (_, _) => await RefreshServicesAsync();
        openWeb.Click += (_, _) => OpenLocalPage($"http://localhost:{_coordinator.WebHostPort}");
        openAdmin.Click += (_, _) => OpenLocalPage($"http://localhost:{_coordinator.WebHostPort}/admin");
        _tips.SetToolTip(_rebuildButton, "Dựng image không dùng cache, sau đó bật lại các dịch vụ. Giữ nguyên dữ liệu.");
        actions.Controls.AddRange([_startAllButton, _stopAllButton, _rebuildButton, _refreshButton, openWeb, openAdmin]);
        return actions;
    }

    private Control BuildServices()
    {
        var section = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Margin = new Padding(0, 0, 0, 10) };
        section.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        section.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        section.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        _serviceSummary.Text = "DỊCH VỤ  ·  Chưa kiểm tra";
        _serviceSummary.Font = new Font("Arial", 9, FontStyle.Bold);
        _serviceSummary.Dock = DockStyle.Fill;
        var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = Surface };
        var rows = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, Padding = new Padding(10, 0, 10, 0), BackColor = Surface };
        rows.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var service in new[]
        {
            ("identity-db", "Database định danh", "Nội bộ · 5432"),
            ("academic-db", "Database học vụ", "Nội bộ · 5432"),
            ("registration-db", "Database đăng ký", "Nội bộ · 5432"),
            ("identity-service", "Dịch vụ tài khoản", "Nội bộ · 3101"),
            ("academic-service", "Dịch vụ học vụ", "Nội bộ · 3102"),
            ("registration-service", "Dịch vụ đăng ký", "Nội bộ · 3103"),
            ("api-gateway", "Cổng API", "Nội bộ · 3100"),
            ("web", "Giao diện web", $"Cổng {_coordinator.WebHostPort}")
        })
        {
            rows.RowStyles.Add(new RowStyle(SizeType.Absolute, 49));
            rows.Controls.Add(CreateServiceRow(service.Item1, service.Item2, service.Item3));
        }
        scroll.Controls.Add(rows);
        section.Controls.Add(_serviceSummary, 0, 0);
        section.Controls.Add(scroll, 0, 1);
        return section;
    }

    private Control CreateServiceRow(string id, string name, string port)
    {
        var row = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, RowCount = 1, Margin = Padding.Empty, Padding = new Padding(3, 5, 3, 5), BackColor = Surface };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80));
        row.Paint += (_, e) => { using var pen = new Pen(Rule); e.Graphics.DrawLine(pen, 0, row.Height - 1, row.Width, row.Height - 1); };
        var title = Label(name, 10, true);
        var status = Label("○ Chưa kiểm tra", 9, false, Muted);
        var portLabel = Label(port, 8.5F, false, Muted);
        var toggle = new Button();
        var logs = new Button();
        ConfigureButton(toggle, "Bật", false);
        ConfigureButton(logs, "Nhật ký", false);
        toggle.Dock = logs.Dock = DockStyle.Fill;
        toggle.Margin = logs.Margin = new Padding(4, 1, 0, 1);
        toggle.AutoSize = logs.AutoSize = false;
        toggle.Enabled = logs.Enabled = false;
        toggle.Click += async (_, _) =>
        {
            var start = !_states.TryGetValue(id, out var state) || !state.Running;
            await ExecuteAsync(start ? $"Đang bật {name}…" : $"Đang dừng {name}…", async () =>
            {
                await _coordinator.SetServiceAsync(id, start, _lifetime.Token);
                SetSummary("Đã gửi thao tác", $"{name}: {(start ? "đã bật" : "đã dừng")}. Trạng thái được cập nhật bên dưới.");
            });
        };
        logs.Click += async (_, _) => await ShowServiceLogsAsync(id, name);
        row.Controls.Add(title, 0, 0);
        row.Controls.Add(status, 1, 0);
        row.Controls.Add(portLabel, 2, 0);
        row.Controls.Add(toggle, 3, 0);
        row.Controls.Add(logs, 4, 0);
        _serviceControls[id] = (status, toggle, logs);
        return row;
    }

    private Control BuildLog()
    {
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Margin = Padding.Empty };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        panel.Controls.Add(Label("NHẬT KÝ THAO TÁC", 9, true), 0, 0);
        var copy = new Button();
        ConfigureButton(copy, "Sao chép", false);
        copy.Click += (_, _) => CopyText(_log.Text);
        panel.Controls.Add(copy, 1, 0);
        _log.Dock = DockStyle.Fill;
        _log.Multiline = true;
        _log.ReadOnly = true;
        _log.ScrollBars = ScrollBars.Vertical;
        _log.BackColor = Surface;
        _log.ForeColor = Muted;
        _log.BorderStyle = BorderStyle.FixedSingle;
        _log.Font = new Font("Arial", 9);
        panel.Controls.Add(_log, 0, 1);
        panel.SetColumnSpan(_log, 2);
        return panel;
    }

    private async Task RunStackAsync(bool rebuild)
    {
        await ExecuteAsync(rebuild ? "Đang dựng lại image…" : "Đang chuẩn bị môi trường…", async () =>
        {
            var progress = new Progress<string>(message => { if (!IsDisposed) { _setupMessage.Text = message; AppendLog(message); } });
            var result = await _coordinator.StartAllAsync(rebuild, progress, _lifetime.Token);
            SetSummary("Môi trường đã sẵn sàng", result.AdminMessage);
            _progress.Value = 100;
            if (result.Credentials is not null && !IsDisposed)
                using (var dialog = new CredentialsForm(result.Credentials)) dialog.ShowDialog(this);
        });
    }

    private async Task ExecuteAsync(string title, Func<Task> action)
    {
        if (_busy || IsDisposed) return;
        SetBusy(true);
        _retryButton.Visible = false;
        SetSummary(title, "Đang thực hiện. Chi tiết được ghi vào nhật ký.");
        _progress.Style = ProgressBarStyle.Marquee;
        _progress.MarqueeAnimationSpeed = 24;
        try { await action(); }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            SetSummary("Cần kiểm tra", ShortMessage(error.Message));
            AppendLog(error.Message);
            _retryButton.Visible = true;
        }
        finally
        {
            if (!IsDisposed && !_lifetime.IsCancellationRequested)
            {
                _progress.Style = ProgressBarStyle.Continuous;
                _progress.MarqueeAnimationSpeed = 0;
                SetBusy(false);
                await RefreshServicesAsync();
            }
        }
    }

    private async Task RefreshServicesAsync()
    {
        if (IsDisposed || _busy || _refreshing || _lifetime.IsCancellationRequested) return;
        _refreshing = true;
        try
        {
            _dockerAvailable = await _coordinator.IsDockerAvailableAsync(_lifetime.Token);
            if (!_dockerAvailable) throw new InvalidOperationException("Docker chưa sẵn sàng. Chọn Bật toàn bộ để mở Docker và khôi phục môi trường.");
            var statuses = await _coordinator.GetServiceStatusesAsync(_lifetime.Token);
            if (IsDisposed) return;
            _dockerState.Text = "●  Docker đã kết nối";
            _dockerState.ForeColor = Green;
            _lastRefreshError = null;
            foreach (var service in statuses)
            {
                _states[service.Id] = service;
                var controls = _serviceControls[service.Id];
                controls.Status.Text = service.External ? "● Chạy ngoài Docker" : !service.Running ? "○ Đã dừng" : service.Health.ToLowerInvariant() switch { "healthy" => "● Đang chạy", "unhealthy" => "! Cần kiểm tra", _ => "◌ Khởi động" };
                controls.Status.ForeColor = service.External ? Cyan : !service.Running ? Red : service.Health.ToLowerInvariant() switch { "healthy" => Green, "unhealthy" => Red, _ => Cyan };
                controls.Toggle.Text = service.Running ? "Dừng" : "Bật";
                controls.Toggle.Enabled = !_busy && !service.External;
                controls.Logs.Enabled = !_busy && !service.External;
                _tips.SetToolTip(controls.Status, $"{service.Id}: {service.Health}");
            }
            var ready = statuses.Count(service => service.Running && (service.Health == "healthy" || service.External));
            _serviceSummary.Text = $"DỊCH VỤ  ·  {ready}/{statuses.Count} sẵn sàng";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (IsDisposed) return;
            _dockerState.Text = _dockerAvailable ? "● Chưa đọc được trạng thái" : "○ Docker chưa kết nối";
            _dockerState.ForeColor = Red;
            _serviceSummary.Text = "DỊCH VỤ  ·  Chưa xác định trạng thái hiện tại";
            foreach (var controls in _serviceControls.Values) { controls.Toggle.Enabled = false; controls.Logs.Enabled = false; }
            if (_lastRefreshError != error.Message) { AppendLog(error.Message); _lastRefreshError = error.Message; }
        }
        finally { _refreshing = false; if (!IsDisposed) UpdateActionState(); }
    }

    private void SetBusy(bool value)
    {
        _busy = value;
        foreach (var item in _serviceControls) { item.Value.Toggle.Enabled = !value && _dockerAvailable && _states.TryGetValue(item.Key, out var state) && !state.External; item.Value.Logs.Enabled = !value && _dockerAvailable; }
        UpdateActionState();
    }

    private void UpdateActionState()
    {
        // Start also opens Docker, so it remains usable while Docker is offline.
        _startAllButton.Enabled = _retryButton.Enabled = _rebuildButton.Enabled = !_busy;
        _stopAllButton.Enabled = !_busy && _dockerAvailable;
        _refreshButton.Enabled = !_busy && !_refreshing;
    }

    private void SetSummary(string title, string message)
    {
        if (IsDisposed) return;
        _setupTitle.Text = title;
        _setupMessage.Text = message;
        _setupTitle.ForeColor = title.Contains("kiểm tra", StringComparison.OrdinalIgnoreCase) || title.Contains("lỗi", StringComparison.OrdinalIgnoreCase) ? Red : Ink;
        AppendLog($"{title} {message}");
    }

    private void AppendLog(string message)
    {
        if (IsDisposed || _log.IsDisposed) return;
        if (_log.TextLength > 40000) _log.Text = _log.Text[^20000..];
        _log.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}");
    }

    private async Task ShowServiceLogsAsync(string id, string name)
    {
        try
        {
            var logs = await _coordinator.GetServiceLogsAsync(id, _lifetime.Token);
            if (IsDisposed) return;
            using var dialog = new Form { Text = $"Nhật ký · {name}", StartPosition = FormStartPosition.CenterParent, Size = new Size(840, 500), MinimumSize = new Size(600, 360), Font = new Font("Arial", 9), BackColor = Paper };
            var text = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Text = string.IsNullOrWhiteSpace(logs) ? "Chưa có nhật ký." : logs, BackColor = Surface, ForeColor = Ink };
            var copy = new Button { Dock = DockStyle.Bottom, Height = 38 };
            ConfigureButton(copy, "Sao chép nhật ký", false);
            copy.Click += (_, _) => CopyText(text.Text);
            dialog.Controls.Add(text);
            dialog.Controls.Add(copy);
            dialog.ShowDialog(this);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error) { SetSummary("Chưa lấy được nhật ký", ShortMessage(error.Message)); AppendLog(error.Message); }
    }

    private static string ShortMessage(string value) => value.Length <= 190 ? value : value[..187] + "… Xem nhật ký bên dưới.";
    private static Label Label(string text, float size, bool bold, Color? color = null) => new() { Text = text, Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft, ForeColor = color ?? Ink, Font = new Font("Arial", size, bold ? FontStyle.Bold : FontStyle.Regular), Margin = new Padding(0, 0, 8, 0) };
    private static void ConfigureButton(Button button, string text, bool primary)
    {
        button.Text = text;
        button.AutoSize = true;
        button.MinimumSize = new Size(76, 32);
        button.Padding = new Padding(10, 3, 10, 3);
        button.Margin = new Padding(0, 0, 7, 0);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = primary ? Cyan : Rule;
        button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(132, 234, 239) : Color.FromArgb(35, 50, 56);
        button.BackColor = primary ? Cyan : Surface;
        button.ForeColor = primary ? Paper : Ink;
        button.Cursor = Cursors.Hand;
        button.Font = new Font("Arial", 9, FontStyle.Bold);
    }

    private static void CopyText(string value)
    {
        try { if (!string.IsNullOrEmpty(value)) Clipboard.SetText(value); }
        catch (Exception error) { MessageBox.Show(error.Message, "Không sao chép được", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }

    private static void OpenLocalPage(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show(error.Message, "Không mở được trang", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }

    private sealed class CredentialsForm : Form
    {
        public CredentialsForm(InitialAdmin credentials)
        {
            Text = "Tài khoản quản trị đầu tiên";
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(580, 345);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            BackColor = Paper;
            Font = new Font("Arial", 10);
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            var page = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 7 };
            page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute, 35));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
            page.RowStyles.Add(new RowStyle(SizeType.Absolute, 35));
            page.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            page.Controls.Add(Label("Lưu thông tin đăng nhập", 20, true));
            page.Controls.Add(Label("Mật khẩu tạm chỉ hiện một lần. Hệ thống sẽ yêu cầu đổi mật khẩu sau khi đăng nhập.", 10, false, Muted));
            page.Controls.Add(Label("Tên đăng nhập", 9, true));
            page.Controls.Add(new TextBox { Text = credentials.Username, ReadOnly = true, Dock = DockStyle.Fill, BackColor = Surface, ForeColor = Ink });
            page.Controls.Add(Label("Mật khẩu tạm", 9, true));
            page.Controls.Add(new TextBox { Text = credentials.Password, ReadOnly = true, Dock = DockStyle.Fill, BackColor = Surface, ForeColor = Ink });
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(0, 14, 0, 0) };
            var open = new Button(); var copy = new Button(); var done = new Button { DialogResult = DialogResult.OK };
            ConfigureButton(open, "Mở quản trị", true);
            ConfigureButton(copy, "Sao chép mật khẩu", false);
            ConfigureButton(done, "Đã lưu", false);
            open.Click += (_, _) => OpenLocalPage(credentials.Url);
            copy.Click += (_, _) => { CopyText(credentials.Password); copy.Text = "Đã sao chép"; };
            actions.Controls.AddRange([open, copy, done]);
            page.Controls.Add(actions);
            Controls.Add(page);
            AcceptButton = done;
        }
    }
}

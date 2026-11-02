using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Qldetai.ServiceManager;

internal sealed record ServiceStatus(string Id, string Name, string Port, bool Running, string Health, int Containers, bool External = false);
internal sealed record InitialAdmin(string Username, string Password, string Url);
internal sealed record StackStartResult(bool BuiltImages, string AdminMessage, InitialAdmin? Credentials);
internal sealed record CommandResult(int ExitCode, string StandardOutput, string StandardError);

internal sealed class ServiceCoordinator
{
    private readonly string _root;
    private readonly string _composeFile;
    private bool _environmentCreatedOnLaunch;
    private readonly Func<IReadOnlyList<string>, string?, TimeSpan, CancellationToken, Task<CommandResult>>? _commandRunner;
    private static readonly string[] ServiceIds =
    [
        "identity-db", "academic-db", "registration-db",
        "identity-service", "academic-service", "registration-service", "api-gateway", "web",
    ];

    public ServiceCoordinator() : this(FindRepositoryRoot()) { }

    internal ServiceCoordinator(string root, Func<IReadOnlyList<string>, string?, TimeSpan, CancellationToken, Task<CommandResult>>? commandRunner = null)
    {
        _root = root;
        _commandRunner = commandRunner;
        _composeFile = Path.Combine(_root, "compose.yaml");
        // The UI reads WEB_PORT while it is being built, before StartAllAsync runs.
        // Create the ignored local .env on a fresh clone before any UI code reads it.
        _environmentCreatedOnLaunch = PrepareEnvironment();
    }

    public string RepositoryRoot => _root;
    public string WebHostPort => int.TryParse(ReadEnvValue("WEB_PORT"), out var port) && port is > 0 and <= 65535 ? port.ToString() : "5173";

    public async Task<StackStartResult> StartAllAsync(bool forceBuild, IProgress<string> progress, CancellationToken cancellationToken)
    {
        var envChanged = _environmentCreatedOnLaunch || PrepareEnvironment();
        _environmentCreatedOnLaunch = false;
        progress.Report(envChanged ? "Đã tạo cấu hình cục bộ và sinh khóa bảo mật riêng." : "Đã giữ cấu hình hiện có.");
        await EnsureDockerAsync(progress, cancellationToken);

        var existing = await GetServiceStatusesAsync(cancellationToken);
        var webAlreadyAvailable = await IsProjectWebAlreadyAvailableAsync(cancellationToken);
        var webContainer = existing.FirstOrDefault(service => service.Id == "web");
        var externalWeb = webAlreadyAvailable && (webContainer is null || webContainer.External);
        if (externalWeb)
        {
            progress.Report($"Đang dùng giao diện dự án đã chạy tại cổng {WebHostPort}; giữ nguyên tiến trình hiện tại.");
        }
        var targets = externalWeb ? ServiceIds.Where(id => id != "web").ToArray() : ServiceIds;
        // Cached builds include new source after git pull. The explicit rebuild
        // action also discards cached build layers, without removing data volumes.
        if (forceBuild)
        {
            progress.Report("Đang dựng sạch image; dữ liệu database được giữ nguyên…");
            await RunComposeAsync(["build", "--no-cache", .. targets], null, TimeSpan.FromMinutes(20), cancellationToken);
        }
        progress.Report("Đang cập nhật image từ mã dự án và bật các dịch vụ…");
        var args = new List<string> { "up", "-d", "--build" };
        args.AddRange(targets);
        await RunComposeAsync(args, null, TimeSpan.FromMinutes(20), cancellationToken);
        await WaitUntilHealthyAsync(progress, externalWeb, cancellationToken);

        progress.Report("Đang kiểm tra tài khoản quản trị ban đầu…");
        var (adminMessage, credentials) = await EnsureFirstAdminAsync(cancellationToken);
        return new StackStartResult(true, adminMessage, credentials);
    }

    public async Task SetServiceAsync(string serviceId, bool start, CancellationToken cancellationToken)
    {
        if (!ServiceIds.Contains(serviceId, StringComparer.Ordinal)) throw new ArgumentOutOfRangeException(nameof(serviceId));
        if (serviceId == "web" && await IsProjectWebAlreadyAvailableAsync(cancellationToken)
            && (await GetServiceStatusesAsync(cancellationToken)).Any(service => service.Id == "web" && service.External))
            throw new InvalidOperationException($"Giao diện dự án đang được chạy bên ngoài Docker tại http://localhost:{WebHostPort}; trình quản lý sẽ không dừng hoặc thay thế tiến trình đó.");
        await RunComposeAsync(start ? ["up", "-d", "--no-deps", serviceId] : ["stop", serviceId], null, TimeSpan.FromMinutes(5), cancellationToken);
    }

    public async Task StopAllAsync(CancellationToken cancellationToken) =>
        await RunComposeAsync(["stop", .. ServiceIds], null, TimeSpan.FromMinutes(5), cancellationToken);

    public async Task<string> GetServiceLogsAsync(string serviceId, CancellationToken cancellationToken)
    {
        if (!ServiceIds.Contains(serviceId, StringComparer.Ordinal)) throw new ArgumentOutOfRangeException(nameof(serviceId));
        var result = await RunComposeAsync(["logs", "--no-color", "--tail", "80", serviceId], null, TimeSpan.FromSeconds(15), cancellationToken);
        return Redact((result.StandardOutput + result.StandardError).Trim());
    }

    public async Task<IReadOnlyList<ServiceStatus>> GetServiceStatusesAsync(CancellationToken cancellationToken)
    {
            var result = await RunComposeAsync(["ps", "--all", "--format", "json"], null, TimeSpan.FromSeconds(8), cancellationToken);
            var containers = ParseContainers(result.StandardOutput);
            var statuses = BuildStatuses(containers);
            if (await IsProjectWebAlreadyAvailableAsync(cancellationToken))
            {
                var webIsManaged = containers.Any(container => GetString(container, "Service", "service") == "web"
                    && container.TryGetProperty("Publishers", out var publishers)
                    && publishers.ValueKind == JsonValueKind.Array
                    && publishers.EnumerateArray().Any(publisher => publisher.TryGetProperty("PublishedPort", out var port)
                        && port.ToString() == WebHostPort));
                if (!webIsManaged)
                    statuses = statuses.Select(service => service.Id == "web"
                        ? service with { Running = true, Health = "external", External = true }
                        : service).ToArray();
            }
            return statuses;
    }

    public async Task<bool> IsDockerAvailableAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await RunDockerAsync(["info", "--format", "{{.ServerVersion}}"], null, TimeSpan.FromSeconds(5), cancellationToken);
            return result.ExitCode == 0;
        }
        catch { return false; }
    }

    private static string FindRepositoryRoot()
    {
        var candidates = new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory };
        foreach (var candidate in candidates)
        {
            var current = new DirectoryInfo(candidate);
            while (current is not null)
            {
                if (File.Exists(Path.Combine(current.FullName, "compose.yaml")) && File.Exists(Path.Combine(current.FullName, ".env.docker.example")))
                    return current.FullName;
                current = current.Parent;
            }
        }
        throw new DirectoryNotFoundException("Không tìm thấy thư mục dự án có compose.yaml. Hãy chạy trình quản lý từ thư mục dự án.");
    }

    private bool PrepareEnvironment()
    {
        var envPath = Path.Combine(_root, ".env");
        var created = !File.Exists(envPath);
        var content = File.Exists(envPath)
            ? File.ReadAllText(envPath)
            : File.ReadAllText(Path.Combine(_root, ".env.docker.example"));
        var changed = created;

        ReplacePlaceholder("POSTGRES_PASSWORD", 30);
        ReplacePlaceholder("JWT_SECRET", 48);
        ReplacePlaceholder("TOTP_ENCRYPTION_KEY", 48);
        ReplacePlaceholder("INTERNAL_SERVICE_SECRET", 48);

        if (changed) File.WriteAllText(envPath, content, new System.Text.UTF8Encoding(false));
        return changed;

        void ReplacePlaceholder(string name, int bytes)
        {
            var match = Regex.Match(content, $"^{Regex.Escape(name)}=(.*)$", RegexOptions.Multiline);
            if (match.Success && !created && !string.IsNullOrWhiteSpace(match.Groups[1].Value)
                && !match.Groups[1].Value.StartsWith("local-", StringComparison.Ordinal)
                && !match.Groups[1].Value.StartsWith("replace-with", StringComparison.Ordinal)) return;
            var value = Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            content = match.Success
                ? Regex.Replace(content, $"^{Regex.Escape(name)}=.*$", $"{name}={value}", RegexOptions.Multiline)
                : content.TrimEnd() + Environment.NewLine + $"{name}={value}" + Environment.NewLine;
            changed = true;
        }
    }

    private async Task EnsureDockerAsync(IProgress<string> progress, CancellationToken cancellationToken)
    {
        var info = await TryDockerInfoAsync(cancellationToken);
        if (info.Available) return;
        var desktop = FindDockerDesktop();
        var desktopRunning = IsDockerDesktopRunning();
        if (!desktopRunning && desktop is not null)
        {
            progress.Report("Docker Desktop chưa mở; đang tự khởi động ứng dụng…");
            try
            {
                Process.Start(new ProcessStartInfo(desktop) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
                desktopRunning = true;
            }
            catch (Exception error)
            {
                throw new InvalidOperationException($"Không mở được Docker Desktop tại {desktop}. Hãy mở Docker Desktop rồi chọn Thử lại.", error);
            }
        }

        info = await TryDockerInfoAsync(cancellationToken);
        if (info.Available) return;
        if (IsManuallyPaused(info.Error))
            throw new InvalidOperationException("Docker Desktop đang tạm dừng. Hãy chọn biểu tượng cá voi Docker ở khay hệ thống, bỏ tạm dừng, rồi bấm Thử lại.");
        if (!desktopRunning && desktop is null)
            throw new InvalidOperationException("Không tìm thấy Docker Desktop. Hãy cài Docker Desktop, mở ứng dụng một lần, rồi bấm Thử lại.");

        progress.Report("Đang chờ Docker Desktop khởi động engine…");
        for (var attempt = 0; attempt < 180; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            info = await TryDockerInfoAsync(cancellationToken);
            if (info.Available) return;
            if (IsManuallyPaused(info.Error))
                throw new InvalidOperationException("Docker Desktop đang tạm dừng. Hãy bỏ tạm dừng từ biểu tượng Docker trên khay hệ thống, rồi bấm Thử lại.");
            if (attempt % 10 == 9) progress.Report($"Đang chờ Docker Desktop sẵn sàng… ({(attempt + 1) * 2} giây)");
        }
        throw new InvalidOperationException("Docker Desktop chưa sẵn sàng sau thời gian chờ. Mở Docker Desktop rồi bấm Thử lại.");
    }

    private async Task<(bool Available, string Error)> TryDockerInfoAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await RunDockerAsync(["info", "--format", "{{.ServerVersion}}"], null, TimeSpan.FromSeconds(5), cancellationToken);
            return (result.ExitCode == 0, result.StandardError + result.StandardOutput);
        }
        catch (Exception error) { return (false, error.Message); }
    }

    private static bool IsManuallyPaused(string message) => message.Contains("manually paused", StringComparison.OrdinalIgnoreCase)
        || message.Contains("tạm dừng thủ công", StringComparison.OrdinalIgnoreCase);

    private static string? FindDockerDesktop()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "Docker Desktop.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "frontend", "Docker Desktop.exe"),
            Path.Combine(localAppData, "Programs", "Docker", "Docker", "Docker Desktop.exe"),
            Path.Combine(localAppData, "Programs", "DockerDesktop", "Docker Desktop.exe"),
            Path.Combine(localAppData, "Programs", "DockerDesktop", "frontend", "Docker Desktop.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private static bool IsDockerDesktopRunning()
    {
        foreach (var process in Process.GetProcessesByName("Docker Desktop"))
        {
            using (process)
            {
                try { if (!process.HasExited) return true; }
                catch (InvalidOperationException) { }
            }
        }
        return false;
    }

    private async Task WaitUntilHealthyAsync(IProgress<string> progress, bool externalWeb, CancellationToken cancellationToken)
    {
        progress.Report("Đang chờ database, domain service, Gateway và giao diện khỏe…");
        var pending = "";
        for (var attempt = 0; attempt < 150; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var statuses = await GetServiceStatusesAsync(cancellationToken);
                var waiting = statuses.Where(service => (!externalWeb || service.Id != "web")
                    && (!service.Running || !service.Health.Equals("healthy", StringComparison.OrdinalIgnoreCase))).ToArray();
                if (waiting.Length == 0) return;
                pending = string.Join(", ", waiting.Select(service => service.Name));
                if (attempt % 5 == 0) progress.Report($"Đang chờ: {pending}.");
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                pending = error.Message;
            }
            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
        }
        throw new InvalidOperationException($"Các dịch vụ chưa sẵn sàng sau thời gian chờ: {pending}. Xem nhật ký dịch vụ rồi chọn Thử lại.");
    }

    private async Task<(string Message, InitialAdmin? Credentials)> EnsureFirstAdminAsync(CancellationToken cancellationToken)
    {
        var password = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var payload = JsonSerializer.Serialize(new { username = "admin.demo", name = "Quản trị viên demo", temporaryPassword = password });
        var result = await RunComposeAsync(
            ["exec", "-T", "identity-service", "node", "scripts/create-admin.js", "--stdin"],
            payload,
            TimeSpan.FromSeconds(60),
            cancellationToken);
        using var json = JsonDocument.Parse(result.StandardOutput.Trim());
        var root = json.RootElement;
        if (root.TryGetProperty("created", out var created) && created.GetBoolean())
        {
            var username = root.GetProperty("username").GetString() ?? "admin.demo";
            var temporaryPassword = root.GetProperty("temporaryPassword").GetString() ?? password;
            var webPort = WebHostPort;
            return ("Đã tạo tài khoản quản trị đầu tiên.", new InitialAdmin(username, temporaryPassword, $"http://localhost:{webPort}/admin"));
        }
        return ("Database đã có quản trị viên; tài khoản hiện có được giữ nguyên.", null);
    }

    private string? ReadEnvValue(string name)
    {
        var path = Path.Combine(_root, ".env");
        if (!File.Exists(path)) return null;
        var line = File.ReadLines(path).FirstOrDefault(value => value.TrimStart().StartsWith(name + "=", StringComparison.Ordinal));
        return line is null ? null : line[(line.IndexOf('=') + 1)..].Trim().Trim('"', '\'');
    }

    private async Task<CommandResult> RunComposeAsync(IReadOnlyList<string> arguments, string? input, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var allArguments = new List<string> { "compose", "--profile", "soa", "-f", _composeFile };
        allArguments.AddRange(arguments);
        var result = await RunDockerAsync(allArguments, input, timeout, cancellationToken);
        if (result.ExitCode != 0) throw new InvalidOperationException(FormatDockerError(result));
        return result;
    }

    private async Task<CommandResult> RunDockerAsync(IReadOnlyList<string> arguments, string? input, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (_commandRunner is not null) return await _commandRunner(arguments, input, timeout, cancellationToken);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = FindDockerCli(),
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = input is not null,
            },
        };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Không thể khởi chạy Docker CLI.");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new InvalidOperationException("Không tìm thấy Docker CLI. Cài Docker Desktop rồi thử lại.");
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        if (input is not null)
        {
            await process.StandardInput.WriteAsync(input.AsMemory(), cancellationToken);
            process.StandardInput.Close();
        }

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try { await process.WaitForExitAsync(timeoutSource.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            if (cancellationToken.IsCancellationRequested) throw;
            throw new TimeoutException("Docker thao tác quá thời gian chờ.");
        }

        return new CommandResult(process.ExitCode, await stdoutTask, await stderrTask);
    }

    private string FormatDockerError(CommandResult result)
    {
        var detail = Redact((result.StandardError + "\n" + result.StandardOutput).Trim());
        if (IsManuallyPaused(detail)) return "Docker Desktop đang tạm dừng. Hãy bỏ tạm dừng từ biểu tượng Docker trên khay hệ thống rồi thử lại.";
        if (detail.Contains("port is already allocated", StringComparison.OrdinalIgnoreCase)
            || detail.Contains("address already in use", StringComparison.OrdinalIgnoreCase))
            return "Một dịch vụ khác đang sử dụng cổng cần thiết. Đóng dịch vụ đó hoặc đổi cổng trong file .env rồi thử lại.";
        var jsonError = TryGetJsonError(detail);
        if (jsonError is not null) return jsonError;
        return string.IsNullOrWhiteSpace(detail) ? "Docker Compose không thực hiện được thao tác." : detail;
    }

    private static string? TryGetJsonError(string detail)
    {
        foreach (var line in detail.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                using var document = JsonDocument.Parse(line.Trim());
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("error", out var error)
                    && error.ValueKind == JsonValueKind.String)
                    return error.GetString();
            }
            catch (JsonException) { }
        }
        return null;
    }

    private static IReadOnlyList<JsonElement> ParseContainers(string output)
    {
        var text = output.Trim();
        if (text.Length == 0) return [];
        try
        {
            using var document = JsonDocument.Parse(text);
            if (document.RootElement.ValueKind == JsonValueKind.Array) return document.RootElement.EnumerateArray().Select(element => element.Clone()).ToArray();
            if (document.RootElement.ValueKind == JsonValueKind.Object) return [document.RootElement.Clone()];
        }
        catch (JsonException) { }

        var rows = new List<JsonElement>();
        foreach (var line in text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                if (document.RootElement.ValueKind == JsonValueKind.Object) rows.Add(document.RootElement.Clone());
            }
            catch (JsonException) { }
        }
        return rows;
    }

    private IReadOnlyList<ServiceStatus> BuildStatuses(IReadOnlyList<JsonElement> containers)
    {
        return ServiceIds.Select(id =>
        {
            var found = containers.Where(container => GetString(container, "Service", "service") == id).ToList();
            var running = found.Any(container => GetString(container, "State", "state").Equals("running", StringComparison.OrdinalIgnoreCase));
            var active = found.FirstOrDefault(container => GetString(container, "State", "state").Equals("running", StringComparison.OrdinalIgnoreCase));
            var health = active.ValueKind == JsonValueKind.Object ? GetString(active, "Health", "health") : "stopped";
            if (string.IsNullOrWhiteSpace(health)) health = running ? "running" : "stopped";
            var display = id switch
            {
                "identity-db" => ("Cơ sở dữ liệu định danh", "NỘI BỘ · 5432"),
                "academic-db" => ("Cơ sở dữ liệu học vụ", "NỘI BỘ · 5432"),
                "registration-db" => ("Cơ sở dữ liệu đăng ký", "NỘI BỘ · 5432"),
                "identity-service" => ("Dịch vụ tài khoản", "NỘI BỘ · 3101"),
                "academic-service" => ("Dịch vụ học vụ", "NỘI BỘ · 3102"),
                "registration-service" => ("Dịch vụ đăng ký", "NỘI BỘ · 3103"),
                "api-gateway" => ("Cổng API", "NỘI BỘ · 3100"),
                _ => ("Giao diện web", $"{WebHostPort} → 80"),
            };
            return new ServiceStatus(id, display.Item1, display.Item2, running, health, found.Count);
        }).ToArray();
    }

    private async Task<bool> IsProjectWebAlreadyAvailableAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync($"http://localhost:{WebHostPort}/api/ready", cancellationToken);
            if (!response.IsSuccessStatusCode) return false;
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            return body.RootElement.TryGetProperty("status", out var status)
                && status.GetString() == "ready";
        }
        catch { return false; }
    }

    private static string GetString(JsonElement item, params string[] names)
    {
        foreach (var name in names)
        {
            if (item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                return value.GetString() ?? string.Empty;
        }
        return string.Empty;
    }

    private string Redact(string message)
    {
        foreach (var key in new[] { "POSTGRES_PASSWORD", "JWT_SECRET", "TOTP_ENCRYPTION_KEY", "INTERNAL_SERVICE_SECRET" })
        {
            var value = ReadEnvValue(key);
            if (!string.IsNullOrWhiteSpace(value)) message = message.Replace(value, "[đã ẩn]", StringComparison.Ordinal);
        }
        return message;
    }

    private static string FindDockerCli()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "resources", "bin", "docker.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Docker", "Docker", "resources", "bin", "docker.exe"),
        };
        return candidates.FirstOrDefault(File.Exists) ?? "docker";
    }
}

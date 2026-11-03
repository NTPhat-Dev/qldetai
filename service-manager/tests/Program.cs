using System.Text.Json;
using Qldetai.ServiceManager;

internal static class Program
{
    private static int _checks;
    [STAThread]
    private static void Main(string[] args)
    {
        var originalDirectory = Directory.GetCurrentDirectory();
        var root = Path.Combine(Path.GetTempPath(), "qldetai-manager-check-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "compose.yaml"), "services: {}\n");
            File.WriteAllText(Path.Combine(root, ".env.docker.example"), "POSTGRES_PASSWORD=local-test\nTOTP_ENCRYPTION_KEY=local-test\nWEB_PORT=65520\n");
            CheckCoordinatorAsync(root).GetAwaiter().GetResult();
            if (args.Contains("--render")) Render(root);
            Console.WriteLine($"PASS: {_checks} service-manager checks");
        }
        finally { Directory.SetCurrentDirectory(originalDirectory); Directory.Delete(root, true); }
    }

    private static async Task CheckCoordinatorAsync(string root)
    {
        var calls = new List<string[]>();
        var statusFailure = false;
        var arrayOutput = false;
        var secret = "";
        var ids = new[] { "identity-db", "academic-db", "registration-db", "identity-service", "academic-service", "registration-service", "api-gateway", "web" };
        var rows = ids.Select(id => new { Service = id, State = "running", Health = "healthy", Publishers = new[] { new { PublishedPort = 65520 } } });
        Task<CommandResult> Run(IReadOnlyList<string> args, string? input, TimeSpan timeout, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            calls.Add(args.ToArray());
            if (args[0] == "info") return Task.FromResult(new CommandResult(0, "29.0", ""));
            if (args.Contains("ps"))
            {
                if (statusFailure) return Task.FromResult(new CommandResult(1, "", "Docker disconnected"));
                var output = arrayOutput ? JsonSerializer.Serialize(rows) : string.Join("\n", rows.Select(row => JsonSerializer.Serialize(row))) + "\n";
                return Task.FromResult(new CommandResult(0, output, ""));
            }
            if (args.Contains("logs")) return Task.FromResult(new CommandResult(0, "diagnostic " + secret, ""));
            if (args.Contains("exec")) return Task.FromResult(new CommandResult(0, "{\"created\":false}", ""));
            return Task.FromResult(new CommandResult(0, "", ""));
        }
        var coordinator = new ServiceCoordinator(root, Run);
        var envPath = Path.Combine(root, ".env");
        var env = File.ReadAllText(envPath);
        Assert(env.Contains("INTERNAL_IDENTITY_PRIVATE_KEY=") && env.Contains("INTERNAL_IDENTITY_PUBLIC_KEY=")
            && env.Contains("INTERNAL_ACADEMIC_PRIVATE_KEY=") && env.Contains("INTERNAL_REGISTRATION_PRIVATE_KEY=")
            && env.Contains("INTERNAL_GATEWAY_PRIVATE_KEY="), "Generate distinct service key pairs");
        Assert(!env.Contains("local-test"), "Generate unique first-launch secrets");
        _ = new ServiceCoordinator(root, Run);
        Assert(File.ReadAllText(envPath) == env, "Preserve configured secrets on next launch");
        secret = env.Split('\n').Single(line => line.StartsWith("INTERNAL_IDENTITY_PRIVATE_KEY="))["INTERNAL_IDENTITY_PRIVATE_KEY=".Length..].Trim();
        Assert(coordinator.WebHostPort == "65520", "Read configured web port");
        var statuses = await coordinator.GetServiceStatusesAsync(default);
        Assert(statuses.Count == 8 && statuses.All(service => service.Running && service.Health == "healthy"), "Parse JSON-lines status output");
        arrayOutput = true;
        Assert((await coordinator.GetServiceStatusesAsync(default)).Count == 8, "Parse array status output");
        await coordinator.SetServiceAsync("academic-service", true, default);
        Assert(calls.Last().TakeLast(4).SequenceEqual(new[] { "up", "-d", "--no-deps", "academic-service" }), "Starting one service does not restart dependencies");
        await coordinator.SetServiceAsync("academic-service", false, default);
        Assert(calls.Last().TakeLast(2).SequenceEqual(new[] { "stop", "academic-service" }), "Stop only selected service");
        await coordinator.StopAllAsync(default);
        Assert(calls.Last().TakeLast(9).SequenceEqual(new[] { "stop" }.Concat(ids)), "Stop all keeps volumes and explicit project services");
        var logs = await coordinator.GetServiceLogsAsync("identity-service", default);
        Assert(!logs.Contains(secret) && logs.Contains("[đã ẩn]"), "Redact configured secrets in logs");
        try { await coordinator.SetServiceAsync("not-project-service", true, default); throw new Exception("Expected validation"); }
        catch (ArgumentOutOfRangeException) { _checks++; }
        statusFailure = true;
        try { await coordinator.GetServiceStatusesAsync(default); throw new Exception("Expected failure"); }
        catch (InvalidOperationException error) when (error.Message.Contains("disconnected")) { _checks++; }
        statusFailure = false;
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try { await coordinator.GetServiceLogsAsync("web", cancelled.Token); throw new Exception("Expected cancellation"); }
        catch (OperationCanceledException) { _checks++; }
        await coordinator.StartAllAsync(true, new Progress<string>(), default);
        Assert(calls.Any(args => args.Contains("build") && args.Contains("--no-cache")), "Rebuild action bypasses image cache");
        Assert(!calls.Any(args => args.Contains("rm") || args.Contains("down") || args.Contains("--volumes")), "No destructive container or volume cleanup");
    }

    private static void Render(string root)
    {
        Directory.SetCurrentDirectory(root);
        ApplicationConfiguration.Initialize();
        using var form = new MainForm(false);
        Console.WriteLine($"UI before show: {form.Size}, auto: {form.AutoSize}, scale: {form.AutoScaleDimensions}");
        form.Show();
        Application.DoEvents();
        Console.WriteLine($"UI size: {form.Size}, minimum: {form.MinimumSize}, DPI: {form.DeviceDpi}, state: {form.WindowState}");
        var output = Path.Combine(Path.GetTempPath(), "qldetai-manager-preview.png");
        using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, form.ClientRectangle); bitmap.Save(output); }
        form.WindowState = FormWindowState.Normal;
        form.Size = form.MinimumSize;
        Application.DoEvents();
        using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, form.ClientRectangle); bitmap.Save(Path.Combine(Path.GetTempPath(), "qldetai-manager-preview-small.png")); }
        Console.WriteLine("Preview: " + output);
        form.Close();
    }

    private static void Assert(bool passed, string message)
    {
        if (!passed) throw new InvalidOperationException(message);
        _checks++;
        Console.WriteLine("PASS " + message);
    }
}

using System.Diagnostics;
using System.Net.Http;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;

namespace SakuraAIGateway.WebView2;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new GatewayForm());
    }
}

internal sealed class GatewayForm : Form
{
    private int port;
    private readonly Microsoft.Web.WebView2.WinForms.WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly Label status = new()
    {
        Dock = DockStyle.Fill,
        Text = "正在启动 Sakura-AI-Gateway…",
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 14),
        ForeColor = Color.FromArgb(237, 243, 239),
        BackColor = Color.FromArgb(16, 19, 21)
    };
    private Process? gateway;
    private readonly object logLock = new();
    private string logPath = "";
    private string SettingsPath => Path.Combine(DesktopData.Prepare(), "desktop-port-settings.json");

    public GatewayForm()
    {
        Text = "Sakura-AI-Gateway · Edge WebView2";
        Width = 1220;
        Height = 860;
        MinimumSize = new Size(880, 620);
        Controls.Add(webView);
        Controls.Add(status);
        var menu = new MenuStrip();
        var settings = new ToolStripMenuItem("设置");
        settings.DropDownItems.Add("端口设置…", null, (_, _) => ShowPortSettings());
        menu.Items.Add(settings);
        MainMenuStrip = menu;
        Controls.Add(menu);
        menu.BringToFront();
        status.BringToFront();
        Shown += async (_, _) => await StartAsync();
        FormClosing += (_, _) => StopGateway();
    }

    private async Task StartAsync()
    {
        try
        {
            var portSettings = ReadPortSettings();
            if (portSettings.Mode == "fixed" && !await IsPortAvailableAsync(portSettings.Port))
                throw new InvalidOperationException($"固定端口 {portSettings.Port} 已被占用，请更换端口或切换为随机端口。");
            port = portSettings.Mode == "fixed" ? portSettings.Port : await FindFreePortAsync();
            string root = AppContext.BaseDirectory;
            string node = Path.Combine(root, "runtime", "node.exe");
            string gatewayRoot = Path.Combine(root, "gateway");
            string entry = Path.Combine(gatewayRoot, "src", "server.js");
            if (!File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException("客户端缺少 Node.js 运行时或网关文件。");
            string appData = DesktopData.Prepare();
            string data = Path.Combine(appData, "gateway-data");
            Directory.CreateDirectory(data);
            logPath = Path.Combine(appData, "gateway.log");
            var start = new ProcessStartInfo(node, $"\"{entry}\"")
            {
                WorkingDirectory = gatewayRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.Environment["HOST"] = "127.0.0.1";
            start.Environment["PORT"] = port.ToString();
            start.Environment["SAKURA_AI_GATEWAY_FORCE_HOST"] = "127.0.0.1";
            start.Environment["SAKURA_AI_GATEWAY_FORCE_PORT"] = port.ToString();
            start.Environment["SAKURA_AI_GATEWAY_FORCE_SETTINGS"] = "true";
            start.Environment["SAKURA_AI_GATEWAY_DATA_DIR"] = data;
            gateway = Process.Start(start) ?? throw new InvalidOperationException("无法启动本地网关进程。");
            gateway.EnableRaisingEvents = true;
            gateway.Exited += (_, _) =>
            {
                if (gateway.ExitCode != 0 && IsHandleCreated)
                    BeginInvoke(() => status.Text = $"Sakura-AI-Gateway 启动失败\n\n网关子进程已退出（代码 {gateway.ExitCode}）。\n\n请查看：\n{logPath}");
            };
            gateway.OutputDataReceived += (_, args) => AppendLog(args.Data);
            gateway.ErrorDataReceived += (_, args) => AppendLog(args.Data);
            gateway.BeginOutputReadLine();
            gateway.BeginErrorReadLine();
            await WaitForGatewayAsync();
            string webData = Path.Combine(appData, "webview2");
            var environment = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, webData);
            await webView.EnsureCoreWebView2Async(environment);
            status.Visible = false;
            webView.CoreWebView2.Navigate($"http://127.0.0.1:{port}/");
        }
        catch (Exception error)
        {
            status.Text = $"Sakura-AI-Gateway 启动失败\n\n{error.Message}\n\n请确认客户端文件完整，并查看：\n{logPath}";
        }
    }

    private static async Task<int> FindFreePortAsync()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int selected = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        await Task.Yield();
        return selected;
    }

    private static async Task<bool> IsPortAvailableAsync(int candidate)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Loopback, candidate);
            listener.Start();
            listener.Stop();
            await Task.Yield();
            return true;
        }
        catch (SocketException) { return false; }
    }

    private PortSettings ReadPortSettings()
    {
        try
        {
            var value = JsonSerializer.Deserialize<PortSettings>(File.ReadAllText(SettingsPath));
            if (value is not null && value.Port is >= 1 and <= 65535)
                return new PortSettings(value.Mode == "fixed" ? "fixed" : "random", value.Port);
        }
        catch { }
        return new PortSettings("random", 8787);
    }

    private void SavePortSettings(PortSettings value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
    }

    private void ShowPortSettings()
    {
        var current = ReadPortSettings();
        using var dialog = new Form { Text = "端口设置", Width = 380, Height = 245, StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var modeLabel = new Label { Text = "启动端口模式", Left = 24, Top = 22, AutoSize = true };
        var mode = new ComboBox { Left = 24, Top = 45, Width = 300, DropDownStyle = ComboBoxStyle.DropDownList };
        mode.Items.AddRange(new object[] { "每次启动随机端口", "固定自定义端口（推荐）" });
        mode.SelectedIndex = current.Mode == "fixed" ? 1 : 0;
        var portLabel = new Label { Text = "固定端口（1-65535）", Left = 24, Top = 82, AutoSize = true };
        var portBox = new NumericUpDown { Left = 24, Top = 105, Width = 140, Minimum = 1, Maximum = 65535, Value = current.Port };
        var hint = new Label { Text = "固定端口被占用时会显示错误，请选择其他端口。", Left = 24, Top = 140, AutoSize = true, ForeColor = Color.Gray };
        var save = new Button { Text = "保存并重启网关", Left = 185, Top = 168, Width = 140, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "取消", Left = 95, Top = 168, Width = 75, DialogResult = DialogResult.Cancel };
        dialog.Controls.AddRange(new Control[] { modeLabel, mode, portLabel, portBox, hint, cancel, save });
        dialog.AcceptButton = save;
        dialog.CancelButton = cancel;
        mode.SelectedIndexChanged += (_, _) => portBox.Enabled = mode.SelectedIndex == 1;
        portBox.Enabled = mode.SelectedIndex == 1;
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        SavePortSettings(new PortSettings(mode.SelectedIndex == 1 ? "fixed" : "random", (int)portBox.Value));
        StopGateway();
        status.Visible = true;
        status.Text = "正在应用端口设置…";
        _ = StartAsync();
    }

    private async Task WaitForGatewayAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
        for (int attempt = 0; attempt < 80; attempt++)
        {
            try { if ((await client.GetAsync($"http://127.0.0.1:{port}/health")).IsSuccessStatusCode) return; } catch { }
            await Task.Delay(250);
        }
        throw new TimeoutException("本地网关启动超时。");
    }

    private void StopGateway()
    {
        try { if (gateway is { HasExited: false }) gateway.Kill(true); } catch { }
        gateway?.Dispose();
    }

    private void AppendLog(string? line)
    {
        if (string.IsNullOrWhiteSpace(line) || string.IsNullOrWhiteSpace(logPath)) return;
        Debug.WriteLine(line);
        lock (logLock) File.AppendAllText(logPath, $"{line}{Environment.NewLine}");
    }

    private sealed record PortSettings(string Mode, int Port);
}
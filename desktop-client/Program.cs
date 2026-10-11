using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SakuraAIGateway.Client;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, @"Local\Sakura-AI-Gateway-Client", out bool createdNew);
        if (!createdNew) return;

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }    
}

sealed class MainForm : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly string _baseDirectory = AppContext.BaseDirectory;
    private readonly string _dataDirectory;
    private readonly string _logPath;
    private StreamWriter? _logWriter;
    private Process? _gatewayProcess;
    private int _port;
    private bool _closed;

    public MainForm()
    {
        string appData = DesktopData.Prepare();
        _dataDirectory = Path.Combine(appData, "gateway-data");
        _logPath = Path.Combine(appData, "gateway.log");

        Text = "Sakura-AI-Gateway";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1080, 700);
        Size = new Size(1440, 940);
        Controls.Add(_webView);
        Load += async void (_, _) => await InitializeAsync();
        FormClosed += (_, _) => ShutdownGateway();
    }

    private async Task InitializeAsync()
    {
        try
        {
            Directory.CreateDirectory(_dataDirectory);
            _logWriter = new StreamWriter(_logPath, append: true) { AutoFlush = true };
            _port = GetFreePort();
            StartGateway();
            await WaitForGatewayAsync();

            string webDataDirectory = Path.Combine(
                Path.GetDirectoryName(_dataDirectory)!,
                "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: webDataDirectory);
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.NewWindowRequested += (sender, e) =>
            {
                if (string.IsNullOrEmpty(e.Uri)) return;
                if (e.Uri?.StartsWith($"http://127.0.0.1:{_port}/", StringComparison.Ordinal) == true)
                    return;
                e.Handled = true;
                Process.Start(new ProcessStartInfo { FileName = e.Uri, UseShellExecute = true });
            };
            _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            _webView.CoreWebView2.Navigate($"http://127.0.0.1:{_port}/");
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"客户端启动失败：{error.Message}",
                "Sakura-AI-Gateway",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    private static int GetFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private void StartGateway()
    {
        string nodePath = Path.Combine(_baseDirectory, "node.exe");
        if (!File.Exists(nodePath)) nodePath = FindNodeOnPath();
        string serverEntry = Path.Combine(_baseDirectory, "src", "server.js");
        if (!File.Exists(nodePath)) throw new FileNotFoundException("找不到 node.exe。");
        if (!File.Exists(serverEntry)) throw new FileNotFoundException("找不到内置网关服务。");

        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{serverEntry}\"",
            WorkingDirectory = _baseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        startInfo.EnvironmentVariables["SAKURA_AI_GATEWAY_DATA_DIR"] = _dataDirectory;
        startInfo.EnvironmentVariables["SAKURA_AI_GATEWAY_FORCE_HOST"] = "127.0.0.1";
        startInfo.EnvironmentVariables["SAKURA_AI_GATEWAY_FORCE_PORT"] = _port.ToString();

        _gatewayProcess = new Process { StartInfo = startInfo };
        _gatewayProcess.OutputDataReceived += (_, e) => { if (e.Data != null) _logWriter?.WriteLine(e.Data); };
        _gatewayProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) _logWriter?.WriteLine(e.Data); };
        _gatewayProcess.Start();
        _gatewayProcess.BeginOutputReadLine();
        _gatewayProcess.BeginErrorReadLine();
    }

    private static string FindNodeOnPath()
    {
        string? path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path)) return "node.exe";

        foreach (string directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                string candidate = Path.Combine(directory.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException)
            {
            }
        }
        return "node.exe";
    }

    private async Task WaitForGatewayAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (!timeout.IsCancellationRequested)
        {
            if (_gatewayProcess is { HasExited: true })
                throw new InvalidOperationException($"内置网关进程退出（代码 {_gatewayProcess.ExitCode}）。");

            try
            {
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
                using HttpResponseMessage response = await client.GetAsync(
                    $"http://127.0.0.1:{_port}/",
                    timeout.Token);
                if (response.IsSuccessStatusCode) return;
            }
            catch (Exception error) when (
                error is HttpRequestException
                or TaskCanceledException
                or SocketException)
            {
            }

            await Task.Delay(100, timeout.Token);
        }

        throw new TimeoutException("内置网关启动超时。");
    }

    private void ShutdownGateway()
    {
        if (_closed) return;
        _closed = true;

        try
        {
            if (_gatewayProcess is { HasExited: false })
            {
                _gatewayProcess.Kill(entireProcessTree: true);
                _gatewayProcess.WaitForExit(3000);
            }
        }
        catch
        {
        }
        finally
        {
            _gatewayProcess?.Dispose();
            _logWriter?.Dispose();
        }
    }
}

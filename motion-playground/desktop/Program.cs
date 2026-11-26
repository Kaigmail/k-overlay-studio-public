using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("K-Overlay-Studio")]
[assembly: System.Reflection.AssemblyProduct("K-Overlay-Studio")]

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            string bin = AppDomain.CurrentDomain.BaseDirectory;
            foreach (string file in new[] { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" })
                if (!File.Exists(Path.Combine(bin, file)))
                    throw new InvalidOperationException("缺少 " + file + "，请重新运行 npm run build:desktop。");
            Launch(args, bin);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "K-Overlay-Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void Launch(string[] args, string bin)
    {
        string root = Path.GetFullPath(Path.Combine(bin, "..", ".."));
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "K-Overlay-Studio");
        int debugPort = 0;
        if (args.Length != 0)
        {
            if (args.Length != 3 || args[0] != "--verify" || !Path.IsPathRooted(args[1])
                || !int.TryParse(args[2], out debugPort) || debugPort < 0 || (debugPort > 0 && debugPort < 1024)
                || debugPort > 65535 || debugPort == 5177)
                throw new ArgumentException("桌面验收参数不正确。");
            profile = Path.Combine(Path.GetFullPath(args[1]), "test-profile");
        }
        string key;
        using (var sha = SHA256.Create())
            key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(profile.ToUpperInvariant()))).Replace("-", "");

        using (var wake = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\K-Overlay-Studio-wake-" + key))
        using (var mutex = new Mutex(false, @"Local\K-Overlay-Studio-" + key))
        {
            bool first;
            try { first = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { first = true; }
            if (!first)
            {
                AllowSetForegroundWindow(-1);
                wake.Set();
                return;
            }
            try
            {
                using (var window = new DesktopWindow(root, profile, debugPort, wake))
                    Application.Run(window);
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int processId);
}

sealed class DesktopWindow : Form
{
    const string Home = "http://localhost:5177/";
    readonly string root, profile, settings, work, session;
    readonly int debugPort;
    readonly EventWaitHandle wake;
    readonly Label status;
    readonly HttpClient http;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly TaskCompletionSource<bool> listening = new TaskCompletionSource<bool>();
    readonly StringBuilder serviceErrors = new StringBuilder();
    readonly System.Windows.Forms.Timer timer;
    ProcessJob job;
    Process server;
    WebView2 view;
    bool ready, restoring, restored, picking, closing, finished;

    public DesktopWindow(string root, string profile, int debugPort, EventWaitHandle wake)
    {
        this.root = root;
        this.profile = profile;
        this.debugPort = debugPort;
        this.wake = wake;
        settings = Path.Combine(profile, "last-export-directory.txt");
        session = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        work = Path.Combine(root, "exports", ".desktop-" + session.Substring(0, 32));
        http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false });
        http.BaseAddress = new Uri(Home);
        http.Timeout = TimeSpan.FromSeconds(12);
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session);
        http.DefaultRequestHeaders.ConnectionClose = true;
        http.DefaultRequestHeaders.ExpectContinue = false;

        Text = "K-Overlay-Studio";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        var display = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(1320, display.Width - 32), Math.Min(840, display.Height - 32));
        MinimumSize = new Size(790, 590);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(24, 28, 41);
        status = new Label {
            Text = "正在启动 K-Overlay-Studio…", ForeColor = Color.White, Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter, Padding = new Padding(24), UseMnemonic = false,
        };
        Controls.Add(status);
        timer = new System.Windows.Forms.Timer { Interval = 250 };
        timer.Tick += PollWindow;
        timer.Start();
        Shown += StartEditor;
        FormClosing += CloseEditor;
    }

    void PollWindow(object sender, EventArgs args)
    {
        if (wake.WaitOne(0))
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            SetForegroundWindow(Handle);
        }
        if (ready && !closing && server != null && server.HasExited)
            ShowProblem("本地服务已退出。请关闭窗口后重新打开编辑台。");
    }

    async void StartEditor(object sender, EventArgs args)
    {
        try
        {
            if (!File.Exists(Path.Combine(root, "desktop", "server.mjs")))
                throw new InvalidOperationException("找不到编辑台项目。请从构建生成的 desktop/bin 目录打开 EXE。");
            if (IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(endpoint => endpoint.Port == 5177))
                throw new InvalidOperationException("本地端口 5177 已被其他程序占用。请先关闭正在使用该端口的程序，再重新打开编辑台。");
            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException)
            {
                throw new InvalidOperationException("缺少 Microsoft Edge WebView2 Runtime，请安装后重新打开编辑台。");
            }

            Directory.CreateDirectory(profile);
            Directory.CreateDirectory(work);
            job = new ProcessJob();
            StartService();
            if (await Task.WhenAny(listening.Task, Task.Delay(45000)) != listening.Task || !await listening.Task)
                throw new InvalidOperationException("无法启动本地编辑服务。\r\n" + ReadErrors());
            if (finished || closing) return;
            var identity = await Request("api/desktop-session");
            if (Convert.ToInt32(identity["pid"]) != server.Id)
                throw new InvalidOperationException("无法确认本地服务属于本次启动。请检查端口 5177。");
            if (finished || closing) return;

            Environment.SetEnvironmentVariable("WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER", null);
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", null);
            var options = new CoreWebView2EnvironmentOptions();
            if (debugPort != 0)
                options.AdditionalBrowserArguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + debugPort;
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(profile, "WebView2"), options);
            if (finished || closing) return;
            view = new WebView2 { Dock = DockStyle.Fill, Visible = false };
            Controls.Add(view);
            view.BringToFront();
            await view.EnsureCoreWebView2Async(env);
            if (finished || closing) return;
            var browser = view.CoreWebView2;
            browser.Settings.AreDevToolsEnabled = debugPort != 0;
            browser.Settings.AreDefaultContextMenusEnabled = debugPort != 0;
            browser.Settings.AreHostObjectsAllowed = false;
            browser.NavigationStarting += (s, e) => {
                if (!TrustedPage(e.Uri)) e.Cancel = true;
                else restored = false;
            };
            browser.NewWindowRequested += (s, e) => e.Handled = true;
            browser.WebMessageReceived += ReceiveMessage;
            browser.NavigationCompleted += (s, e) => {
                if (!e.IsSuccess) { ShowProblem("无法打开本地编辑台，请重新启动应用。"); return; }
                view.Visible = true;
                status.Visible = false;
            };
            ready = true;
            if (debugPort != 0)
                File.WriteAllText(Path.Combine(profile, "session-info.json"),
                    json.Serialize(new { hostPid = Process.GetCurrentProcess().Id, servicePid = server.Id, webviewPid = browser.BrowserProcessId }));
            browser.Navigate(Home);
        }
        catch (Exception error)
        {
            if (!finished && !closing)
            {
                StopService();
                ShowProblem(error.Message);
            }
        }
    }

    void StartService()
    {
        string node = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Where(directory => !String.IsNullOrWhiteSpace(directory))
            .Select(directory => Path.Combine(directory.Trim('"'), "node.exe"))
            .FirstOrDefault(File.Exists);
        if (node == null) throw new InvalidOperationException("找不到 Node.js。请安装 Node 22.12 或更高版本，并重新打开编辑台。");
        var info = new ProcessStartInfo(node, "desktop/server.mjs") {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        info.EnvironmentVariables["OVERLAY_DESKTOP_SESSION"] = session;
        info.EnvironmentVariables["OVERLAY_DESKTOP_WORK"] = work;
        server = new Process { StartInfo = info, EnableRaisingEvents = true };
        server.OutputDataReceived += (s, e) => {
            if (e.Data == "OVERLAY_DESKTOP_READY") listening.TrySetResult(true);
        };
        server.ErrorDataReceived += (s, e) => {
            if (String.IsNullOrWhiteSpace(e.Data)) return;
            lock (serviceErrors)
            {
                if (serviceErrors.Length > 2000) serviceErrors.Clear();
                serviceErrors.AppendLine(e.Data);
            }
        };
        server.Exited += (s, e) => {
            try { ((Process)s).WaitForExit(); }
            catch (InvalidOperationException) { }
            listening.TrySetResult(false);
        };
        server.Start();
        try { job.Add(server); }
        catch
        {
            // The server has not received its start signal and cannot have spawned children.
            if (!server.HasExited) server.Kill();
            throw;
        }
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        server.StandardInput.WriteLine("start");
        server.StandardInput.Close();
    }

    string ReadErrors()
    {
        lock (serviceErrors) return serviceErrors.ToString().Trim();
    }

    async Task<Dictionary<string, object>> Request(string path, bool post = false, object payload = null)
    {
        using (var request = new HttpRequestMessage(post ? HttpMethod.Post : HttpMethod.Get, path))
        {
            if (post) request.Content = new StringContent(payload == null ? "{}" : json.Serialize(payload), Encoding.UTF8, "application/json");
            using (var response = await http.SendAsync(request))
            {
                response.EnsureSuccessStatusCode();
                return json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
            }
        }
    }

    static bool TrustedPage(string value)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "http"
            && uri.Host == "localhost" && uri.Port == 5177 && uri.AbsolutePath == "/"
            && uri.Query.Length == 0 && uri.UserInfo.Length == 0;
    }

    static string Field(Dictionary<string, object> message, string key)
    {
        object value;
        return message.TryGetValue(key, out value) ? value as string : null;
    }

    async void ReceiveMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (closing || !TrustedPage(args.Source) || !TrustedPage(view.CoreWebView2.Source)) return;
        Dictionary<string, object> message;
        try { message = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson); }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        if (message == null) return;
        switch (Field(message, "type"))
        {
            case "export-directory-ready":
                if (!restored && !restoring)
                {
                    restoring = true;
                    try
                    {
                        if (File.Exists(settings)) await RegisterDirectory(File.ReadAllText(settings), true);
                        restored = true;
                    }
                    catch { Send(new { status = "error", unavailable = true, error = "上次的成品目录已失效，请重新选择或使用默认目录。" }); }
                    finally { restoring = false; }
                }
                break;
            case "select-subtitle":
                if (picking) return;
                picking = true;
                try
                {
                    await Task.Yield();
                    using (var picker = new OpenFileDialog { Title = "选择口播字幕", Filter = "SRT 字幕 (*.srt)|*.srt", CheckFileExists = true })
                    {
                        if (picker.ShowDialog(this) != DialogResult.OK)
                        {
                            Send(new { type = "subtitle-picked", status = "cancelled" });
                            break;
                        }
                        var result = await Request("api/subtitle-output/import", true, new { path = picker.FileName });
                        Send(new { type = "subtitle-picked", status = "selected", result });
                    }
                }
                catch
                {
                    Send(new { type = "subtitle-picked", status = "error", error = "无法导入字幕，请检查文件是否可读，且是 10 MB 以内的有效 SRT 字幕。" });
                }
                finally { picking = false; }
                break;
            case "select-subtitle-directory":
            case "select-export-directory":
                bool forSubtitle = Field(message, "type") == "select-subtitle-directory";
                if (picking || restoring)
                {
                    if (forSubtitle) Send(new { type = "subtitle-directory-picked", status = "cancelled" });
                    return;
                }
                picking = true;
                try
                {
                    // A modal dialog must start after the WebView2 message callback returns.
                    await Task.Yield();
                    string selected = FolderPicker.Select(Handle, forSubtitle ? "选择本期输出目录" : "选择动效成品文件夹");
                    if (forSubtitle)
                    {
                        if (selected == null) Send(new { type = "subtitle-directory-picked", status = "cancelled" });
                        else
                        {
                            var result = await Request("api/subtitle-output/relocate", true, new {
                                path = selected, destinationId = Field(message, "destinationId")
                            });
                            Send(new { type = "subtitle-directory-picked", status = "selected", result });
                        }
                    }
                    else if (selected == null) Send(new { status = "cancelled" });
                    else await RegisterDirectory(selected);
                }
                catch (Exception error)
                {
                    string detail = debugPort == 0 ? "" : " " + error.Message;
                    Send(new { type = forSubtitle ? "subtitle-directory-picked" : "export-directory",
                        status = "error", error = "无法使用所选目录，请检查权限后重新选择。" + detail });
                }
                finally { picking = false; }
                break;
            case "remember-export-directory":
                try
                {
                    var state = await Request("api/desktop-session");
                    object last;
                    Dictionary<string, object> destination;
                    if (state.TryGetValue("lastDestination", out last) && (destination = last as Dictionary<string, object>) != null
                        && Field(destination, "destinationId") == Field(message, "destinationId"))
                    {
                        SaveDirectory(destination);
                    }
                }
                catch { Send(new { status = "error", error = "成品已导出，暂时无法记住目录。请检查桌面设置目录的权限。" }); }
                break;
        }
    }

    async Task RegisterDirectory(string directory, bool remembered = false)
    {
        var result = await Request("api/export-destination", true, new { path = directory });
        Send(new { status = "selected", destinationId = Field(result, "destinationId"), path = Field(result, "path"), remembered });
    }

    void SaveDirectory(Dictionary<string, object> destination)
    {
        object id;
        if (destination.TryGetValue("destinationId", out id) && id == null)
        {
            File.Delete(settings);
            return;
        }
        string directory = Field(destination, "path");
        if (String.IsNullOrWhiteSpace(directory)) return;
        string temp = settings + ".tmp";
        File.WriteAllText(temp, directory);
        if (File.Exists(settings)) File.Replace(temp, settings, null);
        else File.Move(temp, settings);
    }

    void Send(object payload)
    {
        if (finished || view == null || view.IsDisposed || !TrustedPage(view.CoreWebView2.Source)) return;
        var message = json.Deserialize<Dictionary<string, object>>(json.Serialize(payload));
        if (!message.ContainsKey("type")) message["type"] = "export-directory";
        view.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));
    }

    async void CloseEditor(object sender, FormClosingEventArgs args)
    {
        if (finished) return;
        args.Cancel = true;
        if (closing) return;
        closing = true;
        // A second Close call must run after the current FormClosing event unwinds.
        await Task.Yield();
        bool stateUnknown = false;
        try
        {
            if (ready && server != null && !server.HasExited)
            {
                var state = await Request("api/desktop-session/close", true);
                if (Convert.ToBoolean(state["busy"]))
                {
                    var choice = MessageBox.Show(this, "导出还在进行。\r\n是：取消导出并退出\r\n否：等导出完成后退出\r\n取消：返回编辑台",
                        "导出进行中", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button3);
                    if (choice == DialogResult.Cancel)
                    {
                        await Request("api/desktop-session/resume", true);
                        closing = false;
                        return;
                    }
                    if (choice == DialogResult.Yes)
                        state = await Request("api/desktop-session/cancel", true);
                    if (choice == DialogResult.No || !Convert.ToBoolean(state["canStop"]))
                    {
                        do
                        {
                            await Task.Delay(400);
                            state = await Request("api/desktop-session");
                        } while (Convert.ToBoolean(state["busy"]));
                    }
                }
                // The page may still be processing the response when the user closes the app.
                object last;
                if (state.TryGetValue("lastDestination", out last) && last is Dictionary<string, object>)
                {
                    try { SaveDirectory((Dictionary<string, object>)last); }
                    catch (IOException error) { Debug.WriteLine(error); }
                    catch (UnauthorizedAccessException error) { Debug.WriteLine(error); }
                }
            }
        }
        catch (Exception error)
        {
            Debug.WriteLine(error);
            stateUnknown = server != null && !server.HasExited;
            if (stateUnknown && debugPort != 0)
            {
                try { File.AppendAllText(Path.Combine(profile, "session-errors.log"), error + Environment.NewLine); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        if (stateUnknown)
        {
            if (MessageBox.Show(this, "暂时无法确认导出状态。强制退出可能中断导出。\r\n\r\n仍要强制退出吗？",
                "导出状态未知", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            {
                try { await Request("api/desktop-session/resume", true); }
                catch (Exception resumeError) { Debug.WriteLine(resumeError); }
                closing = false;
                return;
            }
        }
        finished = true;
        Close();
    }

    void ShowProblem(string message)
    {
        ready = false;
        if (view != null) view.Visible = false;
        status.Text = message;
        status.Visible = true;
        status.BringToFront();
    }

    void StopService()
    {
        if (job != null) { job.Dispose(); job = null; }
        if (server != null)
        {
            try { server.WaitForExit(3000); }
            catch (InvalidOperationException) { }
            server.Dispose();
            server = null;
        }
        RemoveIncompleteFrameCaches();
        RemoveScratch(work);
    }

    void RemoveIncompleteFrameCaches()
    {
        string pending = Path.Combine(work, "pending-frame-caches");
        if (!Directory.Exists(pending)) return;
        foreach (string marker in Directory.GetFiles(pending))
        {
            string key = Path.GetFileName(marker);
            if (!System.Text.RegularExpressions.Regex.IsMatch(key, @"^(source-pts-v1-[a-f0-9]{20}-\d+ms|[\w.-]+-\d+_\d+fps-\d+-\d+s)$")) continue;
            var cache = new DirectoryInfo(Path.Combine(root, "public", "_fxframes", key));
            if (cache.Exists && (cache.Attributes & FileAttributes.ReparsePoint) == 0 &&
                !File.Exists(Path.Combine(cache.FullName, "manifest.json")))
                RemoveScratch(cache.FullName);
        }
    }

    static void RemoveScratch(string directory)
    {
        for (int attempt = 0; attempt < 5 && Directory.Exists(directory); attempt++)
        {
            try { Directory.Delete(directory, true); }
            catch (IOException) { Thread.Sleep(100); }
            catch (UnauthorizedAccessException) { Thread.Sleep(100); }
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        timer.Dispose();
        if (view != null) view.Dispose();
        StopService();
        http.Dispose();
        base.OnFormClosed(args);
    }

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);
}

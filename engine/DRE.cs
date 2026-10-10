// DRE(PC 프로그램) — 이 PC의 한글·워드·엑셀·파워포인트로 문서를 PDF로 바꿔 주는 작은 로컬 서버.
// 127.0.0.1 에서만 듣고, 허락된 주소(DRE 앱)에서 온 요청만 받는다.
// 일이 없으면 오피스 프로그램을 닫아 메모리를 돌려주고, 오래 쉬면 DRE.exe도 스스로 끝난다.
// 빌드: engine\build.ps1 (윈도우에 기본으로 있는 .NET Framework 4 컴파일러 사용, C# 5 문법)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.IO.Compression;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("DRE")]
[assembly: AssemblyDescription("DRE — 문서 변환")]
[assembly: AssemblyProduct("DRE")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace Dre
{
    static class Program
    {
        public const string Version = "1.0.0";
        public static readonly int[] Ports = { 41730, 41731, 41732 };
        public const string Protocol = "dre";
        public const string OldProtocol = "dre-engine"; // 옛 이름(DRE 엔진) 시절 등록 — 설치·지우기 때 정리
        public static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DRE");
        public static readonly string InstalledExe = Path.Combine(Home, "DRE.exe");
        public static readonly string OldExe = Path.Combine(Home, "DreEngine.exe"); // 옛 이름
        public static Settings Config;
        public static HttpServer Server;
        public static Converter Conv;
        public static Tray TrayIcon;
        public static DateTime LastWork = DateTime.Now;
        static Mutex single;

        [STAThread]
        static int Main(string[] args)
        {
            string arg = args.Length > 0 ? args[0].Trim() : "";
            try { Directory.CreateDirectory(Home); } catch { }
            Log.Init(Path.Combine(Home, "engine.log"));

            if (arg == "--install") return Installer.Install(args.Length > 1 && args[1] == "--quiet");
            if (arg == "--uninstall") return Installer.Uninstall(args.Length > 1 && args[1] == "--quiet");
            if (arg == "--quit") { Installer.AskRunningToQuit(); return 0; }
            bool openAfter = arg == "--open";

            bool created;
            single = new Mutex(true, "Local\\DRE.Engine.v1", out created);
            if (!created)
            {
                // 이미 켜져 있음. '--open'(시작 메뉴 DRE)이면 켜져 있는 DRE.exe의 앱 주소를 연다
                if (openAfter) { int port = Installer.RunningPort(); OpenUrl("http://127.0.0.1:" + (port > 0 ? port : Ports[0]) + "/"); }
                return 0;
            }

            // 설치되지 않은 곳(다운로드 폴더 등)에서 처음 실행하면 설치를 권한다
            if ((arg == "" || openAfter) && !SamePath(Application.ExecutablePath, InstalledExe) && !File.Exists(InstalledExe) && !AppFiles.DevMode)
            {
                var r = MessageBox.Show("DRE를 이 PC에 설치할까요?\n\n인터넷 없이도 PC 안에서 열리는 문서 변환 앱과, 한글·워드 문서를 PDF로 바꾸는 기능이 함께 설치됩니다(관리자 권한 필요 없음).\n설치 위치: " + Home,
                    "DRE", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (r != DialogResult.OK) return 0;
                single.ReleaseMutex(); single.Dispose(); single = null;
                return Installer.Install(false);
            }

            AppDomain.CurrentDomain.UnhandledException += delegate (object sender, UnhandledExceptionEventArgs e) { Log.Write("처리 못한 오류 " + e.ExceptionObject); };
            Application.ThreadException += delegate (object sender, ThreadExceptionEventArgs e) { Log.Write("화면 스레드 오류 " + e.Exception); };
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Config = Settings.Load(Path.Combine(Home, "engine.ini"));
            CleanTemp();
            AppFiles.Ensure();
            Conv = new Converter();
            Conv.Start();
            Server = new HttpServer();
            if (!Server.Start())
            {
                Log.Write("포트를 열지 못함");
                MessageBox.Show("DRE를 시작하지 못했습니다.\n다른 프로그램이 통신 자리(포트 41730~41732)를 쓰고 있습니다.", "DRE", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
            Log.Write("시작 " + Version + " port=" + Server.Port + " app=" + AppFiles.Dir);
            if (openAfter) OpenUrl(AppUrl);
            Application.EnableVisualStyles();
            TrayIcon = new Tray();
            var invoker = new Control();
            var forceHandle = invoker.Handle;
            HttpServer.SetUiInvoker(invoker);
            var idle = new System.Windows.Forms.Timer();
            idle.Interval = 30000;
            idle.Tick += delegate
            {
                int mins = Config.IdleExitMinutes;
                if (mins > 0 && !Conv.Busy && (DateTime.Now - LastWork).TotalMinutes >= mins)
                {
                    Log.Write("오래 쉬어서 끝냄");
                    Quit();
                }
            };
            idle.Start();
            Converter.TrimMemory();
            Application.Run();
            return 0;
        }

        public static void Quit()
        {
            try { if (Server != null) Server.Stop(); } catch { }
            try { if (Conv != null) Conv.Shutdown(); } catch { }
            try { if (TrayIcon != null) TrayIcon.Dispose(); } catch { }
            Log.Write("끝");
            Application.Exit();
            // 오피스 프로그램 정리가 끝나지 않아도 몇 초 뒤엔 반드시 끝낸다
            var t = new Thread(delegate () { Thread.Sleep(8000); Environment.Exit(0); });
            t.IsBackground = true; t.Start();
        }

        // 앱 주소: 설정에 따로 적지 않았으면 DRE.exe가 내보내는 PC 안 주소
        public static string AppUrl
        {
            get
            {
                if (Config != null && !string.IsNullOrEmpty(Config.AppUrl)) return Config.AppUrl;
                return "http://127.0.0.1:" + (Server != null && Server.Port > 0 ? Server.Port : Ports[0]) + "/";
            }
        }

        public static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception e) { Log.Write("주소 열기 실패 " + e.Message); }
        }

        public static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        public static string TempRoot { get { return Path.Combine(Path.GetTempPath(), "DRE-engine"); } }

        static void CleanTemp()
        {
            try
            {
                if (!Directory.Exists(TempRoot)) return;
                foreach (var d in Directory.GetDirectories(TempRoot))
                {
                    try { if ((DateTime.Now - Directory.GetLastWriteTime(d)).TotalMinutes > 30) Directory.Delete(d, true); } catch { }
                }
            }
            catch { }
        }
    }

    // ───────────────────────── 설정 ─────────────────────────
    class Settings
    {
        public string Path_;
        public string AppUrl = "";
        public int IdleExitMinutes = 30;
        public List<string> ExtraOrigins = new List<string>();
        public string Debug = "";

        public static Settings Load(string path)
        {
            var s = new Settings();
            s.Path_ = path;
            try
            {
                if (File.Exists(path))
                {
                    foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
                    {
                        var line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#")) continue;
                        int eq = line.IndexOf('=');
                        if (eq < 0) continue;
                        string k = line.Substring(0, eq).Trim().ToLowerInvariant(), v = line.Substring(eq + 1).Trim();
                        if (k == "app_url" && v.Length > 0) s.AppUrl = v;
                        else if (k == "idle_exit_minutes") { int n; if (int.TryParse(v, out n)) s.IdleExitMinutes = Math.Max(0, n); }
                        else if (k == "extra_origin" && v.Length > 0) s.ExtraOrigins.Add(v.TrimEnd('/'));
                        else if (k == "debug") s.Debug = v;
                    }
                }
            }
            catch (Exception e) { Log.Write("설정 읽기 실패 " + e.Message); }
            return s;
        }

        public void Save()
        {
            try
            {
                var sb = new StringBuilder();
                sb.AppendLine("# DRE 설정");
                if (!string.IsNullOrEmpty(AppUrl)) sb.AppendLine("app_url=" + AppUrl);
                sb.AppendLine("idle_exit_minutes=" + IdleExitMinutes);
                foreach (var o in ExtraOrigins) sb.AppendLine("extra_origin=" + o);
                File.WriteAllText(Path_, sb.ToString(), new UTF8Encoding(false));
            }
            catch (Exception e) { Log.Write("설정 저장 실패 " + e.Message); }
        }
    }

    // ───────────────────────── 앱 파일 ─────────────────────────
    // 빌드할 때 web 폴더를 app.zip 으로 묶어 실행 파일 안에 넣는다. 설치·시작 때 %LOCALAPPDATA%\DRE\app 에 푼다(판이 바뀌었을 때만).
    // 저장소의 web\engine\DRE.exe 로 바로 실행하면(개발) web 폴더를 그대로 내보낸다.
    static class AppFiles
    {
        public static string Dir;

        public static bool DevMode
        {
            get
            {
                try
                {
                    string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
                    return File.Exists(Path.Combine(exeDir, "..", "index.html")) && File.Exists(Path.Combine(exeDir, "DRE.cs"));
                }
                catch { return false; }
            }
        }

        public static void Ensure(bool forInstall = false)
        {
            try
            {
                if (!forInstall && DevMode)
                {
                    Dir = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), ".."));
                    return;
                }
                string target = Path.Combine(Program.Home, "app");
                var asm = Assembly.GetExecutingAssembly();
                using (var zs = asm.GetManifestResourceStream("app.zip"))
                {
                    if (zs == null) { Dir = Directory.Exists(target) ? target : null; return; }
                    // 판 표시: 묶음 크기 + 실행 파일 시각
                    string stamp = zs.Length + "-" + File.GetLastWriteTimeUtc(Application.ExecutablePath).Ticks;
                    string mark = Path.Combine(target, ".dre-app");
                    if (Directory.Exists(target) && File.Exists(mark) && File.ReadAllText(mark) == stamp) { Dir = target; return; }
                    string tmp = target + ".new";
                    if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
                    Directory.CreateDirectory(tmp);
                    using (var za = new ZipArchive(zs, ZipArchiveMode.Read))
                    {
                        string tmpFull = Path.GetFullPath(tmp).TrimEnd('\\') + "\\";
                        foreach (var e in za.Entries)
                        {
                            if (string.IsNullOrEmpty(e.Name)) continue;
                            string dest = Path.GetFullPath(Path.Combine(tmp, e.FullName.Replace('/', '\\')));
                            if (!dest.StartsWith(tmpFull, StringComparison.OrdinalIgnoreCase)) continue;
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            e.ExtractToFile(dest, true);
                        }
                    }
                    File.WriteAllText(Path.Combine(tmp, ".dre-app"), stamp);
                    string old = target + ".old";
                    if (Directory.Exists(old)) Directory.Delete(old, true);
                    if (Directory.Exists(target)) Directory.Move(target, old);
                    Directory.Move(tmp, target);
                    try { if (Directory.Exists(old)) Directory.Delete(old, true); } catch { }
                    Dir = target;
                    Log.Write("앱 파일을 풀었음 " + stamp);
                }
            }
            catch (Exception e)
            {
                Log.Write("앱 파일 준비 실패 " + e.Message);
                string target = Path.Combine(Program.Home, "app");
                Dir = Directory.Exists(target) ? target : null;
            }
        }
    }

    // ───────────────────────── 기록 ─────────────────────────
    static class Log
    {
        static string path;
        static readonly object gate = new object();
        public static void Init(string p)
        {
            path = p;
            try { if (File.Exists(p) && new FileInfo(p).Length > 1024 * 1024) { File.Delete(p + ".old"); File.Move(p, p + ".old"); } } catch { }
        }
        public static void Write(string msg)
        {
            if (path == null) return;
            lock (gate)
            {
                try { File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + msg + "\r\n", Encoding.UTF8); } catch { }
            }
        }
    }

    // ───────────────────────── 설치 ─────────────────────────
    static class Installer
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DRE";
        const string OldUninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DRE-Engine";
        const string RunValue = "DRE", OldRunValue = "DRE-Engine";

        public static int Install(bool quiet)
        {
            try
            {
                Directory.CreateDirectory(Program.Home);
                string me = Application.ExecutablePath;
                if (!Program.SamePath(me, Program.InstalledExe))
                {
                    AskRunningToQuit();
                    for (int i = 0; i < 20; i++)
                    {
                        try { File.Copy(me, Program.InstalledExe, true); break; }
                        catch (IOException) { Thread.Sleep(300); if (i == 19) throw; }
                    }
                }
                bool oldAuto = RemoveOld();
                bool wasAuto = oldAuto || IsAutoStart();
                RegisterProtocol();
                AppFiles.Ensure(true);
                bool first = !File.Exists(StartMenuLink);
                MakeStartMenuLink();
                using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
                {
                    k.SetValue("DisplayName", "DRE");
                    k.SetValue("DisplayVersion", Program.Version);
                    k.SetValue("Publisher", "DRE");
                    k.SetValue("DisplayIcon", Program.InstalledExe);
                    k.SetValue("InstallLocation", Program.Home);
                    k.SetValue("UninstallString", "\"" + Program.InstalledExe + "\" --uninstall");
                    k.SetValue("QuietUninstallString", "\"" + Program.InstalledExe + "\" --uninstall --quiet");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    k.SetValue("EstimatedSize", 200, RegistryValueKind.DWord);
                }
                // 이미 자동 실행으로 등록돼 있었다면 새 위치를 가리키게
                if (wasAuto) SetAutoStart(true);
                Log.Write("설치 " + Program.Version);
                Process.Start(new ProcessStartInfo(Program.InstalledExe, quiet ? Program.Protocol + "://start" : "--open") { UseShellExecute = false });
                if (!quiet) MessageBox.Show("DRE를 설치했습니다.\n\n시작 메뉴의 'DRE'로 열 수 있습니다(인터넷 없이 PC 안에서 열림).\n브라우저 주소창 오른쪽의 '앱 설치' 단추를 누르면 바탕 화면 앱처럼 쓸 수 있습니다.", "DRE", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            catch (Exception e)
            {
                Log.Write("설치 실패 " + e);
                if (!quiet) MessageBox.Show("설치하지 못했습니다.\n" + e.Message, "DRE", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        public static int Uninstall(bool quiet)
        {
            if (!quiet && MessageBox.Show("DRE를 이 PC에서 지울까요?", "DRE", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return 0;
            AskRunningToQuit();
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\" + Program.Protocol, false); } catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
            SetAutoStart(false);
            RemoveOld();
            try { if (File.Exists(StartMenuLink)) File.Delete(StartMenuLink); } catch { }
            // 실행 중인 자기 자신은 바로 못 지우므로 잠시 뒤 지운다
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + Program.Home + "\"");
                psi.WindowStyle = ProcessWindowStyle.Hidden; psi.CreateNoWindow = true; psi.UseShellExecute = false;
                Process.Start(psi);
            }
            catch { }
            if (!quiet) MessageBox.Show("DRE를 지웠습니다.", "DRE", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        // 옛 이름(DRE 엔진: DreEngine.exe, dre-engine://, 앱 목록 'DRE 엔진')으로 깔린 흔적을 지운다. 옛 자동 실행이 켜져 있었으면 true
        static bool RemoveOld()
        {
            bool hadAuto = false;
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\" + Program.OldProtocol, false); } catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(OldUninstallKey, false); } catch { }
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey, true))
                    if (k != null && k.GetValue(OldRunValue) != null) { hadAuto = true; k.DeleteValue(OldRunValue); }
            }
            catch { }
            for (int i = 0; i < 10 && File.Exists(Program.OldExe); i++)
            {
                try { File.Delete(Program.OldExe); } catch { Thread.Sleep(300); }
            }
            return hadAuto;
        }

        static void RegisterProtocol()
        {
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + Program.Protocol))
            {
                k.SetValue("", "URL:DRE");
                k.SetValue("URL Protocol", "");
                using (var ic = k.CreateSubKey("DefaultIcon")) ic.SetValue("", "\"" + Program.InstalledExe + "\",0");
                using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", "\"" + Program.InstalledExe + "\" \"%1\"");
            }
        }

        public static string StartMenuLink
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DRE.lnk"); }
        }

        // 시작 메뉴 'DRE' — DRE.exe를 켜고(켜져 있으면 그대로) 앱 주소를 연다
        static void MakeStartMenuLink()
        {
            try
            {
                var t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
                dynamic sh = Activator.CreateInstance(t);
                dynamic lnk = sh.CreateShortcut(StartMenuLink);
                lnk.TargetPath = Program.InstalledExe;
                lnk.Arguments = "--open";
                lnk.WorkingDirectory = Program.Home;
                lnk.IconLocation = Program.InstalledExe + ",0";
                lnk.Description = "DRE — 문서 변환(한글·워드 → PDF, 글 뽑기, PDF 합치기)";
                lnk.Save();
                Marshal.FinalReleaseComObject(lnk);
                Marshal.FinalReleaseComObject(sh);
            }
            catch (Exception e) { Log.Write("바로가기 만들기 실패 " + e.Message); }
        }

        // 켜져 있는 DRE.exe의 포트(없으면 0)
        public static int RunningPort()
        {
            foreach (int p in Program.Ports)
            {
                try
                {
                    using (var c = new TcpClient())
                    {
                        var ar = c.BeginConnect(IPAddress.Loopback, p, null, null);
                        if (!ar.AsyncWaitHandle.WaitOne(300)) continue;
                        c.EndConnect(ar);
                        var s = c.GetStream();
                        var req = Encoding.ASCII.GetBytes("GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:" + p + "\r\nConnection: close\r\n\r\n");
                        s.Write(req, 0, req.Length);
                        s.ReadTimeout = 1500;
                        var buf = new byte[1024];
                        int n = s.Read(buf, 0, buf.Length);
                        if (n > 0 && Encoding.ASCII.GetString(buf, 0, n).Contains("\"app\":\"DRE\"")) return p;
                    }
                }
                catch { }
            }
            return 0;
        }

        public static bool IsAutoStart()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue(RunValue) != null;
        }

        public static void SetAutoStart(bool on)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (on) k.SetValue(RunValue, "\"" + Program.InstalledExe + "\" " + Program.Protocol + "://autostart");
                    else if (k.GetValue(RunValue) != null) k.DeleteValue(RunValue);
                }
            }
            catch (Exception e) { Log.Write("자동 실행 설정 실패 " + e.Message); }
        }

        public static void AskRunningToQuit()
        {
            foreach (int p in Program.Ports)
            {
                try
                {
                    using (var c = new TcpClient())
                    {
                        var ar = c.BeginConnect(IPAddress.Loopback, p, null, null);
                        if (!ar.AsyncWaitHandle.WaitOne(400)) continue;
                        c.EndConnect(ar);
                        var s = c.GetStream();
                        var req = Encoding.ASCII.GetBytes("POST /v1/quit HTTP/1.1\r\nHost: 127.0.0.1:" + p + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        s.Write(req, 0, req.Length);
                        s.ReadTimeout = 3000;
                        var buf = new byte[512];
                        try { s.Read(buf, 0, buf.Length); } catch { }
                    }
                }
                catch { }
            }
            // 끝날 때까지 잠깐 기다림
            for (int i = 0; i < 30; i++)
            {
                bool running;
                using (var m = new Mutex(false, "Local\\DRE.Engine.v1", out running)) { }
                Mutex test = null;
                try { test = Mutex.OpenExisting("Local\\DRE.Engine.v1"); } catch { }
                if (test == null) return;
                test.Dispose();
                Thread.Sleep(300);
            }
        }
    }

    // ───────────────────────── 알림 영역 아이콘 ─────────────────────────
    class Tray : IDisposable
    {
        NotifyIcon icon;
        ToolStripMenuItem status, autoStart, idleExit;

        public Tray()
        {
            icon = new NotifyIcon();
            icon.Icon = MakeIcon();
            icon.Text = "DRE";
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("DRE 열기");
            open.Font = new Font(open.Font, FontStyle.Bold);
            open.Click += delegate { OpenApp(); };
            status = new ToolStripMenuItem("대기 중");
            status.Enabled = false;
            autoStart = new ToolStripMenuItem("Windows를 켤 때 함께 켜기");
            autoStart.Checked = Installer.IsAutoStart();
            autoStart.Click += delegate
            {
                bool on = !Installer.IsAutoStart();
                Installer.SetAutoStart(on);
                autoStart.Checked = Installer.IsAutoStart();
            };
            idleExit = new ToolStripMenuItem("30분 쉬면 스스로 끄기");
            idleExit.Checked = Program.Config.IdleExitMinutes > 0;
            idleExit.Click += delegate
            {
                Program.Config.IdleExitMinutes = Program.Config.IdleExitMinutes > 0 ? 0 : 30;
                Program.Config.Save();
                idleExit.Checked = Program.Config.IdleExitMinutes > 0;
            };
            var quit = new ToolStripMenuItem("끝내기");
            quit.Click += delegate { Program.Quit(); };
            menu.Items.Add(open);
            menu.Items.Add(status);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(autoStart);
            menu.Items.Add(idleExit);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quit);
            menu.Opening += delegate
            {
                status.Text = Program.Conv.Busy ? "변환 중…" : ("대기 중 · " + Program.Conv.AppsSummary());
                autoStart.Checked = Installer.IsAutoStart();
            };
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenApp(); };
            icon.Visible = true;
        }

        void OpenApp()
        {
            Program.OpenUrl(Program.AppUrl);
        }

        static Icon MakeIcon()
        {
            try
            {
                var ico = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (ico != null) return new Icon(ico, SystemInformation.SmallIconSize);
            }
            catch { }
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var b = new SolidBrush(Color.FromArgb(37, 99, 235))) g.FillEllipse(b, 1, 1, 30, 30);
                using (var f = new Font("Segoe UI", 15, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                    g.DrawString("D", f, w, new RectangleF(0, 0, 32, 32), sf);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        public void Dispose()
        {
            if (icon != null) { icon.Visible = false; icon.Dispose(); icon = null; }
        }
    }

    // ───────────────────────── 아주 작은 HTTP 서버 ─────────────────────────
    class HttpServer
    {
        TcpListener listener;
        public int Port;
        volatile bool running;
        const long MaxBody = 1024L * 1024 * 1024; // 1GB

        public bool Start()
        {
            foreach (int p in Program.Ports)
            {
                try
                {
                    var l = new TcpListener(IPAddress.Loopback, p);
                    l.ExclusiveAddressUse = true;
                    l.Start(16);
                    listener = l; Port = p;
                    break;
                }
                catch (SocketException) { }
            }
            if (listener == null) return false;
            running = true;
            var t = new Thread(AcceptLoop);
            t.IsBackground = true; t.Name = "accept";
            t.Start();
            return true;
        }

        public void Stop()
        {
            running = false;
            try { listener.Stop(); } catch { }
        }

        void AcceptLoop()
        {
            while (running)
            {
                TcpClient c;
                try { c = listener.AcceptTcpClient(); }
                catch { if (!running) return; Thread.Sleep(50); continue; }
                ThreadPool.QueueUserWorkItem(delegate { Handle(c); });
            }
        }

        class Req
        {
            public string Method, Path, Query;
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public byte[] Pre; public int PreOff, PreLen;
            public string Header(string k) { string v; return Headers.TryGetValue(k, out v) ? v : null; }
            public string Q(string k)
            {
                if (string.IsNullOrEmpty(Query)) return null;
                foreach (var part in Query.Split('&'))
                {
                    int eq = part.IndexOf('=');
                    string name = eq < 0 ? part : part.Substring(0, eq);
                    if (Uri.UnescapeDataString(name.Replace('+', ' ')) == k)
                        return eq < 0 ? "" : Uri.UnescapeDataString(part.Substring(eq + 1).Replace('+', ' '));
                }
                return null;
            }
        }

        void Handle(TcpClient client)
        {
            using (client)
            {
                NetworkStream ns = null;
                try
                {
                    client.NoDelay = true;
                    ns = client.GetStream();
                    ns.ReadTimeout = 60000;
                    ns.WriteTimeout = 120000;
                    var req = ReadHead(ns);
                    if (req == null) { if (Program.Config.Debug.IndexOf("http") >= 0) Log.Write("요청 머리 못 읽음"); return; }
                    if (Program.Config.Debug.IndexOf("http") >= 0)
                    {
                        var sbh = new StringBuilder();
                        foreach (var kv in req.Headers) sbh.Append(kv.Key).Append('=').Append(kv.Value).Append(" | ");
                        Log.Write("요청 " + req.Method + " " + req.Path + " " + sbh);
                    }
                    Route(ns, req);
                    // 정중하게 닫기: 보낼 쪽만 먼저 닫고 상대가 닫을 때까지 잠깐 기다린다.
                    // 바로 끊으면(남은 자료가 있을 때) 브라우저가 연결 오류로 보고 서비스워커 등록이 실패한다(실측)
                    try
                    {
                        var sock = ns.GetSocket();
                        sock.Shutdown(SocketShutdown.Send);
                        sock.ReceiveTimeout = 1500;
                        var drain = new byte[4096];
                        while (sock.Receive(drain) > 0) { }
                    }
                    catch { }
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                catch (Exception e)
                {
                    Log.Write("요청 처리 오류 " + e.Message);
                    try { if (ns != null) SendJson(ns, null, 500, "{\"error\":\"internal\",\"message\":\"DRE 내부 오류\"}"); } catch { }
                }
            }
        }

        static Req ReadHead(NetworkStream ns)
        {
            var buf = new byte[32768];
            int len = 0, end = -1;
            while (end < 0)
            {
                if (len >= buf.Length) return null;
                int n = ns.Read(buf, len, buf.Length - len);
                if (n <= 0) return null;
                len += n;
                for (int i = Math.Max(0, len - n - 3); i + 3 < len; i++)
                    if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10) { end = i; break; }
            }
            var head = Encoding.UTF8.GetString(buf, 0, end);
            var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
            var first = lines[0].Split(' ');
            if (first.Length < 2) return null;
            var r = new Req();
            r.Method = first[0].ToUpperInvariant();
            string target = first[1];
            int qm = target.IndexOf('?');
            r.Path = qm < 0 ? target : target.Substring(0, qm);
            r.Query = qm < 0 ? "" : target.Substring(qm + 1);
            for (int i = 1; i < lines.Length; i++)
            {
                int c = lines[i].IndexOf(':');
                if (c > 0) r.Headers[lines[i].Substring(0, c).Trim()] = lines[i].Substring(c + 1).Trim();
            }
            r.Pre = buf; r.PreOff = end + 4; r.PreLen = len - (end + 4);
            return r;
        }

        // 브라우저가 붙이는 Origin 으로 DRE 앱인지 가린다. 주소창에 직접 친 요청(Origin 없음)은 상태 보기만 허용.
        static bool OriginAllowed(string origin)
        {
            if (origin == null) return false;
            origin = origin.TrimEnd('/');
            if (origin == "https://door9.github.io") return true;
            Uri u;
            if (Uri.TryCreate(origin, UriKind.Absolute, out u) && (u.Scheme == "http" || u.Scheme == "https") &&
                (u.Host == "localhost" || u.Host == "127.0.0.1" || u.Host == "[::1]") && u.AbsolutePath == "/") return true;
            foreach (var o in Program.Config.ExtraOrigins) if (string.Equals(o, origin, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        // 다른 사이트가 주소 이름을 127.0.0.1 로 바꿔치기하는 공격(DNS 리바인딩)을 막는다
        bool HostAllowed(string host)
        {
            if (host == null) return false;
            return host == "127.0.0.1:" + Port || host == "localhost:" + Port || host == "[::1]:" + Port;
        }

        void Route(NetworkStream ns, Req req)
        {
            string origin = req.Header("Origin");
            if (!HostAllowed(req.Header("Host"))) { SendJson(ns, null, 403, "{\"error\":\"host\"}"); return; }
            // Origin 이 없는 요청은 브라우저가 아닌 이 PC의 프로그램(설치·끝내기 명령)이 보낸 것이다
            bool allowed = origin == null || OriginAllowed(origin);
            string corsOrigin = origin != null && allowed ? origin : null;

            if (req.Method == "OPTIONS")
            {
                if (!allowed) { SendJson(ns, null, 403, "{\"error\":\"origin\"}"); return; }
                var h = Cors(corsOrigin);
                h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                h["Access-Control-Allow-Headers"] = "Content-Type, X-DRE-Name";
                h["Access-Control-Allow-Private-Network"] = "true";
                h["Access-Control-Max-Age"] = "600";
                Send(ns, 204, "No Content", null, null, h);
                return;
            }

            if (req.Method == "GET" && req.Path == "/v1/status")
            {
                if (!allowed) { SendJson(ns, null, 403, "{\"error\":\"origin\"}"); return; }
                SendJson(ns, corsOrigin, 200, StatusJson());
                return;
            }
            // 앱 화면(PC 안 주소로 내보내 인터넷 없이 쓴다)
            if ((req.Method == "GET" || req.Method == "HEAD") && !req.Path.StartsWith("/v1/"))
            {
                ServeApp(ns, req);
                return;
            }

            if (!allowed) { SendJson(ns, null, 403, "{\"error\":\"origin\",\"message\":\"허락되지 않은 주소에서 온 요청입니다\"}"); return; }

            if (req.Method == "POST" && req.Path == "/v1/quit")
            {
                SendJson(ns, corsOrigin, 200, "{\"ok\":true}");
                ThreadPool.QueueUserWorkItem(delegate { Thread.Sleep(200); InvokeOnUi(Program.Quit); });
                return;
            }
            if (req.Method == "POST" && req.Path == "/v1/cancel")
            {
                Program.Conv.CancelAll();
                SendJson(ns, corsOrigin, 200, "{\"ok\":true}");
                return;
            }
            if (req.Method == "POST" && req.Path == "/v1/convert")
            {
                Convert(ns, req, corsOrigin);
                return;
            }
            SendJson(ns, corsOrigin, 404, "{\"error\":\"not_found\"}");
        }

        static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".mjs", "text/javascript; charset=utf-8" },
            { ".css", "text/css; charset=utf-8" }, { ".json", "application/json; charset=utf-8" }, { ".webmanifest", "application/manifest+json; charset=utf-8" },
            { ".png", "image/png" }, { ".svg", "image/svg+xml" }, { ".ico", "image/x-icon" }, { ".wasm", "application/wasm" },
            { ".bcmap", "application/octet-stream" }, { ".pfb", "application/octet-stream" }, { ".ttf", "font/ttf" }, { ".icc", "application/octet-stream" },
            { ".txt", "text/plain; charset=utf-8" }, { ".md", "text/plain; charset=utf-8" }, { ".exe", "application/octet-stream" },
            { ".pdf", "application/pdf" }, { ".hwp", "application/octet-stream" }, { ".hwpx", "application/octet-stream" }, { ".docx", "application/octet-stream" }, { ".jpg", "image/jpeg" },
        };

        void ServeApp(NetworkStream ns, Req req)
        {
            string root = AppFiles.Dir;
            if (root == null || !Directory.Exists(root))
            {
                var html = Encoding.UTF8.GetBytes("<!doctype html><meta charset=utf-8><title>DRE</title><body style=\"font:15px sans-serif;padding:24px\">DRE가 켜져 있습니다(" + Program.Version + "). 앱 파일이 없습니다 — DRE를 다시 설치해 주세요.</body>");
                Send(ns, 404, "Not Found", "text/html; charset=utf-8", html, null);
                return;
            }
            string rel;
            try { rel = Uri.UnescapeDataString(req.Path).TrimStart('/'); } catch { rel = ""; }
            if (rel.Length == 0) rel = "index.html";
            if (rel.Contains("..") || rel.Contains(":") || rel.Contains("\\") || rel.StartsWith("/"))
            {
                Send(ns, 400, "Bad Request", "text/plain", Encoding.UTF8.GetBytes("bad path"), null);
                return;
            }
            string full;
            try { full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', '\\'))); } catch { full = null; }
            string rootFull = Path.GetFullPath(root).TrimEnd('\\') + "\\";
            if (full == null || !full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            {
                Send(ns, 403, "Forbidden", "text/plain", Encoding.UTF8.GetBytes("forbidden"), null);
                return;
            }
            if (Directory.Exists(full)) full = Path.Combine(full, "index.html");
            if (!File.Exists(full))
            {
                Send(ns, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("없음"), null);
                return;
            }
            string ctype;
            if (!Mime.TryGetValue(Path.GetExtension(full), out ctype)) ctype = "application/octet-stream";
            var h = new Dictionary<string, string>();
            h["Cache-Control"] = "no-cache";
            h["X-Content-Type-Options"] = "nosniff";
            if (req.Method == "HEAD")
            {
                WriteHead(ns, 200, "OK", ctype, new FileInfo(full).Length, h, false);
                ns.Flush();
                return;
            }
            using (var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                WriteHead(ns, 200, "OK", ctype, fs.Length, h, false);
                fs.CopyTo(ns, 81920);
            }
            ns.Flush();
        }

        static Control uiInvoker;
        public static void InvokeOnUi(Action a)
        {
            // 알림 아이콘은 UI 스레드에서 정리해야 한다
            try
            {
                if (uiInvoker == null) { a(); return; }
                uiInvoker.BeginInvoke(a);
            }
            catch { a(); }
        }
        public static void SetUiInvoker(Control c) { uiInvoker = c; }

        string StatusJson()
        {
            var c = Program.Conv;
            return "{\"app\":\"DRE\",\"version\":\"" + Program.Version + "\",\"port\":" + Port +
                ",\"apps\":{\"hwp\":" + B(c.Has("hwp")) + ",\"word\":" + B(c.Has("word")) + ",\"excel\":" + B(c.Has("excel")) + ",\"powerpoint\":" + B(c.Has("powerpoint")) +
                ",\"browser\":" + B(c.Has("browser")) + "}" + ",\"browserName\":\"" + Json(c.Has("browser") ? Browser.Name : "") + "\"" +
                ",\"busy\":" + B(c.Busy) + ",\"queue\":" + c.QueueLength + "}";
        }
        static string B(bool b) { return b ? "true" : "false"; }

        void Convert(NetworkStream ns, Req req, string corsOrigin)
        {
            string name = req.Q("name") ?? req.Header("X-DRE-Name") ?? "document";
            string to = (req.Q("to") ?? "pdf").ToLowerInvariant();
            long clen;
            if (!long.TryParse(req.Header("Content-Length") ?? "", out clen) || clen <= 0)
            {
                SendJson(ns, corsOrigin, 411, "{\"error\":\"length\",\"message\":\"파일 크기를 알 수 없습니다\"}");
                return;
            }
            if (clen > MaxBody)
            {
                SendJson(ns, corsOrigin, 413, "{\"error\":\"too_large\",\"message\":\"파일이 너무 큽니다(1GB 초과)\"}");
                return;
            }
            name = SafeName(name);
            string ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
            string why = Program.Conv.Unsupported(ext, to);
            if (why != null)
            {
                // 본문을 읽지 않고 닫으면 브라우저가 오류만 보므로 끝까지 읽어 버린다
                Drain(ns, req, clen);
                SendJson(ns, corsOrigin, 415, "{\"error\":\"unsupported\",\"message\":\"" + Json(why) + "\"}");
                return;
            }
            string dir = Path.Combine(Program.TempRoot, Guid.NewGuid().ToString("N").Substring(0, 12));
            Directory.CreateDirectory(dir);
            try
            {
                string src = Path.Combine(dir, name);
                using (var fs = new FileStream(src, FileMode.CreateNew, FileAccess.Write))
                {
                    long left = clen;
                    int take = (int)Math.Min(left, req.PreLen);
                    if (take > 0) { fs.Write(req.Pre, req.PreOff, take); left -= take; }
                    var buf = new byte[81920];
                    while (left > 0)
                    {
                        int n = ns.Read(buf, 0, (int)Math.Min(buf.Length, left));
                        if (n <= 0) throw new IOException("본문이 끊김");
                        fs.Write(buf, 0, n); left -= n;
                    }
                }
                string outExt = to == "txt" ? "txt" : to;
                string dst = Path.Combine(dir, "out_" + Path.GetFileNameWithoutExtension(name) + "." + outExt);
                Program.LastWork = DateTime.Now;
                var job = Program.Conv.Enqueue(src, dst, ext, to, clen);
                // 브라우저 쪽이 끊으면(사용자가 중지) 그 일을 취소한다
                while (!job.Done.WaitOne(500))
                {
                    if (ClientGone(ns)) { Program.Conv.Cancel(job); job.Done.WaitOne(30000); return; }
                }
                Program.LastWork = DateTime.Now;
                if (job.ErrorCode != null)
                {
                    int code = job.ErrorCode == "password" || job.ErrorCode == "open_failed" ? 422 :
                               job.ErrorCode == "timeout" || job.ErrorCode == "dialog" ? 504 : job.ErrorCode == "cancelled" ? 499 : job.ErrorCode == "no_app" ? 503 : 500;
                    SendJson(ns, corsOrigin, code, "{\"error\":\"" + job.ErrorCode + "\",\"message\":\"" + Json(job.Error ?? "") + "\"}");
                    return;
                }
                var h = Cors(corsOrigin);
                h["X-DRE-App"] = job.UsedApp ?? "";
                h["X-DRE-Ms"] = ((int)job.Elapsed.TotalMilliseconds).ToString();
                h["Access-Control-Expose-Headers"] = "X-DRE-App, X-DRE-Ms";
                string ctype = to == "pdf" ? "application/pdf" : to == "txt" ? "text/plain; charset=utf-16" : "application/octet-stream";
                SendFile(ns, dst, ctype, h);
            }
            finally
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    for (int i = 0; i < 10; i++)
                    {
                        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); return; }
                        catch { Thread.Sleep(1000); }
                    }
                });
            }
        }

        static bool ClientGone(NetworkStream ns)
        {
            try
            {
                var s = ns.GetSocket();
                return s.Poll(0, SelectMode.SelectRead) && s.Available == 0;
            }
            catch { return true; }
        }

        static void Drain(NetworkStream ns, Req req, long clen)
        {
            long left = clen - req.PreLen;
            var buf = new byte[65536];
            while (left > 0)
            {
                int n = ns.Read(buf, 0, (int)Math.Min(buf.Length, left));
                if (n <= 0) break;
                left -= n;
            }
        }

        static string SafeName(string name)
        {
            name = name.Replace('\\', '/');
            int slash = name.LastIndexOf('/');
            if (slash >= 0) name = name.Substring(slash + 1);
            var sb = new StringBuilder();
            foreach (char ch in name)
            {
                if (ch < 32 || "<>:\"|?*".IndexOf(ch) >= 0) sb.Append('_'); else sb.Append(ch);
            }
            name = sb.ToString().Trim().TrimEnd('.');
            if (name.Length == 0) name = "document";
            string ext = Path.GetExtension(name);
            string stem = Path.GetFileNameWithoutExtension(name);
            if (stem.Length > 80) stem = stem.Substring(0, 80);
            if (stem.Length == 0) stem = "document";
            return stem + ext;
        }

        static Dictionary<string, string> Cors(string origin)
        {
            var h = new Dictionary<string, string>();
            if (origin != null) { h["Access-Control-Allow-Origin"] = origin; h["Vary"] = "Origin"; }
            return h;
        }

        public static string Json(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
                else if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static void SendJson(Stream s, string origin, int code, string json)
        {
            Send(s, code, Reason(code), "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json), Cors(origin));
        }

        static string Reason(int code)
        {
            switch (code)
            {
                case 200: return "OK";
                case 204: return "No Content";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 411: return "Length Required";
                case 413: return "Payload Too Large";
                case 415: return "Unsupported Media Type";
                case 422: return "Unprocessable Entity";
                case 499: return "Client Closed Request";
                case 503: return "Service Unavailable";
                case 504: return "Gateway Timeout";
                default: return "Error";
            }
        }

        static void WriteHead(Stream s, int code, string reason, string ctype, long length, Dictionary<string, string> extra)
        {
            WriteHead(s, code, reason, ctype, length, extra, true);
        }

        static void WriteHead(Stream s, int code, string reason, string ctype, long length, Dictionary<string, string> extra, bool noStore)
        {
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(code).Append(' ').Append(reason).Append("\r\n");
            if (ctype != null) sb.Append("Content-Type: ").Append(ctype).Append("\r\n");
            sb.Append("Content-Length: ").Append(length).Append("\r\n");
            if (noStore) sb.Append("Cache-Control: no-store\r\n");
            sb.Append("Connection: close\r\n");
            if (extra != null) foreach (var kv in extra) sb.Append(kv.Key).Append(": ").Append(kv.Value).Append("\r\n");
            sb.Append("\r\n");
            var b = Encoding.UTF8.GetBytes(sb.ToString());
            s.Write(b, 0, b.Length);
        }

        static void Send(Stream s, int code, string reason, string ctype, byte[] body, Dictionary<string, string> extra)
        {
            WriteHead(s, code, reason, ctype, body == null ? 0 : body.Length, extra);
            if (body != null && body.Length > 0) s.Write(body, 0, body.Length);
            s.Flush();
        }

        static void SendFile(Stream s, string path, string ctype, Dictionary<string, string> extra)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                WriteHead(s, 200, "OK", ctype, fs.Length, extra);
                fs.CopyTo(s, 81920);
            }
            s.Flush();
        }
    }

    static class NetExt
    {
        static readonly PropertyInfo sockProp = typeof(NetworkStream).GetProperty("Socket", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        public static Socket GetSocket(this NetworkStream ns) { return (Socket)sockProp.GetValue(ns, null); }
    }

    // ───────────────────────── 변환 일꾼 ─────────────────────────
    class Job
    {
        public string Src, Dst, Ext, To, UsedApp, Error, ErrorCode;
        public long Size;
        public DateTime Started;
        public TimeSpan Elapsed;
        public volatile bool Cancelled, TimedOut;
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void Fail(string code, string msg) { if (ErrorCode == null) { ErrorCode = code; Error = msg; } }
    }

    class ConvertError : Exception
    {
        public string Code;
        public ConvertError(string code, string msg) : base(msg) { Code = code; }
    }

    // 오피스 프로그램 하나(한글/워드/엑셀/파워포인트)를 숨겨서 부리는 자리
    class Session
    {
        public string Kind, ProgId, ExeName;
        public object AppObj;    // 죽은 COM 객체와 null 비교만 해도 예외가 나므로 object 로 들고 있는다
        public dynamic App { get { return AppObj; } }
        public int Pid;          // 우리가 띄운 프로세스(남이 쓰던 것에 붙었다면 0)
        public bool Shared;      // 이미 사용자가 쓰던 프로그램에 붙었는가(그러면 끄거나 죽이지 않는다)
        public DateTime LastUsed;
        public bool Dead;

        public Session(string kind, string progId, string exe) { Kind = kind; ProgId = progId; ExeName = exe; }

        public bool Alive { get { return AppObj != null && !Dead; } }

        public void Create()
        {
            var t = Type.GetTypeFromProgID(ProgId);
            if (t == null) throw new ConvertError("no_app", AppName(Kind) + " 프로그램이 이 PC에 없습니다");
            var before = Pids();
            AppObj = Activator.CreateInstance(t);
            Dead = false;
            Pid = 0; Shared = true;
            for (int i = 0; i < 20 && Pid == 0; i++)
            {
                foreach (int p in Pids()) if (!before.Contains(p)) { Pid = p; break; }
                if (Pid == 0) Thread.Sleep(100);
            }
            Shared = Pid == 0;
            LastUsed = DateTime.Now;
            Log.Write(Kind + " 띄움 pid=" + Pid + (Shared ? " (이미 켜진 것에 붙음)" : ""));
        }

        HashSet<int> Pids()
        {
            var s = new HashSet<int>();
            foreach (var p in Process.GetProcessesByName(ExeName)) { s.Add(p.Id); p.Dispose(); }
            return s;
        }

        public void Kill()
        {
            Dead = true;
            if (Pid != 0 && !Shared)
            {
                try { using (var p = Process.GetProcessById(Pid)) p.Kill(); Log.Write(Kind + " 강제 종료 pid=" + Pid); } catch { }
            }
        }

        public void Release()
        {
            object o = AppObj;
            AppObj = null;
            if (o != null) { try { Marshal.FinalReleaseComObject(o); } catch { } }
        }

        public static string AppName(string kind)
        {
            switch (kind) { case "hwp": return "한글"; case "word": return "워드"; case "excel": return "엑셀"; case "powerpoint": return "파워포인트"; }
            return kind;
        }
    }

    class Converter
    {
        readonly object gate = new object();
        readonly Queue<Job> queue = new Queue<Job>();
        readonly AutoResetEvent signal = new AutoResetEvent(false);
        volatile Job current;
        volatile bool shutdown;
        Thread worker;
        readonly Dictionary<string, Session> sessions = new Dictionary<string, Session>();
        readonly Dictionary<string, bool> installed = new Dictionary<string, bool>();
        const int IdleCloseSeconds = 60;

        public Converter()
        {
            sessions["hwp"] = new Session("hwp", "HWPFrame.HwpObject", "Hwp");
            sessions["word"] = new Session("word", "Word.Application", "WINWORD");
            sessions["excel"] = new Session("excel", "Excel.Application", "EXCEL");
            sessions["powerpoint"] = new Session("powerpoint", "PowerPoint.Application", "POWERPNT");
            foreach (var k in sessions.Keys) installed[k] = Type.GetTypeFromProgID(sessions[k].ProgId) != null;
            installed["browser"] = Browser.Exe != null; // 전자책(EPUB)을 앱이 HTML 로 묶어 보내면 엣지(없으면 크롬)로 인쇄
        }

        public bool Has(string kind) { bool b; return installed.TryGetValue(kind, out b) && b; }
        public bool Busy { get { return current != null || QueueLength > 0; } }
        public int QueueLength { get { lock (gate) return queue.Count; } }

        public string AppsSummary()
        {
            var parts = new List<string>();
            foreach (var k in new[] { "hwp", "word", "excel", "powerpoint" }) if (Has(k)) parts.Add(Session.AppName(k));
            if (Has("browser")) parts.Add(Browser.Name + "(전자책)");
            return parts.Count == 0 ? "쓸 수 있는 오피스 프로그램 없음" : string.Join("·", parts.ToArray()) + " 사용 가능";
        }

        static readonly string[] HwpExt = { "hwp", "hwpx", "hwt", "hml", "owpml" };
        static readonly string[] WordExt = { "doc", "docx", "docm", "dot", "dotx", "dotm", "rtf", "odt" };
        static readonly string[] ExcelExt = { "xls", "xlsx", "xlsm", "xlsb", "ods", "csv" };
        static readonly string[] PptExt = { "ppt", "pptx", "pptm", "pps", "ppsx", "odp" };
        static readonly string[] HtmlExt = { "html", "htm" };

        // 이 확장자를 어느 프로그램이 맡을지(워드가 없으면 한글이 워드 문서도 연다)
        string Pick(string ext)
        {
            if (Array.IndexOf(HwpExt, ext) >= 0) return Has("hwp") ? "hwp" : null;
            if (Array.IndexOf(WordExt, ext) >= 0) return Has("word") ? "word" : Has("hwp") && ext != "odt" ? "hwp" : null;
            if (Array.IndexOf(ExcelExt, ext) >= 0) return Has("excel") ? "excel" : null;
            if (Array.IndexOf(PptExt, ext) >= 0) return Has("powerpoint") ? "powerpoint" : null;
            if (Array.IndexOf(HtmlExt, ext) >= 0) return Has("browser") ? "browser" : null;
            return null;
        }

        public string Unsupported(string ext, string to)
        {
            if (to != "pdf" && to != "docx" && to != "hwpx" && to != "txt") return "알 수 없는 변환 형식입니다";
            string app = Pick(ext);
            if (app == null)
            {
                if (Array.IndexOf(HwpExt, ext) >= 0) return "한글 프로그램이 없어 한글 문서를 바꿀 수 없습니다";
                if (Array.IndexOf(WordExt, ext) >= 0) return "워드(또는 한글) 프로그램이 없어 워드 문서를 바꿀 수 없습니다";
                if (Array.IndexOf(ExcelExt, ext) >= 0) return "엑셀 프로그램이 없습니다";
                if (Array.IndexOf(PptExt, ext) >= 0) return "파워포인트 프로그램이 없습니다";
                if (Array.IndexOf(HtmlExt, ext) >= 0) return "엣지·크롬이 없어 전자책을 PDF로 바꿀 수 없습니다";
                return "DRE가 다룰 수 없는 파일 형식입니다(." + ext + ")";
            }
            if (app == "browser" && to != "pdf") return "전자책은 PDF로만 바꿀 수 있습니다";
            if (to == "hwpx" && app != "hwp") return "HWPX로는 한글 문서만 바꿀 수 있습니다";
            if (to == "docx" && app != "word") return "DOCX로는 워드 문서만 바꿀 수 있습니다";
            if (to == "txt" && app != "hwp" && app != "word") return "글자 파일로는 한글·워드 문서만 바꿀 수 있습니다";
            return null;
        }

        public void Start()
        {
            worker = new Thread(Loop);
            worker.SetApartmentState(ApartmentState.STA);
            worker.IsBackground = true; worker.Name = "converter";
            worker.Start();
            var wd = new Thread(Watchdog);
            wd.IsBackground = true; wd.Name = "watchdog";
            wd.Start();
        }

        public Job Enqueue(string src, string dst, string ext, string to, long size)
        {
            var j = new Job { Src = src, Dst = dst, Ext = ext, To = to, Size = size };
            lock (gate) queue.Enqueue(j);
            signal.Set();
            return j;
        }

        public void Cancel(Job j)
        {
            j.Cancelled = true;
            lock (gate)
            {
                if (queue.Contains(j))
                {
                    var keep = new Queue<Job>();
                    while (queue.Count > 0) { var x = queue.Dequeue(); if (x != j) keep.Enqueue(x); }
                    while (keep.Count > 0) queue.Enqueue(keep.Dequeue());
                    j.Fail("cancelled", "취소했습니다");
                    j.Done.Set();
                    return;
                }
            }
            if (current == j) KillCurrent();
        }

        public void CancelAll()
        {
            lock (gate)
            {
                while (queue.Count > 0) { var x = queue.Dequeue(); x.Cancelled = true; x.Fail("cancelled", "취소했습니다"); x.Done.Set(); }
            }
            var c = current;
            if (c != null) { c.Cancelled = true; KillCurrent(); }
        }

        void KillCurrent()
        {
            var c = current;
            if (c == null || c.UsedApp == null) return;
            if (c.UsedApp == "browser") { Browser.KillTree(browserProc); return; }
            Session s;
            if (sessions.TryGetValue(c.UsedApp, out s)) s.Kill();
        }

        public void Shutdown()
        {
            shutdown = true;
            CancelAll();
            signal.Set();
            if (worker != null) worker.Join(6000);
        }

        static int TimeoutSeconds(Job j)
        {
            // 기본 3분 + 1MB당 20초, 최대 20분
            long mb = j.Size / (1024 * 1024);
            return (int)Math.Min(1200, 180 + mb * 20);
        }

        void Watchdog()
        {
            while (!shutdown)
            {
                Thread.Sleep(1000);
                try { WatchOnce(); } catch (Exception e) { Log.Write("감시 오류 " + e.Message); }
            }
        }

        DateTime dialogSince = DateTime.MinValue;
        double dialogCpu = 0;

        void WatchOnce()
        {
            {
                var c = current;
                if (c != null && c.Started != DateTime.MinValue && !c.TimedOut && c.UsedApp != null)
                {
                    // 우리가 숨겨 띄운 프로그램이 화면에 창(확인·암호·오류 창)을 띄우고 일을 멈췄으면 6초 뒤 끊는다
                    Session s;
                    if (sessions.TryGetValue(c.UsedApp, out s) && !s.Shared && s.Pid != 0 && Win.HasVisibleWindow(s.Pid))
                    {
                        double cpu = 0;
                        try { using (var p = Process.GetProcessById(s.Pid)) cpu = p.TotalProcessorTime.TotalSeconds; } catch { }
                        if (dialogSince == DateTime.MinValue) { dialogSince = DateTime.Now; dialogCpu = cpu; }
                        else if ((DateTime.Now - dialogSince).TotalSeconds >= 6)
                        {
                            if (cpu - dialogCpu < 0.5)
                            {
                                c.Fail("dialog", Session.AppName(c.UsedApp) + "이(가) 확인 창을 띄우고 멈춰서 중단했습니다(암호·보안 확인·손상 경고일 수 있습니다)");
                                c.TimedOut = true;
                                Log.Write("확인 창 때문에 끊음 " + Path.GetFileName(c.Src));
                                KillCurrent();
                            }
                            dialogSince = DateTime.Now; dialogCpu = cpu;
                        }
                    }
                    else dialogSince = DateTime.MinValue;
                }
                if (c == null || c.Started == DateTime.MinValue) return;
                if (!c.TimedOut && (DateTime.Now - c.Started).TotalSeconds > TimeoutSeconds(c))
                {
                    c.TimedOut = true;
                    Log.Write("시간 초과로 끊음 " + Path.GetFileName(c.Src));
                    KillCurrent();
                }
            }
        }

        void Loop()
        {
            if (Program.Config.Debug.IndexOf("nofilter") < 0) MessageFilter.Register();
            while (!shutdown)
            {
                try
                {
                    Job j = null;
                    lock (gate) if (queue.Count > 0) j = queue.Dequeue();
                    if (j == null)
                    {
                        signal.WaitOne(5000);
                        CloseIdle(false);
                        continue;
                    }
                    Run(j);
                }
                catch (Exception e) { Log.Write("일꾼 오류 " + e); }
            }
            try { CloseIdle(true); } catch (Exception e) { Log.Write("마무리 오류 " + e.Message); }
        }

        void Run(Job j)
        {
            var sw = Stopwatch.StartNew();
            current = j;
            try
            {
                if (j.Cancelled) throw new ConvertError("cancelled", "취소했습니다");
                string kind = Pick(j.Ext);
                if (kind == null) throw new ConvertError("no_app", "이 파일을 열 프로그램이 없습니다");
                j.UsedApp = kind;
                if (kind == "browser")
                {
                    // 전자책: 오피스처럼 띄워 두지 않고 일마다 새로 띄웠다 끝낸다
                    j.Started = DateTime.Now;
                    RunBrowser(j);
                    if (j.TimedOut) throw new ConvertError("timeout", "변환이 너무 오래 걸려 멈췄습니다");
                    if (j.Cancelled) throw new ConvertError("cancelled", "취소했습니다");
                    if (!File.Exists(j.Dst) || new FileInfo(j.Dst).Length == 0) throw new ConvertError("failed", Browser.Name + "이(가) PDF를 만들지 못했습니다");
                    return;
                }
                var s = sessions[kind];
                if (!s.Alive) { s.Release(); s.Create(); Prepare(s); }
                j.Started = DateTime.Now;
                try
                {
                    switch (kind)
                    {
                        case "hwp": RunHwp(s, j); break;
                        case "word": RunWord(s, j); break;
                        case "excel": RunExcel(s, j); break;
                        case "powerpoint": RunPpt(s, j); break;
                    }
                }
                catch (ConvertError) { throw; }
                catch (Exception e)
                {
                    if (j.ErrorCode == "dialog") throw new ConvertError("dialog", j.Error);
                    if (j.TimedOut) throw new ConvertError("timeout", "변환이 너무 오래 걸려 멈췄습니다");
                    if (j.Cancelled) throw new ConvertError("cancelled", "취소했습니다");
                    // 프로그램이 죽었거나 대답이 없으면 다음 일을 위해 새로 띄우게 한다
                    s.Kill(); s.Release();
                    string m = e.Message ?? "";
                    if (m.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0 || m.IndexOf("암호", StringComparison.Ordinal) >= 0)
                        throw new ConvertError("password", "암호가 걸린 문서입니다");
                    throw new ConvertError("failed", Session.AppName(kind) + "이(가) 변환하지 못했습니다: " + Short(m));
                }
                if (j.TimedOut) throw new ConvertError("timeout", "변환이 너무 오래 걸려 멈췄습니다");
                if (j.Cancelled) throw new ConvertError("cancelled", "취소했습니다");
                if (!File.Exists(j.Dst) || new FileInfo(j.Dst).Length == 0) throw new ConvertError("failed", "결과 파일이 만들어지지 않았습니다");
                s.LastUsed = DateTime.Now;
            }
            catch (ConvertError e) { j.Fail(e.Code, e.Message); Log.Write("실패 " + Path.GetFileName(j.Src) + " " + e.Code + " " + e.Message); }
            catch (Exception e) { j.Fail("failed", Short(e.Message)); Log.Write("실패 " + Path.GetFileName(j.Src) + " " + e); }
            finally
            {
                j.Elapsed = sw.Elapsed;
                current = null;
                j.Done.Set();
                if (j.ErrorCode == null) Log.Write("완료 " + j.Ext + "→" + j.To + " " + (int)sw.Elapsed.TotalMilliseconds + "ms");
            }
        }

        static string Short(string m)
        {
            m = (m ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
            return m.Length > 160 ? m.Substring(0, 160) + "…" : m;
        }

        void Prepare(Session s)
        {
            dynamic a = s.App;
            switch (s.Kind)
            {
                case "hwp":
                    // 알림창이 뜨면 자동으로 답한다: 확인→확인, 확인/취소→확인, 중단/재시도/무시→무시, 예/아니오/취소→아니오, 예/아니오→예, 재시도/취소→취소
                    try { a.SetMessageBoxMode(0x00212411); } catch { }
                    try { a.XHwpWindows.Item(0).Visible = false; } catch { }
                    break;
                case "word":
                    try { a.Visible = false; } catch { }
                    try { a.DisplayAlerts = 0; } catch { }
                    try { a.ScreenUpdating = false; } catch { }
                    try { a.AutomationSecurity = 3; } catch { }  // 매크로 끄기
                    try { a.Options.UpdateLinksAtOpen = false; } catch { }
                    break;
                case "excel":
                    try { a.Visible = false; } catch { }
                    try { a.DisplayAlerts = false; } catch { }
                    try { a.ScreenUpdating = false; } catch { }
                    try { a.AutomationSecurity = 3; } catch { }
                    try { a.AskToUpdateLinks = false; } catch { }
                    break;
                case "powerpoint":
                    try { a.DisplayAlerts = 1; } catch { } // ppAlertsNone
                    try { a.AutomationSecurity = 3; } catch { }
                    break;
            }
        }

        void RunHwp(Session s, Job j)
        {
            dynamic h = s.App;
            bool ok = h.Open(j.Src, "", "forceopen:true;suspendpassword:true;versionwarning:false;lock:false");
            if (!ok) throw new ConvertError("open_failed", "한글이 문서를 열지 못했습니다(암호가 걸렸거나 손상된 파일일 수 있습니다)");
            try
            {
                // 문서에 '모아 찍기(한 장에 여러 쪽)'·'나눠 찍기' 인쇄 설정이 저장돼 있으면 PDF 도 그렇게 나온다(실측).
                // HWPX 로 저장 → settings.xml 의 인쇄 방법을 기본(0)으로 고침 → 다시 열어 PDF 로.
                if (j.To == "pdf")
                {
                    int pm = HwpPrintMethod(h);
                    if (pm > 1)
                    {
                        string fix = Path.Combine(Path.GetDirectoryName(j.Dst), "printfix.hwpx");
                        bool saved0 = h.SaveAs(fix, "HWPX", "");
                        try { h.Clear(1); } catch { }
                        if (saved0 && File.Exists(fix) && PatchHwpxPrint(fix))
                        {
                            bool ok2 = h.Open(fix, "HWPX", "forceopen:true;versionwarning:false;lock:false");
                            if (!ok2) throw new ConvertError("failed", "한글이 인쇄 설정을 고친 문서를 다시 열지 못했습니다");
                            Log.Write("모아 찍기 설정(" + pm + ")을 풀고 변환");
                        }
                        else
                        {
                            bool ok3 = h.Open(j.Src, "", "forceopen:true;suspendpassword:true;versionwarning:false;lock:false");
                            if (!ok3) throw new ConvertError("open_failed", "한글이 문서를 다시 열지 못했습니다");
                            Log.Write("모아 찍기 설정을 풀지 못함(" + pm + ")");
                        }
                    }
                }
                string fmt = j.To == "pdf" ? "PDF" : j.To == "hwpx" ? "HWPX" : "UNICODE";
                bool saved = h.SaveAs(j.Dst, fmt, j.To == "txt" ? "code:unicode" : "");
                if (!saved) throw new ConvertError("failed", "한글이 결과 파일을 저장하지 못했습니다(배포용 문서는 인쇄·저장이 막혀 있을 수 있습니다)");
            }
            finally
            {
                try { h.Clear(1); } catch { }
            }
        }

        // 한글 문서에 저장된 인쇄 방법(0 자동, 1 용지 맞춤, 2 나눠 찍기, 3~ 모아 찍기)
        static int HwpPrintMethod(dynamic h)
        {
            object act = null, set = null;
            try
            {
                act = h.CreateAction("Print");
                dynamic a = act;
                set = a.CreateSet();
                a.GetDefault(set);
                dynamic st = set;
                return Convert.ToInt32(st.Item("PrintMethod"));
            }
            catch { return 0; }
            finally
            {
                if (set != null) { try { Marshal.FinalReleaseComObject(set); } catch { } }
                if (act != null) { try { Marshal.FinalReleaseComObject(act); } catch { } }
            }
        }

        // HWPX 속 settings.xml 의 인쇄 방법을 0, 확대 비율을 100 으로
        static bool PatchHwpxPrint(string path)
        {
            try
            {
                using (var za = ZipFile.Open(path, ZipArchiveMode.Update))
                {
                    var e = za.GetEntry("settings.xml");
                    if (e == null) return false;
                    string xml;
                    using (var r = new StreamReader(e.Open(), Encoding.UTF8)) xml = r.ReadToEnd();
                    string fixedXml = Regex.Replace(xml, "(name=\"PrintMethod\"[^>]*>)\\s*\\d+", "${1}0");
                    fixedXml = Regex.Replace(fixedXml, "(name=\"Zoom[XY]\"[^>]*>)\\s*\\d+", "${1}100");
                    if (fixedXml == xml) return false;
                    e.Delete();
                    var ne = za.CreateEntry("settings.xml", CompressionLevel.Optimal);
                    using (var w = new StreamWriter(ne.Open(), new UTF8Encoding(false))) w.Write(fixedXml);
                }
                return true;
            }
            catch (Exception ex) { Log.Write("인쇄 설정 고치기 실패 " + ex.Message); return false; }
        }

        void RunWord(Session s, Job j)
        {
            dynamic w = s.App;
            dynamic doc = null;
            try
            {
                try
                {
                    // 암호를 묻는 창이 뜨지 않게 일부러 틀린 암호를 준다(암호 없는 문서에는 영향 없음)
                    doc = w.Documents.Open(FileName: j.Src, ConfirmConversions: false, ReadOnly: true, AddToRecentFiles: false,
                        PasswordDocument: "\u0001dre", WritePasswordDocument: "\u0001dre", Revert: false, Visible: false, NoEncodingDialog: true);
                }
                catch (COMException e)
                {
                    string m = e.Message ?? "";
                    if (m.IndexOf("암호", StringComparison.Ordinal) >= 0 || m.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0)
                        throw new ConvertError("password", "암호가 걸린 문서입니다");
                    throw new ConvertError("open_failed", "워드가 문서를 열지 못했습니다: " + Short(m));
                }
                if (j.To == "pdf")
                    doc.ExportAsFixedFormat(OutputFileName: j.Dst, ExportFormat: 17, OpenAfterExport: false, OptimizeFor: 0, Range: 0,
                        Item: 0, IncludeDocProps: true, KeepIRM: true, CreateBookmarks: 1, DocStructureTags: true, BitmapMissingFonts: true, UseISO19005_1: false);
                else if (j.To == "docx")
                    doc.SaveAs2(FileName: j.Dst, FileFormat: 16, AddToRecentFiles: false);
                else
                    doc.SaveAs2(FileName: j.Dst, FileFormat: 7, AddToRecentFiles: false); // 유니코드 글자
            }
            finally
            {
                if (doc != null) { try { doc.Close(SaveChanges: 0); } catch { } try { Marshal.FinalReleaseComObject(doc); } catch { } }
            }
        }

        void RunExcel(Session s, Job j)
        {
            dynamic x = s.App;
            dynamic wb = null;
            try
            {
                try
                {
                    wb = x.Workbooks.Open(Filename: j.Src, UpdateLinks: 0, ReadOnly: true, Password: "\u0001dre", WriteResPassword: "\u0001dre",
                        IgnoreReadOnlyRecommended: true, Notify: false, AddToMru: false);
                }
                catch (COMException e)
                {
                    string m = e.Message ?? "";
                    if (m.IndexOf("암호", StringComparison.Ordinal) >= 0 || m.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0)
                        throw new ConvertError("password", "암호가 걸린 문서입니다");
                    throw new ConvertError("open_failed", "엑셀이 문서를 열지 못했습니다: " + Short(m));
                }
                wb.ExportAsFixedFormat(Type: 0, Filename: j.Dst, Quality: 0, IncludeDocProperties: true, IgnorePrintAreas: false, OpenAfterPublish: false);
            }
            finally
            {
                if (wb != null) { try { wb.Close(SaveChanges: false); } catch { } try { Marshal.FinalReleaseComObject(wb); } catch { } }
            }
        }

        void RunPpt(Session s, Job j)
        {
            dynamic p = s.App;
            dynamic pres = null;
            try
            {
                try { pres = p.Presentations.Open(FileName: j.Src + "::\u0001dre", ReadOnly: -1, Untitled: 0, WithWindow: 0); }
                catch (COMException e)
                {
                    string m = e.Message ?? "";
                    if (m.IndexOf("암호", StringComparison.Ordinal) >= 0 || m.IndexOf("password", StringComparison.OrdinalIgnoreCase) >= 0)
                        throw new ConvertError("password", "암호가 걸린 문서입니다");
                    throw new ConvertError("open_failed", "파워포인트가 문서를 열지 못했습니다: " + Short(m));
                }
                pres.SaveAs(j.Dst, 32); // ppSaveAsPDF
            }
            finally
            {
                if (pres != null) { try { pres.Close(); } catch { } try { Marshal.FinalReleaseComObject(pres); } catch { } }
            }
        }

        // 지금 인쇄 중인 브라우저(취소·시간 초과 때 그 묶음만 끈다)
        volatile Process browserProc;

        // 전자책(EPUB) → PDF: 앱이 장들을 이어 붙인 HTML 한 장(그림·글꼴은 파일 안, 스크립트·밖 연결은 빠짐)을 브라우저로 인쇄한다.
        // 사용자의 엣지와 섞이지 않게 일마다 새 빈 프로필(임시 폴더)로 화면 없이 띄우고, 인쇄가 끝나면 브라우저가 스스로 끝난다.
        void RunBrowser(Job j)
        {
            string dir = Path.GetDirectoryName(j.Dst);
            string profile = Path.Combine(dir, "browser-profile");
            Directory.CreateDirectory(profile);
            string[] args = {
                "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-features=Translate,MediaRouter",
                "--mute-audio", "--no-pdf-header-footer", "--generate-pdf-document-outline",
                "--user-data-dir=" + profile, "--print-to-pdf=" + j.Dst, new Uri(j.Src).AbsoluteUri
            };
            var psi = new ProcessStartInfo(Browser.Exe, Browser.JoinArgs(args));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.WorkingDirectory = dir;
            var p = Process.Start(psi);
            if (p == null) throw new ConvertError("no_app", Browser.Name + "을(를) 띄우지 못했습니다");
            browserProc = p;
            try
            {
                Log.Write(Browser.Name + " 인쇄 시작 pid=" + p.Id + " " + Path.GetFileName(j.Src));
                while (!p.WaitForExit(500))
                {
                    if (j.Cancelled || j.TimedOut) { Browser.KillTree(p); break; }
                }
                p.WaitForExit(5000);
            }
            finally
            {
                browserProc = null;
                p.Dispose();
            }
        }

        // 한동안 일이 없으면 오피스 프로그램을 닫아 메모리를 돌려준다
        void CloseIdle(bool all)
        {
            bool closed = false;
            foreach (var s in sessions.Values)
            {
                if (s.AppObj == null) continue;
                if (!all && (DateTime.Now - s.LastUsed).TotalSeconds < IdleCloseSeconds) continue;
                try { CloseSession(s); } catch (Exception e) { Log.Write(s.Kind + " 닫기 실패 " + e.Message); try { s.Kill(); s.Release(); } catch { } }
                closed = true;
            }
            if (closed) TrimMemory();
        }

        [DllImport("kernel32.dll")]
        static extern bool SetProcessWorkingSetSize(IntPtr proc, IntPtr min, IntPtr max);

        // 쉬는 동안 DRE.exe가 잡고 있는 메모리를 운영체제에 돌려준다
        public static void TrimMemory()
        {
            try
            {
                GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
                using (var me = Process.GetCurrentProcess()) SetProcessWorkingSetSize(me.Handle, (IntPtr)(-1), (IntPtr)(-1));
            }
            catch { }
        }

        void CloseSession(Session s)
        {
            dynamic a = s.App;
            bool handedOver = false;
            try
            {
                if (!s.Dead)
                {
                    switch (s.Kind)
                    {
                        case "hwp":
                            // 주의: 끝내기 전에 XHwpDocuments 를 들여다보면(Item(i).Path) 한글 2024가 끝내기 도중 죽는다(실측). 그냥 끈다.
                            if (!s.Shared) a.Quit();
                            break;
                        case "word":
                            int dc = 0;
                            try { dc = a.Documents.Count; } catch { }
                            if (dc > 0) { try { a.Visible = true; a.ScreenUpdating = true; } catch { } handedOver = true; }
                            else if (!s.Shared) { try { a.NormalTemplate.Saved = true; } catch { } a.Quit(0); }
                            break;
                        case "excel":
                            int wc = 0;
                            try { wc = a.Workbooks.Count; } catch { }
                            if (wc > 0) { try { a.Visible = true; a.ScreenUpdating = true; } catch { } handedOver = true; }
                            else if (!s.Shared) a.Quit();
                            break;
                        case "powerpoint":
                            int pc = 0;
                            try { pc = a.Presentations.Count; } catch { }
                            if (pc == 0 && !s.Shared) a.Quit();
                            else handedOver = true;
                            break;
                    }
                }
            }
            catch (Exception e) { Log.Write(s.Kind + " 닫기 오류 " + e.Message); }
            s.Release();
            int pid = s.Pid;
            bool shared = s.Shared;
            s.Pid = 0;
            Log.Write(s.Kind + (handedOver ? " 사용자에게 넘김" : " 닫음"));
            if (!handedOver && !shared && pid != 0)
            {
                // 몇 초 안에 안 꺼지면 강제로 끈다(우리가 띄운 것만)
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try
                    {
                        using (var p = Process.GetProcessById(pid))
                        {
                            if (!p.WaitForExit(8000)) { p.Kill(); Log.Write(s.Kind + " 남은 프로세스 정리 pid=" + pid); }
                        }
                    }
                    catch { }
                });
            }
        }
    }

    // 화면 없이 인쇄할 브라우저: 엣지(윈도우 기본) → 없으면 크롬
    static class Browser
    {
        public static readonly string Exe = Find();
        public static string Name { get { return Exe != null && Path.GetFileName(Exe).ToLowerInvariant().StartsWith("chrome") ? "크롬" : "엣지"; } }

        static string Find()
        {
            foreach (var exe in new[] { "msedge.exe", "chrome.exe" })
            {
                foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
                {
                    foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                    {
                        try
                        {
                            using (var b = RegistryKey.OpenBaseKey(hive, view))
                            using (var k = b.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                            {
                                var v = k == null ? null : k.GetValue("") as string;
                                if (!string.IsNullOrEmpty(v)) { v = v.Trim().Trim('"'); if (File.Exists(v)) return v; }
                            }
                        }
                        catch { }
                    }
                }
            }
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            foreach (var p in new[] {
                Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"), Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"), Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(local, @"Google\Chrome\Application\chrome.exe") })
            {
                try { if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p; } catch { }
            }
            return null;
        }

        // 명령줄 인자 묶기(빈칸·따옴표가 있으면 따옴표로 — 윈도우 규칙)
        public static string JoinArgs(string[] args)
        {
            var sb = new StringBuilder();
            foreach (var a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
                sb.Append('"');
                int bs = 0;
                foreach (char ch in a)
                {
                    if (ch == '\\') { bs++; continue; }
                    if (ch == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
                    if (bs > 0) { sb.Append('\\', bs); bs = 0; }
                    sb.Append(ch);
                }
                if (bs > 0) sb.Append('\\', bs * 2);
                sb.Append('"');
            }
            return sb.ToString();
        }

        // 우리가 띄운 브라우저와 그 아래 프로세스만 끈다(사용자가 쓰는 엣지는 건드리지 않는다)
        public static void KillTree(Process p)
        {
            if (p == null) return;
            int pid;
            try { if (p.HasExited) return; pid = p.Id; } catch { return; }
            try
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (var k = Process.Start(psi)) { if (k != null) k.WaitForExit(10000); }
                Log.Write("브라우저 끔 pid=" + pid);
            }
            catch (Exception e)
            {
                Log.Write("브라우저 끄기 실패 " + e.Message);
                try { p.Kill(); } catch { }
            }
        }
    }

    static class Win
    {
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        // 그 프로세스의 보이는 최상위 창(작은 점 같은 것은 빼고)이 있나
        public static bool HasVisibleWindow(int pid)
        {
            bool found = false;
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p == (uint)pid && IsWindowVisible(h))
                {
                    RECT r;
                    if (GetWindowRect(h, out r) && (r.R - r.L) > 60 && (r.B - r.T) > 40) { found = true; return false; }
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }
    }

    // 오피스가 "바쁨"이라고 답하면 잠시 뒤 다시 부르게 한다(자동화에서 흔한 오류 방지)
    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOleMessageFilter
    {
        [PreserveSig] int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);
        [PreserveSig] int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
    }

    class MessageFilter : IOleMessageFilter
    {
        [DllImport("Ole32.dll")]
        static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);

        public static void Register()
        {
            IOleMessageFilter old;
            try { CoRegisterMessageFilter(new MessageFilter(), out old); } catch { }
        }

        public int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo) { return 0; }
        public int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType)
        {
            if (dwRejectType == 2 && dwTickCount < 60000) return 200; // SERVERCALL_RETRYLATER → 0.2초 뒤 다시
            return -1;
        }
        public int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType) { return 2; }
    }
}

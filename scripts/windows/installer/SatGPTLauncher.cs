using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace SatGPT.Launcher
{
    internal sealed class LauncherForm : Form
    {
        private readonly string _rootDir;
        private readonly string _pythonExe;
        private readonly string _nodeExe;
        private readonly string _frontendScript;
        private readonly string _configScript;

        private Process _backendProc;
        private Process _frontendProc;
        private int _frontendPort = 3000;
        private int _agentPort = 8000;
        private bool _closing;

        private Label _lblEnvBanner;
        private Panel _dotFrontend;
        private Label _lblFrontendStatus;
        private Panel _dotBackend;
        private Label _lblBackendStatus;
        private Button _btnStart;
        private Button _btnStop;
        private Button _btnOpenWeb;
        private Button _btnOpenDir;
        private Button _btnImportEnv;
        private Button _btnImportCred;
        private TextBox _txtLog;
        private System.Windows.Forms.Timer _pollTimer;

        private static readonly Color AccentColor = Color.FromArgb(15, 118, 110);
        private static readonly Color OkColor = Color.FromArgb(5, 150, 105);
        private static readonly Color WarnColor = Color.FromArgb(217, 119, 6);
        private static readonly Color MutedColor = Color.FromArgb(148, 163, 184);
        private static readonly Color ErrColor = Color.FromArgb(220, 38, 38);
        private static readonly Color BorderColor = Color.FromArgb(226, 232, 240);

        public LauncherForm()
        {
            _rootDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            _pythonExe = Path.Combine(_rootDir, "runtime", "python", "python.exe");
            _nodeExe = Path.Combine(_rootDir, "runtime", "node", "node.exe");
            _frontendScript = Path.Combine(_rootDir, "frontend", "server.cjs");
            _configScript = Path.Combine(_rootDir, "satgpt_config.py");

            Text = "SatGPT 服务启动器";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(680, 480);
            BackColor = Color.FromArgb(245, 247, 250);
            Font = new Font("Microsoft YaHei UI", 9.5f);

            LoadPortsFromEnv();
            BuildUI();
            RefreshEnvBanner();

            _pollTimer = new System.Windows.Forms.Timer();
            _pollTimer.Interval = 2500;
            _pollTimer.Tick += delegate { PollHealthAsync(); };
            _pollTimer.Start();
            PollHealthAsync();

            FormClosing += OnFormClosing;
        }

        private void BuildUI()
        {
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 64;
            header.BackColor = AccentColor;

            Label title = new Label();
            title.Text = "SatGPT 本地服务启动器";
            title.ForeColor = Color.White;
            title.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(20, 12);
            header.Controls.Add(title);

            Label sub = new Label();
            sub.Text = "安装目录：" + _rootDir;
            sub.ForeColor = Color.FromArgb(204, 251, 241);
            sub.Font = new Font("Microsoft YaHei UI", 8.5f);
            sub.AutoEllipsis = true;
            sub.Size = new Size(636, 18);
            sub.Location = new Point(21, 39);
            header.Controls.Add(sub);

            Controls.Add(header);

            // Env notice banner
            _lblEnvBanner = new Label();
            _lblEnvBanner.Location = new Point(20, 76);
            _lblEnvBanner.Size = new Size(640, 32);
            _lblEnvBanner.TextAlign = ContentAlignment.MiddleLeft;
            _lblEnvBanner.Padding = new Padding(10, 0, 10, 0);
            _lblEnvBanner.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            Controls.Add(_lblEnvBanner);

            // Status cards
            Panel feCard = MakeCard(20, 118, 312, 68);
            _dotFrontend = MakeDot(16, 26, MutedColor);
            feCard.Controls.Add(_dotFrontend);
            Label feTitle = new Label();
            feTitle.Text = "前端网页服务（Node 网关）";
            feTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            feTitle.AutoSize = true;
            feTitle.Location = new Point(36, 12);
            feCard.Controls.Add(feTitle);
            _lblFrontendStatus = new Label();
            _lblFrontendStatus.Text = "未启动（端口 " + _frontendPort + "）";
            _lblFrontendStatus.ForeColor = Color.FromArgb(100, 116, 139);
            _lblFrontendStatus.Font = new Font("Microsoft YaHei UI", 8.5f);
            _lblFrontendStatus.AutoSize = true;
            _lblFrontendStatus.Location = new Point(36, 36);
            feCard.Controls.Add(_lblFrontendStatus);
            Controls.Add(feCard);

            Panel beCard = MakeCard(348, 118, 312, 68);
            _dotBackend = MakeDot(16, 26, MutedColor);
            beCard.Controls.Add(_dotBackend);
            Label beTitle = new Label();
            beTitle.Text = "统一后端（Basic + Harness）";
            beTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            beTitle.AutoSize = true;
            beTitle.Location = new Point(36, 12);
            beCard.Controls.Add(beTitle);
            _lblBackendStatus = new Label();
            _lblBackendStatus.Text = "未启动（端口 " + _agentPort + "）";
            _lblBackendStatus.ForeColor = Color.FromArgb(100, 116, 139);
            _lblBackendStatus.Font = new Font("Microsoft YaHei UI", 8.5f);
            _lblBackendStatus.AutoSize = true;
            _lblBackendStatus.Location = new Point(36, 36);
            beCard.Controls.Add(_lblBackendStatus);
            Controls.Add(beCard);

            // Action row (6 cleanly spaced buttons across 640px)
            _btnStart = MakeButton("启动服务", true);
            _btnStart.Size = new Size(96, 36);
            _btnStart.Location = new Point(20, 198);
            _btnStart.Click += delegate { StartServices(); };

            _btnStop = MakeButton("停止服务", false);
            _btnStop.Size = new Size(84, 36);
            _btnStop.Location = new Point(125, 198);
            _btnStop.ForeColor = ErrColor;
            _btnStop.Enabled = false;
            _btnStop.Click += delegate { StopServices(); };

            _btnOpenWeb = MakeButton("打开网页", false);
            _btnOpenWeb.Size = new Size(92, 36);
            _btnOpenWeb.Location = new Point(218, 198);
            _btnOpenWeb.Click += delegate
            {
                LoadPortsFromEnv();
                string url = "http://127.0.0.1:" + _frontendPort + "/";
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
                catch (Exception ex) { AppendLog("[ERROR] 无法打开浏览器：" + ex.Message); }
            };

            _btnImportEnv = MakeButton("导入 .env", false);
            _btnImportEnv.Size = new Size(96, 36);
            _btnImportEnv.Location = new Point(319, 198);
            _btnImportEnv.Click += OnImportEnv;

            _btnImportCred = MakeButton("导入密钥 JSON", false);
            _btnImportCred.Size = new Size(134, 36);
            _btnImportCred.Location = new Point(424, 198);
            _btnImportCred.Click += OnImportCred;

            _btnOpenDir = MakeButton("打开目录", false);
            _btnOpenDir.Size = new Size(93, 36);
            _btnOpenDir.Location = new Point(567, 198);
            _btnOpenDir.Click += delegate
            {
                try { Process.Start("explorer.exe", _rootDir); } catch { }
            };

            Controls.Add(_btnStart);
            Controls.Add(_btnStop);
            Controls.Add(_btnOpenWeb);
            Controls.Add(_btnImportEnv);
            Controls.Add(_btnImportCred);
            Controls.Add(_btnOpenDir);

            // Log console
            Label logLbl = new Label();
            logLbl.Text = "运行日志";
            logLbl.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
            logLbl.ForeColor = Color.FromArgb(71, 85, 105);
            logLbl.AutoSize = true;
            logLbl.Location = new Point(20, 246);
            Controls.Add(logLbl);

            _txtLog = new TextBox();
            _txtLog.Multiline = true;
            _txtLog.ReadOnly = true;
            _txtLog.ScrollBars = ScrollBars.Vertical;
            _txtLog.BackColor = Color.FromArgb(15, 23, 42);
            _txtLog.ForeColor = Color.FromArgb(226, 232, 240);
            _txtLog.Font = new Font("Consolas", 8.5f);
            _txtLog.Location = new Point(20, 268);
            _txtLog.Size = new Size(640, 194);
            Controls.Add(_txtLog);
        }

        private Panel MakeCard(int x, int y, int w, int h)
        {
            Panel p = new Panel();
            p.Location = new Point(x, y);
            p.Size = new Size(w, h);
            p.BackColor = Color.White;
            p.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen pen = new Pen(BorderColor)) e.Graphics.DrawRectangle(pen, 0, 0, p.Width - 1, p.Height - 1);
            };
            return p;
        }

        private Panel MakeDot(int x, int y, Color c)
        {
            Panel d = new Panel();
            d.Location = new Point(x, y);
            d.Size = new Size(12, 12);
            d.BackColor = Color.White;
            d.Tag = c;
            d.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                Color dotColor = (d.Tag is Color) ? (Color)d.Tag : MutedColor;
                using (SolidBrush br = new SolidBrush(dotColor))
                {
                    e.Graphics.FillEllipse(br, 1, 1, 9, 9);
                }
            };
            return d;
        }

        private Button MakeButton(string text, bool primary)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.FlatStyle = FlatStyle.Flat;
            btn.Cursor = Cursors.Hand;
            if (primary)
            {
                btn.BackColor = AccentColor;
                btn.ForeColor = Color.White;
                btn.FlatAppearance.BorderSize = 0;
            }
            else
            {
                btn.BackColor = Color.White;
                btn.ForeColor = Color.FromArgb(30, 41, 59);
                btn.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
                btn.FlatAppearance.BorderSize = 1;
            }
            return btn;
        }

        private void LoadPortsFromEnv()
        {
            _frontendPort = 3000;
            _agentPort = 8000;
            string envFile = Path.Combine(_rootDir, ".env");
            if (!File.Exists(envFile)) return;
            try
            {
                foreach (string raw in File.ReadAllLines(envFile, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    Match mFe = Regex.Match(line, @"^FRONTEND_PORT\s*=\s*['""]?(\d+)['""]?");
                    if (mFe.Success) int.TryParse(mFe.Groups[1].Value, out _frontendPort);
                    Match mBe = Regex.Match(line, @"^AGENT_PORT\s*=\s*['""]?(\d+)['""]?");
                    if (mBe.Success) int.TryParse(mBe.Groups[1].Value, out _agentPort);
                }
            }
            catch { }
        }

        private string ResolveCredentialTargetName()
        {
            string defaultName = ".private-key.json";
            string envFile = Path.Combine(_rootDir, ".env");
            if (!File.Exists(envFile)) return defaultName;
            try
            {
                foreach (string raw in File.ReadAllLines(envFile, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    Match m = Regex.Match(line, @"^GOOGLE_APPLICATION_CREDENTIALS\s*=\s*(.+)$");
                    if (!m.Success) continue;
                    string val = m.Groups[1].Value.Trim();
                    if ((val.StartsWith("'") && val.EndsWith("'")) || (val.StartsWith("\"") && val.EndsWith("\"")))
                    {
                        if (val.Length >= 2) val = val.Substring(1, val.Length - 2).Trim();
                    }
                    if (string.IsNullOrEmpty(val)) return defaultName;
                    if (Path.IsPathRooted(val) || val.Contains("..") || val.Contains(":")) return defaultName;
                    return val.Replace('/', '\\').TrimStart('\\');
                }
            }
            catch { }
            return defaultName;
        }

        private bool ImportCredential(string sourcePath, out string savedName, out string error)
        {
            savedName = ResolveCredentialTargetName();
            error = "";
            try
            {
                string text = File.ReadAllText(sourcePath, Encoding.UTF8).TrimStart('\uFEFF').Trim();
                if (!text.StartsWith("{") || !text.EndsWith("}")
                    || !Regex.IsMatch(text, @"""type""\s*:\s*""service_account""")
                    || !Regex.IsMatch(text, @"""private_key""\s*:\s*""[^""]*PRIVATE KEY"))
                {
                    error = "不是有效的 GEE 服务账号密钥 JSON（需包含 type=service_account 与 private_key）。";
                    return false;
                }
                string rootFull = Path.GetFullPath(_rootDir).TrimEnd('\\') + "\\";
                string dst = Path.GetFullPath(Path.Combine(_rootDir, savedName));
                if (!dst.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
                {
                    error = "目标路径超出安装目录。";
                    return false;
                }
                string parent = Path.GetDirectoryName(dst);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                if (File.Exists(dst))
                {
                    File.Copy(dst, dst + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"), true);
                }
                File.WriteAllText(dst, text, new UTF8Encoding(false));
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static void ApplyImportButtonStyle(Button btn, bool exists, string defaultText, string readyText)
        {
            if (exists)
            {
                btn.Text = readyText;
                btn.BackColor = OkColor;
                btn.ForeColor = Color.White;
                btn.FlatAppearance.BorderColor = OkColor;
                btn.FlatAppearance.BorderSize = 0;
            }
            else
            {
                btn.Text = defaultText;
                btn.BackColor = Color.White;
                btn.ForeColor = Color.FromArgb(30, 41, 59);
                btn.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
                btn.FlatAppearance.BorderSize = 1;
            }
        }

        private void RefreshEnvBanner()
        {
            string envFile = Path.Combine(_rootDir, ".env");
            bool hasEnv = File.Exists(envFile);
            string credName = ResolveCredentialTargetName();
            bool hasCred = File.Exists(Path.Combine(_rootDir, credName));

            ApplyImportButtonStyle(_btnImportEnv, hasEnv, "导入 .env", "✓ 已有 .env");
            ApplyImportButtonStyle(_btnImportCred, hasCred, "导入密钥 JSON", "✓ 已有密钥");

            if (hasEnv && hasCred)
            {
                _lblEnvBanner.BackColor = Color.FromArgb(236, 253, 245);
                _lblEnvBanner.ForeColor = OkColor;
                _lblEnvBanner.Text = "✓ 已检测到 .env 与密钥文件（" + credName + "）· 前端端口 " + _frontendPort + "，后端端口 " + _agentPort;
            }
            else if (hasEnv && !hasCred)
            {
                _lblEnvBanner.BackColor = Color.FromArgb(255, 251, 235);
                _lblEnvBanner.ForeColor = WarnColor;
                _lblEnvBanner.Text = "! 已检测到 .env，但缺少 GEE 密钥文件（" + credName + "）：请点击「导入密钥 JSON」";
            }
            else if (!hasEnv && hasCred)
            {
                _lblEnvBanner.BackColor = Color.FromArgb(255, 251, 235);
                _lblEnvBanner.ForeColor = WarnColor;
                _lblEnvBanner.Text = "! 已检测到密钥文件，但缺少 .env：请点击「导入 .env」后再启动";
            }
            else
            {
                _lblEnvBanner.BackColor = Color.FromArgb(255, 251, 235);
                _lblEnvBanner.ForeColor = WarnColor;
                _lblEnvBanner.Text = "! 尚未导入配置文件：请先点击「导入 .env」和「导入密钥 JSON」后再启动";
            }
        }

        private void OnImportEnv(object sender, EventArgs e)
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择 SatGPT 配置文件 (.env)";
                dlg.Filter = "所有文件 (*.*)|*.*|环境配置文件 (*.env;*.env.*)|*.env;*.env.*";
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    string dst = Path.Combine(_rootDir, ".env");
                    if (File.Exists(dst))
                    {
                        File.Copy(dst, Path.Combine(_rootDir, ".env.bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss")), true);
                    }
                    File.Copy(dlg.FileName, dst, true);
                    LoadPortsFromEnv();
                    AppendLog("[INFO] 已导入 .env：" + dlg.FileName);

                    string credName = ResolveCredentialTargetName();
                    string sibling = Path.Combine(Path.GetDirectoryName(dlg.FileName) ?? "", credName);
                    if (File.Exists(sibling))
                    {
                        string saved, err;
                        if (ImportCredential(sibling, out saved, out err))
                        {
                            AppendLog("[INFO] 已自动从同目录一并导入密钥文件：" + saved);
                        }
                    }
                    RefreshEnvBanner();
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "导入失败：" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private void OnImportCred(object sender, EventArgs e)
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择 GEE 服务账号密钥 JSON";
                dlg.Filter = "JSON 密钥文件 (*.json)|*.json|所有文件 (*.*)|*.*";
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                string saved, err;
                if (!ImportCredential(dlg.FileName, out saved, out err))
                {
                    MessageBox.Show(this, "密钥 JSON 校验失败：\r\n" + err, "JSON 无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                AppendLog("[INFO] 已导入 GEE 密钥：" + Path.GetFileName(dlg.FileName) + " -> " + saved);
                RefreshEnvBanner();
            }
        }

        private void StartServices()
        {
            LoadPortsFromEnv();
            RefreshEnvBanner();
            if (!File.Exists(Path.Combine(_rootDir, ".env")))
            {
                MessageBox.Show(this, "安装目录尚未放入 .env 文件，请先点击「导入 .env」。", "缺少配置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!File.Exists(_pythonExe) || !File.Exists(_nodeExe))
            {
                MessageBox.Show(this, "缺少内置运行时（runtime\\python 或 runtime\\node），请重新运行安装向导。", "环境不完整", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            AppendLog("[INFO] 正在执行 satgpt_config.py check ...");
            string checkOutput;
            if (!RunCheck(out checkOutput))
            {
                AppendLog("[ERROR] 配置校验未通过：" + checkOutput);
                MessageBox.Show(this, "配置校验未通过，请检查 .env 与相关密钥文件：\r\n\r\n" + checkOutput, "配置错误", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            AppendLog("[INFO] " + checkOutput);

            if (_backendProc == null || _backendProc.HasExited)
            {
                _backendProc = SpawnService(_pythonExe, "\"" + _configScript + "\" backend", _rootDir, "backend");
            }
            if (_frontendProc == null || _frontendProc.HasExited)
            {
                _frontendProc = SpawnService(_nodeExe, "\"" + _frontendScript + "\"", Path.Combine(_rootDir, "frontend"), "frontend");
            }

            _btnStart.Enabled = false;
            _btnStop.Enabled = true;
            AppendLog("[INFO] 正在启动服务，请稍候片刻待指示灯变绿后点击「打开 SatGPT 网页」。");
            PollHealthAsync();
        }

        private bool RunCheck(out string output)
        {
            StringBuilder sb = new StringBuilder();
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _pythonExe;
            psi.Arguments = "\"" + _configScript + "\" check";
            psi.WorkingDirectory = _rootDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            using (Process p = Process.Start(psi))
            {
                sb.AppendLine(p.StandardOutput.ReadToEnd());
                sb.AppendLine(p.StandardError.ReadToEnd());
                p.WaitForExit();
                output = sb.ToString().Trim();
                return p.ExitCode == 0;
            }
        }

        private Process SpawnService(string exe, string args, string cwd, string tag)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.WorkingDirectory = cwd;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";

            Process p = new Process();
            p.StartInfo = psi;
            p.EnableRaisingEvents = true;
            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) AppendLogSafe("[" + tag + "] " + e.Data);
            };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) AppendLogSafe("[" + tag + "] " + e.Data);
            };
            p.Exited += delegate
            {
                AppendLogSafe("[" + tag + "] 进程已退出。");
                if (!_closing)
                {
                    try { BeginInvoke((MethodInvoker)UpdateRunningButtons); } catch { }
                }
            };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            AppendLog("[INFO] 已启动 " + tag + " (PID=" + p.Id + ")");
            return p;
        }

        private void StopServices()
        {
            KillTree(_frontendProc);
            KillTree(_backendProc);
            _frontendProc = null;
            _backendProc = null;
            UpdateRunningButtons();
            AppendLog("[INFO] 托管的 SatGPT 前后端进程已停止。");
            PollHealthAsync();
        }

        private static void KillTree(Process p)
        {
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F");
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    using (Process k = Process.Start(psi)) { k.WaitForExit(4000); }
                }
            }
            catch { }
        }

        private void UpdateRunningButtons()
        {
            bool anyRunning = (_backendProc != null && !_backendProc.HasExited) || (_frontendProc != null && !_frontendProc.HasExited);
            _btnStart.Enabled = !anyRunning;
            _btnStop.Enabled = anyRunning;
        }

        private void PollHealthAsync()
        {
            int fePort = _frontendPort;
            int bePort = _agentPort;
            ThreadPool.QueueUserWorkItem(delegate
            {
                int feCode = ProbeReadyz(fePort);
                int beCode = ProbeReadyz(bePort);
                if (_closing || !IsHandleCreated) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        ApplyLight(_dotFrontend, _lblFrontendStatus, feCode, fePort);
                        ApplyLight(_dotBackend, _lblBackendStatus, beCode, bePort);
                    });
                }
                catch { }
            });
        }

        private static int ProbeReadyz(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/readyz");
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode;
                }
            }
            catch (WebException ex)
            {
                HttpWebResponse r = ex.Response as HttpWebResponse;
                if (r != null) return (int)r.StatusCode;
                return 0;
            }
            catch
            {
                return 0;
            }
        }

        private static void ApplyLight(Panel dot, Label lbl, int statusCode, int port)
        {
            if (statusCode >= 200 && statusCode < 300)
            {
                dot.Tag = OkColor;
                dot.Invalidate();
                lbl.Text = "运行正常（/readyz 200 · 端口 " + port + "）";
                lbl.ForeColor = OkColor;
            }
            else if (statusCode > 0)
            {
                dot.Tag = WarnColor;
                dot.Invalidate();
                lbl.Text = "初始化中或降级（HTTP " + statusCode + " · 端口 " + port + "）";
                lbl.ForeColor = WarnColor;
            }
            else
            {
                dot.Tag = MutedColor;
                dot.Invalidate();
                lbl.Text = "未启动（端口 " + port + "）";
                lbl.ForeColor = Color.FromArgb(100, 116, 139);
            }
        }

        private void AppendLogSafe(string line)
        {
            if (_closing || !IsHandleCreated) return;
            try { BeginInvoke((MethodInvoker)delegate { AppendLog(line); }); } catch { }
        }

        private void AppendLog(string line)
        {
            if (_txtLog.TextLength > 50000) _txtLog.Clear();
            _txtLog.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + "\r\n");
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            bool anyRunning = (_backendProc != null && !_backendProc.HasExited) || (_frontendProc != null && !_frontendProc.HasExited);
            if (anyRunning)
            {
                DialogResult res = MessageBox.Show(this, "SatGPT 服务正在运行。关闭窗口前是否同时停止服务？", "退出确认", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (res == DialogResult.Cancel)
                {
                    e.Cancel = true;
                    return;
                }
                _closing = true;
                if (res == DialogResult.Yes) StopServices();
            }
            else
            {
                _closing = true;
            }
        }

        public void SaveScreenshot(string path)
        {
            Show();
            Application.DoEvents();
            using (Bitmap bmp = new Bitmap(Width, Height))
            {
                DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
            _closing = true;
            Close();
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            LauncherForm form = new LauncherForm();
            if (args.Length >= 2 && args[0] == "--screenshot")
            {
                form.SaveScreenshot(args[1]);
                return;
            }
            Application.Run(form);
        }
    }
}

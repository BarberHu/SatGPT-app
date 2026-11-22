using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace SatGPT.Installer
{
    internal sealed class FlatProgressBar : Control
    {
        private int _value;
        private Color _barColor = Color.FromArgb(15, 118, 110);

        public FlatProgressBar()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            Height = 14;
            BackColor = Color.FromArgb(226, 232, 240);
        }

        public int Value
        {
            get { return _value; }
            set
            {
                int clamped = Math.Max(0, Math.Min(100, value));
                if (_value != clamped)
                {
                    _value = clamped;
                    Invalidate();
                }
            }
        }

        public Color BarColor
        {
            get { return _barColor; }
            set
            {
                if (_barColor != value)
                {
                    _barColor = value;
                    Invalidate();
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Rectangle track = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath trackPath = RoundedRect(track, 6))
            using (SolidBrush bgBrush = new SolidBrush(BackColor))
            {
                g.FillPath(bgBrush, trackPath);
            }

            if (_value > 0)
            {
                int fillWidth = (int)Math.Round((Width - 1) * (_value / 100.0));
                if (fillWidth < 8) fillWidth = Math.Min(Width - 1, 8);
                Rectangle fill = new Rectangle(0, 0, fillWidth, Height - 1);
                using (GraphicsPath fillPath = RoundedRect(fill, 6))
                using (SolidBrush barBrush = new SolidBrush(_barColor))
                {
                    g.FillPath(barBrush, fillPath);
                }
            }
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            if (bounds.Width < d || bounds.Height < d)
            {
                path.AddRectangle(bounds);
                return path;
            }
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class StepRowUI
    {
        public Panel Card;
        public Label TitleLabel;
        public Label StatusLabel;
        public Label PercentLabel;
        public FlatProgressBar ProgressBar;
        public Label DetailLabel;
    }

    internal sealed class BundlePaths
    {
        public string BaseDir;
        public string PayloadDir;
        public string AppDir;
        public string PythonZip;
        public string WheelsDir;
        public string NodeDir;
        public string FrontendDir;
        public string LauncherExe;
        public int WheelCount;
        public bool IsValid;
        public string MissingReason;

        public static BundlePaths Discover()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            BundlePaths b = new BundlePaths();
            b.BaseDir = exeDir;
            b.PayloadDir = Path.Combine(exeDir, "payload");
            b.AppDir = Path.Combine(b.PayloadDir, "app");
            b.WheelsDir = Path.Combine(b.PayloadDir, "wheels");
            b.NodeDir = Path.Combine(b.PayloadDir, "node");
            b.FrontendDir = Path.Combine(b.PayloadDir, "frontend");
            b.LauncherExe = Path.Combine(b.PayloadDir, "launcher", "SatGPT-Launcher.exe");

            string pyDir = Path.Combine(b.PayloadDir, "python");
            if (Directory.Exists(pyDir))
            {
                string[] zips = Directory.GetFiles(pyDir, "python-3.12*-embed-*.zip");
                if (zips.Length > 0) b.PythonZip = zips[0];
            }

            if (Directory.Exists(b.WheelsDir))
            {
                b.WheelCount = Directory.GetFiles(b.WheelsDir, "*.whl").Length;
            }

            List<string> missing = new List<string>();
            if (!Directory.Exists(b.AppDir)) missing.Add("payload\\app");
            if (string.IsNullOrEmpty(b.PythonZip) || !File.Exists(b.PythonZip)) missing.Add("payload\\python\\python-3.12*-embed-*.zip");
            if (!Directory.Exists(b.WheelsDir) || b.WheelCount == 0) missing.Add("payload\\wheels (*.whl)");
            if (!File.Exists(Path.Combine(b.NodeDir, "node.exe"))) missing.Add("payload\\node\\node.exe");
            if (!File.Exists(Path.Combine(b.FrontendDir, "build", "index.html"))) missing.Add("payload\\frontend\\build\\index.html");

            b.IsValid = missing.Count == 0;
            b.MissingReason = missing.Count == 0 ? "" : "离线包缺少必要组件：" + string.Join("、", missing.ToArray());
            return b;
        }
    }

    internal static class InstallEngine
    {
        public delegate void ProgressCallback(int stepIndex, int percent, string status, string detail);
        public delegate void LogCallback(string line);

        public static void RunFullInstall(BundlePaths bundle, string targetDir, ProgressCallback onProgress, LogCallback onLog)
        {
            if (!bundle.IsValid)
            {
                throw new InvalidOperationException(bundle.MissingReason);
            }

            Directory.CreateDirectory(targetDir);

            // Step 0: Copy SatGPT app files (0 -> 100%)
            onProgress(0, 0, "进行中", "正在扫描 SatGPT 应用文件...");
            onLog("=== 步骤 1/4：复制 SatGPT 应用文件 ===");
            CopyDirectoryWithProgress(bundle.AppDir, targetDir, true, delegate (int done, int total, string relPath)
            {
                int pct = total == 0 ? 100 : (int)Math.Round(done * 100.0 / total);
                onProgress(0, pct, "进行中", string.Format("正在复制 ({0}/{1})：{2}", done, total, relPath));
            }, onLog);
            onProgress(0, 100, "已完成", "SatGPT 应用文件复制完成。");

            // Step 1: Deploy embedded Python 3.12 (0 -> 100%)
            onProgress(1, 0, "进行中", "正在准备便携 Python 3.12 目录...");
            onLog("=== 步骤 2/4：部署内置 Python 3.12 环境 ===");
            string pythonDir = Path.Combine(targetDir, "runtime", "python");
            if (Directory.Exists(pythonDir))
            {
                onLog("检测到已有 runtime\\python，正在更新基础运行时...");
            }
            Directory.CreateDirectory(pythonDir);
            ExtractZipWithProgress(bundle.PythonZip, pythonDir, delegate (int done, int total, string name)
            {
                int pct = total == 0 ? 90 : (int)Math.Round(done * 92.0 / total);
                onProgress(1, pct, "进行中", string.Format("正在解压 Python 运行时 ({0}/{1})：{2}", done, total, name));
            });

            onProgress(1, 95, "进行中", "正在配置 Python 模块路径（._pth 与 site-packages）...");
            ConfigureEmbeddedPython(pythonDir, targetDir, onLog);
            onProgress(1, 100, "已完成", "内置 Python 3.12 环境部署完成。");

            // Step 2: Offline install wheels (0 -> 100%)
            onProgress(2, 0, "进行中", "正在离线初始化 pip 工具...");
            onLog("=== 步骤 3/4：离线安装 Python 依赖（wheels） ===");
            string pythonExe = Path.Combine(pythonDir, "python.exe");
            InstallOfflineWheels(pythonExe, bundle.WheelsDir, targetDir, onProgress, onLog);
            onProgress(2, 100, "已完成", "Python 依赖包离线安装完成。");

            // Step 3: Deploy Node.js & built frontend (0 -> 100%)
            onProgress(3, 0, "进行中", "正在扫描内置 Node.js 与前端运行文件...");
            onLog("=== 步骤 4/4：部署内置 Node.js 与前端运行文件 ===");
            string nodeTargetDir = Path.Combine(targetDir, "runtime", "node");
            string frontendTargetDir = Path.Combine(targetDir, "frontend");
            Directory.CreateDirectory(nodeTargetDir);
            Directory.CreateDirectory(frontendTargetDir);

            List<string[]> copyPairs = new List<string[]>();
            foreach (string f in Directory.GetFiles(bundle.NodeDir, "*", SearchOption.AllDirectories))
            {
                string rel = GetRelativePath(bundle.NodeDir, f);
                copyPairs.Add(new string[] { f, Path.Combine(nodeTargetDir, rel), "runtime\\node\\" + rel });
            }
            foreach (string f in Directory.GetFiles(bundle.FrontendDir, "*", SearchOption.AllDirectories))
            {
                string rel = GetRelativePath(bundle.FrontendDir, f);
                copyPairs.Add(new string[] { f, Path.Combine(frontendTargetDir, rel), "frontend\\" + rel });
            }
            if (File.Exists(bundle.LauncherExe))
            {
                copyPairs.Add(new string[] { bundle.LauncherExe, Path.Combine(targetDir, "SatGPT-Launcher.exe"), "SatGPT-Launcher.exe" });
            }

            int totalFront = copyPairs.Count;
            for (int i = 0; i < totalFront; i++)
            {
                string src = copyPairs[i][0];
                string dst = copyPairs[i][1];
                string label = copyPairs[i][2];
                string parent = Path.GetDirectoryName(dst);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                File.Copy(src, dst, true);
                int pct = totalFront == 0 ? 100 : (int)Math.Round((i + 1) * 100.0 / totalFront);
                if (i == totalFront - 1 || i % 5 == 0)
                {
                    onProgress(3, pct, "进行中", string.Format("正在部署 ({0}/{1})：{2}", i + 1, totalFront, label));
                }
            }
            onLog(string.Format("已部署 Node.js 与前端运行文件，共 {0} 个文件。", totalFront));
            onProgress(3, 100, "已完成", "Node.js 与前端运行文件部署完成。");
        }

        private static void CopyDirectoryWithProgress(string sourceDir, string targetDir, bool preserveExistingEnv, Action<int, int, string> onFile, LogCallback onLog)
        {
            string[] files = Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories);
            int total = files.Length;
            for (int i = 0; i < total; i++)
            {
                string src = files[i];
                string rel = GetRelativePath(sourceDir, src);
                string dst = Path.Combine(targetDir, rel);
                if (preserveExistingEnv && string.Equals(rel, ".env", StringComparison.OrdinalIgnoreCase) && File.Exists(dst))
                {
                    onLog("保留目标目录已有的 .env 文件，不覆盖。");
                    continue;
                }
                string parent = Path.GetDirectoryName(dst);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                File.Copy(src, dst, true);
                if (i == total - 1 || i % 4 == 0)
                {
                    onFile(i + 1, total, rel);
                }
            }
            onLog(string.Format("已复制应用文件，共 {0} 个。", total));
        }

        private static void ExtractZipWithProgress(string zipPath, string destDir, Action<int, int, string> onEntry)
        {
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                int total = archive.Entries.Count;
                for (int i = 0; i < total; i++)
                {
                    ZipArchiveEntry entry = archive.Entries[i];
                    string destPath = Path.GetFullPath(Path.Combine(destDir, entry.FullName));
                    string destRoot = Path.GetFullPath(destDir);
                    if (!destPath.StartsWith(destRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destPath);
                    }
                    else
                    {
                        string parent = Path.GetDirectoryName(destPath);
                        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                        entry.ExtractToFile(destPath, true);
                    }
                    if (i == total - 1 || i % 3 == 0)
                    {
                        onEntry(i + 1, total, entry.FullName);
                    }
                }
            }
        }

        private static void ConfigureEmbeddedPython(string pythonDir, string targetDir, LogCallback onLog)
        {
            Directory.CreateDirectory(Path.Combine(pythonDir, "Lib", "site-packages"));
            Directory.CreateDirectory(Path.Combine(pythonDir, "Scripts"));

            string[] pthFiles = Directory.GetFiles(pythonDir, "python*._pth");
            if (pthFiles.Length == 0)
            {
                throw new InvalidOperationException("未在便携 Python 中找到 python*._pth 文件。");
            }
            string pthPath = pthFiles[0];
            string zipName = Path.GetFileNameWithoutExtension(pthPath) + ".zip";
            List<string> lines = new List<string>();
            lines.Add(zipName);
            lines.Add(".");
            lines.Add("Lib\\site-packages");
            lines.Add("..\\..");
            lines.Add("import site");
            File.WriteAllLines(pthPath, lines.ToArray(), new UTF8Encoding(false));
            onLog("已更新 " + Path.GetFileName(pthPath) + "（启用 site-packages 与项目根路径）。");
        }

        private static void InstallOfflineWheels(string pythonExe, string wheelsDir, string targetDir, ProgressCallback onProgress, LogCallback onLog)
        {
            string[] pipWheels = Directory.GetFiles(wheelsDir, "pip-*.whl");
            if (pipWheels.Length == 0)
            {
                throw new InvalidOperationException("离线 wheels 目录缺少 pip-*.whl，无法离线自举安装依赖。");
            }

            onProgress(2, 5, "进行中", "正在离线安装 pip...");
            string bootstrapCode = "import sys; sys.path.insert(0, sys.argv[1]); from pip._internal.cli.main import main; raise SystemExit(main(sys.argv[2:]))";
            string pipBootstrapArgs = string.Format("-c \"{0}\" \"{1}\" install --no-index --find-links=\"{2}\" --no-warn-script-location --force-reinstall pip", bootstrapCode, pipWheels[0], wheelsDir);
            int pipCode = RunProcess(pythonExe, pipBootstrapArgs, targetDir, delegate (string line)
            {
                onLog(line);
            });
            if (pipCode != 0)
            {
                throw new InvalidOperationException("离线安装 pip 失败（退出码 " + pipCode + "）。");
            }
            onProgress(2, 15, "进行中", "pip 就绪，开始离线安装 requirements.txt 依赖...");

            string reqPath = Path.Combine(targetDir, "requirements.txt");
            int expectedPackages = CountRequirementLines(reqPath);
            if (expectedPackages < 10) expectedPackages = 50;
            int processedCount = 0;
            int currentPct = 15;

            string installArgs = string.Format("-m pip install --no-index --find-links=\"{0}\" --no-warn-script-location --prefer-binary -r \"{1}\"", wheelsDir, reqPath);
            int installCode = RunProcess(pythonExe, installArgs, targetDir, delegate (string line)
            {
                onLog(line);
                if (line.IndexOf("Processing ", StringComparison.OrdinalIgnoreCase) >= 0
                    || line.IndexOf("Requirement already satisfied", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    processedCount++;
                    int nextPct = 15 + (int)Math.Round(Math.Min(1.0, processedCount / (double)expectedPackages) * 55.0);
                    if (nextPct > currentPct)
                    {
                        currentPct = nextPct;
                        string pkg = ExtractShortPackageName(line);
                        onProgress(2, currentPct, "进行中", string.Format("正在解包依赖 ({0}/{1})：{2}", Math.Min(processedCount, expectedPackages), expectedPackages, pkg));
                    }
                }
                else if (line.IndexOf("Installing collected packages:", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    currentPct = Math.Max(currentPct, 75);
                    onProgress(2, currentPct, "进行中", "正在写入已收集的 Python 依赖包（可能需要 15~45 秒）...");
                }
                else if (line.IndexOf("Successfully installed", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    currentPct = 98;
                    onProgress(2, 98, "进行中", "依赖安装完毕，正在校验环境...");
                }
            });

            if (installCode != 0)
            {
                throw new InvalidOperationException("离线安装 Python 依赖失败（退出码 " + installCode + "），请展开日志查看详情。");
            }
        }

        private static int CountRequirementLines(string reqPath)
        {
            if (!File.Exists(reqPath)) return 40;
            int count = 0;
            foreach (string raw in File.ReadAllLines(reqPath))
            {
                string s = raw.Trim();
                if (s.Length == 0 || s.StartsWith("#")) continue;
                count++;
            }
            return count;
        }

        private static string ExtractShortPackageName(string line)
        {
            string s = line;
            int fromIdx = s.IndexOf(" (from ", StringComparison.OrdinalIgnoreCase);
            if (fromIdx > 0) s = s.Substring(0, fromIdx);
            int idx = s.LastIndexOf('\\');
            if (idx >= 0 && idx + 1 < s.Length)
            {
                string file = s.Substring(idx + 1).Trim();
                int dash = file.IndexOf('-');
                return dash > 0 ? file.Substring(0, dash) : file;
            }
            return s.Length > 48 ? s.Substring(0, 48) + "..." : s;
        }

        public static int RunProcess(string fileName, string arguments, string workingDir, Action<string> onLine)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = fileName;
            psi.Arguments = arguments;
            psi.WorkingDirectory = workingDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            psi.EnvironmentVariables["PIP_DISABLE_PIP_VERSION_CHECK"] = "1";

            using (Process p = new Process())
            {
                p.StartInfo = psi;
                p.OutputDataReceived += delegate (object sender, DataReceivedEventArgs e)
                {
                    if (!string.IsNullOrEmpty(e.Data)) onLine(e.Data);
                };
                p.ErrorDataReceived += delegate (object sender, DataReceivedEventArgs e)
                {
                    if (!string.IsNullOrEmpty(e.Data)) onLine(e.Data);
                };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        public static string RunConfigCheck(string targetDir, out bool ok)
        {
            string py = Path.Combine(targetDir, "runtime", "python", "python.exe");
            string script = Path.Combine(targetDir, "satgpt_config.py");
            if (!File.Exists(py) || !File.Exists(script))
            {
                ok = false;
                return "未找到内置 Python 或 satgpt_config.py，无法校验配置。";
            }
            StringBuilder sb = new StringBuilder();
            int code = RunProcess(py, "\"" + script + "\" check", targetDir, delegate (string line)
            {
                sb.AppendLine(line);
            });
            ok = (code == 0);
            return sb.ToString().Trim();
        }

        public static string ResolveCredentialTargetName(string targetDir)
        {
            string defaultName = ".private-key.json";
            string envFile = Path.Combine(targetDir, ".env");
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

        public static bool ValidateServiceAccountJson(string filePath, out string error)
        {
            error = "";
            try
            {
                string text = File.ReadAllText(filePath, Encoding.UTF8).TrimStart('\uFEFF').Trim();
                if (!text.StartsWith("{") || !text.EndsWith("}"))
                {
                    error = "不是合法的 JSON 对象文件。";
                    return false;
                }
                if (!Regex.IsMatch(text, @"""type""\s*:\s*""service_account"""))
                {
                    error = "JSON 缺少 \"type\": \"service_account\"，请确认这是 Google Earth Engine 服务账号密钥文件。";
                    return false;
                }
                if (!Regex.IsMatch(text, @"""client_email""\s*:\s*""[^""]+"""))
                {
                    error = "JSON 缺少有效的 client_email 字段。";
                    return false;
                }
                if (!Regex.IsMatch(text, @"""private_key""\s*:\s*""[^""]*PRIVATE KEY"))
                {
                    error = "JSON 缺少有效的 private_key 字段。";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = "读取 JSON 文件失败：" + ex.Message;
                return false;
            }
        }

        public static bool ImportCredentialFile(string sourcePath, string targetDir, out string targetRelName, out string error)
        {
            targetRelName = ResolveCredentialTargetName(targetDir);
            if (!ValidateServiceAccountJson(sourcePath, out error))
            {
                return false;
            }
            string rootFull = Path.GetFullPath(targetDir).TrimEnd('\\') + "\\";
            string dstFull = Path.GetFullPath(Path.Combine(targetDir, targetRelName));
            if (!dstFull.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            {
                error = "目标密钥路径越出安装目录范围。";
                return false;
            }
            string parent = Path.GetDirectoryName(dstFull);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            if (File.Exists(dstFull))
            {
                File.Copy(dstFull, dstFull + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"), true);
            }
            string content = File.ReadAllText(sourcePath, Encoding.UTF8).TrimStart('\uFEFF');
            File.WriteAllText(dstFull, content, new UTF8Encoding(false));
            error = "";
            return true;
        }

        public static bool TryAutoBringSiblingCredential(string sourceEnvPath, string targetDir, out string copiedName)
        {
            copiedName = "";
            string rel = ResolveCredentialTargetName(targetDir);
            string srcDir = Path.GetDirectoryName(sourceEnvPath);
            if (string.IsNullOrEmpty(srcDir)) return false;
            string sibling = Path.Combine(srcDir, rel);
            if (!File.Exists(sibling)) return false;
            string err;
            string savedRel;
            if (ImportCredentialFile(sibling, targetDir, out savedRel, out err))
            {
                copiedName = savedRel;
                return true;
            }
            return false;
        }

        public static void CreateDesktopShortcut(string targetDir)
        {
            string launcher = Path.Combine(targetDir, "SatGPT-Launcher.exe");
            if (!File.Exists(launcher)) return;
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string lnkPath = Path.Combine(desktop, "SatGPT 启动器.lnk");

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type scType = shortcut.GetType();
            scType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { launcher });
            scType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { targetDir });
            scType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { "启动与管理 SatGPT 本地服务" });
            scType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
        }

        private static string GetRelativePath(string rootDir, string fullPath)
        {
            string root = Path.GetFullPath(rootDir);
            if (!root.EndsWith("\\")) root += "\\";
            string full = Path.GetFullPath(fullPath);
            if (full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                return full.Substring(root.Length);
            }
            return Path.GetFileName(full);
        }
    }

    internal sealed class SetupWizardForm : Form
    {
        private readonly BundlePaths _bundle;
        private int _currentStep = 1;
        private bool _installing;
        private bool _installSucceeded;
        private bool _envImported;
        private bool _credImported;
        private bool _envValidated;
        private bool _envSkipped;
        private string _credTargetName = ".private-key.json";

        private Label _headerStepLabel;
        private Label _headerSubLabel;
        private Panel _contentHost;
        private Panel[] _pages = new Panel[4];

        // Footer buttons
        private Button _btnBack;
        private Button _btnNext;
        private Button _btnCancel;

        // Step 1 controls
        private TextBox _txtInstallDir;
        private Label _lblBundleSummary;

        // Step 2 controls (4 independent step rows)
        private StepRowUI[] _stepRows = new StepRowUI[4];
        private Button _btnToggleLog;
        private TextBox _txtLog;
        private bool _logExpanded;

        // Step 3 controls (two config files: .env + GEE JSON, or skip)
        private Label _lblEnvStatus;
        private Label _lblCredStatus;
        private Panel _envResultBox;
        private Label _lblEnvResultTitle;
        private Label _lblEnvResultDetail;
        private Button _btnImportEnv;
        private Button _btnImportCred;
        private Button _btnSkipEnv;

        // Step 4 controls
        private Label _lblFinishSummary;
        private CheckBox _chkDesktopShortcut;
        private CheckBox _chkLaunchAfter;

        private static readonly Color AccentColor = Color.FromArgb(15, 118, 110);
        private static readonly Color BgColor = Color.FromArgb(245, 247, 250);
        private static readonly Color BorderColor = Color.FromArgb(226, 232, 240);
        private static readonly Color OkColor = Color.FromArgb(5, 150, 105);
        private static readonly Color WarnColor = Color.FromArgb(180, 83, 9);
        private static readonly Color ErrColor = Color.FromArgb(220, 38, 38);

        public SetupWizardForm(BundlePaths bundle)
        {
            _bundle = bundle;
            Text = "SatGPT Windows 离线安装向导";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(700, 560);
            BackColor = BgColor;
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);

            BuildLayout();
            ShowStep(1);
        }

        private void BuildLayout()
        {
            // Top header banner
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 76;
            header.BackColor = AccentColor;
            header.Padding = new Padding(24, 14, 24, 12);

            Label title = new Label();
            title.Text = "SatGPT Windows 离线安装向导";
            title.ForeColor = Color.White;
            title.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(24, 14);
            header.Controls.Add(title);

            _headerSubLabel = new Label();
            _headerSubLabel.Text = "无需手动安装 Python、Node.js 或命令行依赖，按引导即可完成部署";
            _headerSubLabel.ForeColor = Color.FromArgb(204, 251, 241);
            _headerSubLabel.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
            _headerSubLabel.AutoSize = true;
            _headerSubLabel.Location = new Point(25, 44);
            header.Controls.Add(_headerSubLabel);

            _headerStepLabel = new Label();
            _headerStepLabel.Text = "步骤 1 / 4";
            _headerStepLabel.ForeColor = Color.White;
            _headerStepLabel.BackColor = Color.FromArgb(17, 94, 89);
            _headerStepLabel.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            _headerStepLabel.TextAlign = ContentAlignment.MiddleCenter;
            _headerStepLabel.Size = new Size(92, 28);
            _headerStepLabel.Location = new Point(ClientSize.Width - 116, 24);
            header.Controls.Add(_headerStepLabel);

            // Bottom footer bar
            Panel footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 62;
            footer.BackColor = Color.White;
            footer.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(BorderColor)) e.Graphics.DrawLine(p, 0, 0, footer.Width, 0);
            };

            _btnCancel = MakeButton("取消", false);
            _btnCancel.Location = new Point(24, 14);
            _btnCancel.Click += delegate
            {
                if (_installing)
                {
                    MessageBox.Show(this, "当前正在安装中，请等待本步骤结束后再退出。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Close();
            };

            _btnBack = MakeButton("上一步", false);
            _btnBack.Location = new Point(ClientSize.Width - 238, 14);
            _btnBack.Click += delegate { if (_currentStep > 1 && !_installing) ShowStep(_currentStep - 1); };

            _btnNext = MakeButton("开始安装", true);
            _btnNext.Width = 112;
            _btnNext.Location = new Point(ClientSize.Width - 136, 14);
            _btnNext.Click += OnNextClicked;

            footer.Controls.Add(_btnCancel);
            footer.Controls.Add(_btnBack);
            footer.Controls.Add(_btnNext);

            // Main content area
            _contentHost = new Panel();
            _contentHost.Dock = DockStyle.Fill;
            _contentHost.Padding = new Padding(24, 18, 24, 14);

            _pages[0] = BuildStep1Page();
            _pages[1] = BuildStep2Page();
            _pages[2] = BuildStep3Page();
            _pages[3] = BuildStep4Page();

            foreach (Panel p in _pages)
            {
                p.Dock = DockStyle.Fill;
                p.Visible = false;
                _contentHost.Controls.Add(p);
            }

            Controls.Add(_contentHost);
            Controls.Add(footer);
            Controls.Add(header);
        }

        private Panel BuildStep1Page()
        {
            Panel p = new Panel();

            Label h = new Label();
            h.Text = "1. 选择安装目录";
            h.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
            h.AutoSize = true;
            h.Location = new Point(0, 0);
            p.Controls.Add(h);

            Label desc = new Label();
            desc.Text = "安装程序会将 SatGPT 应用代码、内置 Python 3.12 环境、离线依赖库和前端服务部署到下方目录。";
            desc.ForeColor = Color.FromArgb(71, 85, 105);
            desc.Size = new Size(650, 38);
            desc.Location = new Point(0, 28);
            p.Controls.Add(desc);

            // Target directory card
            Panel dirCard = MakeCard(0, 74, 652, 92);
            Label dirLabel = new Label();
            dirLabel.Text = "目标安装路径：";
            dirLabel.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            dirLabel.AutoSize = true;
            dirLabel.Location = new Point(16, 14);
            dirCard.Controls.Add(dirLabel);

            _txtInstallDir = new TextBox();
            _txtInstallDir.Text = @"C:\SatGPT";
            _txtInstallDir.Font = new Font("Consolas", 10.5f);
            _txtInstallDir.Location = new Point(16, 42);
            _txtInstallDir.Size = new Size(512, 28);
            dirCard.Controls.Add(_txtInstallDir);

            Button btnBrowse = MakeButton("浏览...", false);
            btnBrowse.Location = new Point(538, 40);
            btnBrowse.Size = new Size(96, 30);
            btnBrowse.Click += delegate
            {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选择 SatGPT 的安装目录";
                    dlg.SelectedPath = Directory.Exists(_txtInstallDir.Text) ? _txtInstallDir.Text : @"C:\";
                    if (dlg.ShowDialog(this) == DialogResult.OK)
                    {
                        _txtInstallDir.Text = dlg.SelectedPath;
                    }
                }
            };
            dirCard.Controls.Add(btnBrowse);
            p.Controls.Add(dirCard);

            // Offline bundle inspection card
            Panel bundleCard = MakeCard(0, 182, 652, 168);
            Label bh = new Label();
            bh.Text = "离线安装包组件检查";
            bh.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            bh.AutoSize = true;
            bh.Location = new Point(16, 14);
            bundleCard.Controls.Add(bh);

            _lblBundleSummary = new Label();
            _lblBundleSummary.Location = new Point(16, 42);
            _lblBundleSummary.Size = new Size(620, 114);
            if (_bundle.IsValid)
            {
                _lblBundleSummary.ForeColor = Color.FromArgb(30, 41, 59);
                _lblBundleSummary.Text = string.Format(
                    "• SatGPT 应用代码与配置模板：已就绪\r\n" +
                    "• 内置便携 Python 3.12 运行时：{0}\r\n" +
                    "• 离线 Python 依赖包（wheels）：共 {1} 个离线包（安装过程无需联网）\r\n" +
                    "• 内置 Node.js 网关与预构建 React 前端：已就绪\r\n\r\n" +
                    "提示：若目标目录已存在 .env 文件，安装过程会自动保留原文件。",
                    Path.GetFileName(_bundle.PythonZip),
                    _bundle.WheelCount);
            }
            else
            {
                _lblBundleSummary.ForeColor = ErrColor;
                _lblBundleSummary.Text = _bundle.MissingReason + "\r\n请确认整个离线包目录完整（SatGPT-Setup.exe 与 payload 文件夹需在同一目录下）。";
            }
            bundleCard.Controls.Add(_lblBundleSummary);
            p.Controls.Add(bundleCard);

            return p;
        }

        private Panel BuildStep2Page()
        {
            Panel p = new Panel();

            Label h = new Label();
            h.Text = "2. 正在部署 SatGPT 运行环境";
            h.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
            h.AutoSize = true;
            h.Location = new Point(0, 0);
            p.Controls.Add(h);

            string[] stepTitles = new string[]
            {
                "步骤 1：复制 SatGPT 应用文件",
                "步骤 2：部署内置 Python 3.12 环境",
                "步骤 3：离线安装 Python 依赖（wheels）",
                "步骤 4：部署内置 Node.js 与前端运行文件"
            };

            int top = 34;
            for (int i = 0; i < 4; i++)
            {
                StepRowUI row = new StepRowUI();
                row.Card = MakeCard(0, top, 652, 74);

                row.TitleLabel = new Label();
                row.TitleLabel.Text = stepTitles[i];
                row.TitleLabel.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
                row.TitleLabel.AutoSize = true;
                row.TitleLabel.Location = new Point(14, 9);
                row.Card.Controls.Add(row.TitleLabel);

                row.StatusLabel = new Label();
                row.StatusLabel.Text = "等待中";
                row.StatusLabel.ForeColor = Color.FromArgb(100, 116, 139);
                row.StatusLabel.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
                row.StatusLabel.TextAlign = ContentAlignment.MiddleRight;
                row.StatusLabel.Size = new Size(90, 20);
                row.StatusLabel.Location = new Point(494, 9);
                row.Card.Controls.Add(row.StatusLabel);

                row.PercentLabel = new Label();
                row.PercentLabel.Text = "0%";
                row.PercentLabel.ForeColor = Color.FromArgb(15, 23, 42);
                row.PercentLabel.Font = new Font("Consolas", 9.5f, FontStyle.Bold);
                row.PercentLabel.TextAlign = ContentAlignment.MiddleRight;
                row.PercentLabel.Size = new Size(48, 20);
                row.PercentLabel.Location = new Point(588, 8);
                row.Card.Controls.Add(row.PercentLabel);

                row.ProgressBar = new FlatProgressBar();
                row.ProgressBar.Location = new Point(14, 34);
                row.ProgressBar.Size = new Size(622, 13);
                row.ProgressBar.Value = 0;
                row.Card.Controls.Add(row.ProgressBar);

                row.DetailLabel = new Label();
                row.DetailLabel.Text = "等待上一步完成...";
                row.DetailLabel.ForeColor = Color.FromArgb(100, 116, 139);
                row.DetailLabel.Font = new Font("Microsoft YaHei UI", 8.5f);
                row.DetailLabel.AutoEllipsis = true;
                row.DetailLabel.Size = new Size(622, 18);
                row.DetailLabel.Location = new Point(14, 51);
                row.Card.Controls.Add(row.DetailLabel);

                _stepRows[i] = row;
                p.Controls.Add(row.Card);
                top += 82;
            }

            _btnToggleLog = MakeButton("展开详细日志 ▼", false);
            _btnToggleLog.Size = new Size(132, 26);
            _btnToggleLog.Font = new Font("Microsoft YaHei UI", 8.5f);
            _btnToggleLog.Location = new Point(0, top);
            _btnToggleLog.Click += delegate
            {
                _logExpanded = !_logExpanded;
                _txtLog.Visible = _logExpanded;
                _btnToggleLog.Text = _logExpanded ? "收起详细日志 ▲" : "展开详细日志 ▼";
                ClientSize = new Size(700, _logExpanded ? 680 : 560);
            };
            p.Controls.Add(_btnToggleLog);

            _txtLog = new TextBox();
            _txtLog.Multiline = true;
            _txtLog.ReadOnly = true;
            _txtLog.ScrollBars = ScrollBars.Vertical;
            _txtLog.BackColor = Color.FromArgb(15, 23, 42);
            _txtLog.ForeColor = Color.FromArgb(226, 232, 240);
            _txtLog.Font = new Font("Consolas", 8.5f);
            _txtLog.Location = new Point(0, top + 32);
            _txtLog.Size = new Size(652, 118);
            _txtLog.Visible = false;
            p.Controls.Add(_txtLog);

            return p;
        }

        private Panel BuildStep3Page()
        {
            Panel p = new Panel();

            Label h = new Label();
            h.Text = "3. 导入配置文件（可选）";
            h.Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold);
            h.AutoSize = true;
            h.Location = new Point(0, 0);
            p.Controls.Add(h);

            Label desc = new Label();
            desc.Text = "启动 SatGPT 需要 2 个配置文件：环境配置文件 .env 和 GEE 服务账号密钥 JSON。现在通过文件管理器导入，或临时跳过稍后配置。";
            desc.ForeColor = Color.FromArgb(71, 85, 105);
            desc.Size = new Size(652, 38);
            desc.Location = new Point(0, 26);
            p.Controls.Add(desc);

            // Card 1: .env
            Panel envCard = MakeCard(0, 68, 652, 74);
            Label envTitle = new Label();
            envTitle.Text = "文件 1：环境配置文件（.env）";
            envTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            envTitle.AutoSize = true;
            envTitle.Location = new Point(16, 12);
            envCard.Controls.Add(envTitle);

            _lblEnvStatus = new Label();
            _lblEnvStatus.Text = "尚未导入（若原目录旁已有对应密钥 JSON，导入 .env 时会自动一并带入）";
            _lblEnvStatus.ForeColor = Color.FromArgb(100, 116, 139);
            _lblEnvStatus.Font = new Font("Microsoft YaHei UI", 8.5f);
            _lblEnvStatus.AutoEllipsis = true;
            _lblEnvStatus.Size = new Size(444, 22);
            _lblEnvStatus.Location = new Point(16, 38);
            envCard.Controls.Add(_lblEnvStatus);

            _btnImportEnv = MakeButton("选择 .env 文件...", true);
            _btnImportEnv.Size = new Size(168, 36);
            _btnImportEnv.Location = new Point(468, 19);
            _btnImportEnv.Click += OnImportEnvClicked;
            envCard.Controls.Add(_btnImportEnv);
            p.Controls.Add(envCard);

            // Card 2: GEE service account JSON
            Panel credCard = MakeCard(0, 150, 652, 74);
            Label credTitle = new Label();
            credTitle.Text = "文件 2：GEE 服务账号密钥（.private-key.json）";
            credTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            credTitle.AutoSize = true;
            credTitle.Location = new Point(16, 12);
            credCard.Controls.Add(credTitle);

            _lblCredStatus = new Label();
            _lblCredStatus.Text = "尚未导入（任意名称的 .json 均可，导入时自动保存为 .env 指定文件名）";
            _lblCredStatus.ForeColor = Color.FromArgb(100, 116, 139);
            _lblCredStatus.Font = new Font("Microsoft YaHei UI", 8.5f);
            _lblCredStatus.AutoEllipsis = true;
            _lblCredStatus.Size = new Size(444, 22);
            _lblCredStatus.Location = new Point(16, 38);
            credCard.Controls.Add(_lblCredStatus);

            _btnImportCred = MakeButton("选择密钥 JSON...", false);
            _btnImportCred.Size = new Size(168, 36);
            _btnImportCred.Location = new Point(468, 19);
            _btnImportCred.Click += OnImportCredClicked;
            credCard.Controls.Add(_btnImportCred);
            p.Controls.Add(credCard);

            // Skip button row
            _btnSkipEnv = MakeButton("临时跳过此步骤，稍后自行配置", false);
            _btnSkipEnv.Size = new Size(230, 32);
            _btnSkipEnv.Location = new Point(0, 234);
            _btnSkipEnv.Click += OnSkipEnvClicked;
            p.Controls.Add(_btnSkipEnv);

            // Validation feedback card
            _envResultBox = MakeCard(0, 276, 652, 108);
            _envResultBox.Visible = false;

            _lblEnvResultTitle = new Label();
            _lblEnvResultTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            _lblEnvResultTitle.AutoSize = true;
            _lblEnvResultTitle.Location = new Point(16, 12);
            _envResultBox.Controls.Add(_lblEnvResultTitle);

            _lblEnvResultDetail = new Label();
            _lblEnvResultDetail.Font = new Font("Microsoft YaHei UI", 8.5f);
            _lblEnvResultDetail.ForeColor = Color.FromArgb(51, 65, 85);
            _lblEnvResultDetail.Location = new Point(16, 36);
            _lblEnvResultDetail.Size = new Size(620, 62);
            _envResultBox.Controls.Add(_lblEnvResultDetail);

            p.Controls.Add(_envResultBox);

            return p;
        }

        private Panel BuildStep4Page()
        {
            Panel p = new Panel();

            Label h = new Label();
            h.Text = "4. SatGPT 安装完成";
            h.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
            h.ForeColor = OkColor;
            h.AutoSize = true;
            h.Location = new Point(0, 4);
            p.Controls.Add(h);

            Panel summaryCard = MakeCard(0, 42, 652, 184);
            _lblFinishSummary = new Label();
            _lblFinishSummary.Location = new Point(18, 16);
            _lblFinishSummary.Size = new Size(616, 152);
            _lblFinishSummary.Font = new Font("Microsoft YaHei UI", 9.5f);
            _lblFinishSummary.ForeColor = Color.FromArgb(30, 41, 59);
            summaryCard.Controls.Add(_lblFinishSummary);
            p.Controls.Add(summaryCard);

            Panel optCard = MakeCard(0, 242, 652, 108);
            _chkDesktopShortcut = new CheckBox();
            _chkDesktopShortcut.Text = "在桌面创建「SatGPT 启动器」快捷方式";
            _chkDesktopShortcut.Checked = true;
            _chkDesktopShortcut.AutoSize = true;
            _chkDesktopShortcut.Location = new Point(18, 22);
            optCard.Controls.Add(_chkDesktopShortcut);

            _chkLaunchAfter = new CheckBox();
            _chkLaunchAfter.Text = "完成后立即打开 SatGPT 启动器（用于一键启停服务与打开网页）";
            _chkLaunchAfter.Checked = true;
            _chkLaunchAfter.AutoSize = true;
            _chkLaunchAfter.Location = new Point(18, 58);
            optCard.Controls.Add(_chkLaunchAfter);
            p.Controls.Add(optCard);

            return p;
        }

        private Panel MakeCard(int x, int y, int w, int h)
        {
            Panel card = new Panel();
            card.Location = new Point(x, y);
            card.Size = new Size(w, h);
            card.BackColor = Color.White;
            card.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen pen = new Pen(BorderColor))
                {
                    e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
                }
            };
            return card;
        }

        private Button MakeButton(string text, bool primary)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.Size = new Size(92, 34);
            btn.FlatStyle = FlatStyle.Flat;
            btn.Cursor = Cursors.Hand;
            if (primary)
            {
                btn.BackColor = AccentColor;
                btn.ForeColor = Color.White;
                btn.FlatAppearance.BorderSize = 0;
                btn.EnabledChanged += delegate
                {
                    btn.BackColor = btn.Enabled ? AccentColor : Color.FromArgb(203, 213, 225);
                    btn.ForeColor = btn.Enabled ? Color.White : Color.FromArgb(100, 116, 139);
                };
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

        public void ShowStep(int step)
        {
            _currentStep = step;
            for (int i = 0; i < 4; i++)
            {
                _pages[i].Visible = (i == step - 1);
            }
            _headerStepLabel.Text = string.Format("步骤 {0} / 4", step);

            if (step == 1)
            {
                _btnBack.Visible = false;
                _btnNext.Text = "开始安装";
                _btnNext.Enabled = _bundle.IsValid;
                _btnCancel.Enabled = true;
            }
            else if (step == 2)
            {
                _btnBack.Visible = true;
                _btnBack.Enabled = !_installing && !_installSucceeded;
                _btnNext.Text = "下一步";
                _btnNext.Enabled = _installSucceeded;
                _btnCancel.Enabled = !_installing;
            }
            else if (step == 3)
            {
                _btnBack.Visible = false;
                _btnNext.Text = "下一步";
                _btnNext.Enabled = true;
                _btnCancel.Enabled = true;
                RefreshStep3ExistingEnv();
            }
            else if (step == 4)
            {
                _btnBack.Visible = true;
                _btnBack.Enabled = true;
                _btnNext.Text = "完成";
                _btnNext.Enabled = true;
                _btnCancel.Visible = false;
                UpdateFinishSummary();
            }
        }

        private static void ApplyImportButtonStyle(Button btn, bool imported, string defaultText, string importedText, bool primaryWhenIdle)
        {
            if (imported)
            {
                btn.Text = importedText;
                btn.BackColor = OkColor;
                btn.ForeColor = Color.White;
                btn.FlatAppearance.BorderColor = OkColor;
                btn.FlatAppearance.BorderSize = 0;
            }
            else if (primaryWhenIdle)
            {
                btn.Text = defaultText;
                btn.BackColor = AccentColor;
                btn.ForeColor = Color.White;
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

        private void RefreshStep3ExistingEnv()
        {
            string dir = _txtInstallDir.Text.Trim();
            string targetEnv = Path.Combine(dir, ".env");
            _credTargetName = InstallEngine.ResolveCredentialTargetName(dir);
            string targetCred = Path.Combine(dir, _credTargetName);

            bool hasEnv = _envImported || File.Exists(targetEnv);
            bool hasCred = _credImported || File.Exists(targetCred);

            ApplyImportButtonStyle(_btnImportEnv, hasEnv, "选择 .env 文件...", "✓ 已导入 .env（替换）", true);
            ApplyImportButtonStyle(_btnImportCred, hasCred, "选择密钥 JSON...", "✓ 已导入密钥（替换）", false);

            if (File.Exists(targetEnv) && !_envImported && !_envSkipped)
            {
                _lblEnvStatus.Text = "✓ 目录中已有 .env 文件（可直接使用或点击右侧替换）";
                _lblEnvStatus.ForeColor = OkColor;
            }
            if (File.Exists(targetCred) && !_credImported)
            {
                _lblCredStatus.Text = "✓ 目录中已有密钥文件（" + _credTargetName + "）";
                _lblCredStatus.ForeColor = OkColor;
            }
        }

        private void UpdateFinishSummary()
        {
            string dir = _txtInstallDir.Text.Trim();
            string envLine;
            if (_envValidated)
            {
                envLine = "• 配置状态：.env 与 GEE 密钥均已就绪并通过 satgpt_config.py check 校验，可直接启动！";
            }
            else if (_envImported || _credImported)
            {
                envLine = "• 配置状态：已导入部分配置文件，请进入启动器按提示补齐剩余文件后再启动。";
            }
            else if (_envSkipped)
            {
                envLine = "• 配置状态：已临时跳过。可稍后在 SatGPT 启动器中直接导入 .env 与 GEE 密钥 JSON。";
            }
            else if (File.Exists(Path.Combine(dir, ".env")))
            {
                envLine = "• 配置状态：保留了目录中已有的 .env 配置文件。";
            }
            else
            {
                envLine = "• 配置状态：尚未导入配置文件，可在启动器中导入 .env 与 GEE 密钥 JSON。";
            }

            _lblFinishSummary.Text = string.Format(
                "• 安装目录：{0}\r\n" +
                "• 启动入口：{1}\r\n" +
                "{2}\r\n\r\n" +
                "所有 Python 3.12 环境、离线依赖库、Node.js 与前端资源均已独立安装在上述目录中，不污染系统环境变量。",
                dir,
                Path.Combine(dir, "SatGPT-Launcher.exe"),
                envLine);

            _chkLaunchAfter.Checked = _envValidated;
        }

        private void OnNextClicked(object sender, EventArgs e)
        {
            if (_currentStep == 1)
            {
                string dir = _txtInstallDir.Text.Trim();
                if (string.IsNullOrEmpty(dir))
                {
                    MessageBox.Show(this, "请先选择一个有效的安装目录。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                ShowStep(2);
                StartInstallationAsync(dir);
            }
            else if (_currentStep == 2)
            {
                ShowStep(3);
            }
            else if (_currentStep == 3)
            {
                if (!_envImported && !_envSkipped)
                {
                    string targetEnv = Path.Combine(_txtInstallDir.Text.Trim(), ".env");
                    if (!File.Exists(targetEnv))
                    {
                        _envSkipped = true;
                        EnsureEnvTemplate(_txtInstallDir.Text.Trim());
                    }
                }
                ShowStep(4);
            }
            else if (_currentStep == 4)
            {
                string dir = _txtInstallDir.Text.Trim();
                try
                {
                    if (_chkDesktopShortcut.Checked)
                    {
                        InstallEngine.CreateDesktopShortcut(dir);
                    }
                    if (_chkLaunchAfter.Checked)
                    {
                        string launcher = Path.Combine(dir, "SatGPT-Launcher.exe");
                        if (File.Exists(launcher))
                        {
                            ProcessStartInfo psi = new ProcessStartInfo(launcher);
                            psi.WorkingDirectory = dir;
                            psi.UseShellExecute = true;
                            Process.Start(psi);
                        }
                    }
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "完成收尾操作时出现提示：" + ex.Message, "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                Close();
            }
        }

        private void StartInstallationAsync(string targetDir)
        {
            _installing = true;
            _installSucceeded = false;
            _btnNext.Enabled = false;
            _btnBack.Enabled = false;
            _btnCancel.Enabled = false;
            _txtLog.Clear();

            for (int i = 0; i < 4; i++)
            {
                UpdateStepRow(i, 0, "等待中", "等待执行...", AccentColor);
            }

            Thread worker = new Thread(delegate ()
            {
                int activeIndex = 0;
                try
                {
                    InstallEngine.RunFullInstall(
                        _bundle,
                        targetDir,
                        delegate (int stepIndex, int percent, string status, string detail)
                        {
                            activeIndex = stepIndex;
                            Color c = status == "已完成" ? OkColor : AccentColor;
                            BeginInvoke((MethodInvoker)delegate
                            {
                                UpdateStepRow(stepIndex, percent, status, detail, c);
                            });
                        },
                        delegate (string line)
                        {
                            BeginInvoke((MethodInvoker)delegate
                            {
                                AppendLog(line);
                            });
                        });

                    BeginInvoke((MethodInvoker)delegate
                    {
                        _installing = false;
                        _installSucceeded = true;
                        _btnNext.Enabled = true;
                        _btnCancel.Enabled = true;
                        AppendLog("=== 全部 4 个步骤部署完成，请点击“下一步”配置 .env ===");
                    });
                }
                catch (Exception ex)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        _installing = false;
                        _installSucceeded = false;
                        UpdateStepRow(activeIndex, _stepRows[activeIndex].ProgressBar.Value, "失败", ex.Message, ErrColor);
                        AppendLog("[ERROR] " + ex.Message);
                        if (!_logExpanded) _btnToggleLog.PerformClick();
                        _btnBack.Enabled = true;
                        _btnCancel.Enabled = true;
                        MessageBox.Show(this, "部署过程中发生错误：\r\n" + ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    });
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        public void UpdateStepRow(int index, int percent, string status, string detail, Color barColor)
        {
            StepRowUI row = _stepRows[index];
            row.ProgressBar.BarColor = barColor;
            row.ProgressBar.Value = percent;
            row.PercentLabel.Text = percent + "%";
            row.StatusLabel.Text = status;
            if (status == "已完成") row.StatusLabel.ForeColor = OkColor;
            else if (status == "失败") row.StatusLabel.ForeColor = ErrColor;
            else if (status == "进行中") row.StatusLabel.ForeColor = AccentColor;
            else row.StatusLabel.ForeColor = Color.FromArgb(100, 116, 139);
            row.DetailLabel.Text = detail;
        }

        private void AppendLog(string line)
        {
            if (_txtLog.TextLength > 60000)
            {
                _txtLog.Clear();
            }
            _txtLog.AppendText(line + "\r\n");
        }

        private void OnImportEnvClicked(object sender, EventArgs e)
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择 SatGPT 配置文件 (.env)";
                dlg.Filter = "所有文件 (*.*)|*.*|环境配置文件 (*.env;*.env.*)|*.env;*.env.*";
                dlg.CheckFileExists = true;
                if (dlg.ShowDialog(this) != DialogResult.OK) return;

                string targetDir = _txtInstallDir.Text.Trim();
                string dstEnv = Path.Combine(targetDir, ".env");
                try
                {
                    if (File.Exists(dstEnv))
                    {
                        string bak = Path.Combine(targetDir, ".env.bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));
                        File.Copy(dstEnv, bak, true);
                    }
                    File.Copy(dlg.FileName, dstEnv, true);
                    _envImported = true;
                    _envSkipped = false;
                    _lblEnvStatus.Text = "✓ 已导入 .env（来源：" + Path.GetFileName(dlg.FileName) + "）";
                    _lblEnvStatus.ForeColor = OkColor;
                    ApplyImportButtonStyle(_btnImportEnv, true, "选择 .env 文件...", "✓ 已导入 .env（替换）", true);

                    // If sibling GEE JSON exists next to the chosen .env, bring it over automatically
                    string autoCopied;
                    if (InstallEngine.TryAutoBringSiblingCredential(dlg.FileName, targetDir, out autoCopied))
                    {
                        _credImported = true;
                        _credTargetName = autoCopied;
                        _lblCredStatus.Text = "✓ 已自动从同目录一并导入密钥文件（" + autoCopied + "）";
                        _lblCredStatus.ForeColor = OkColor;
                        ApplyImportButtonStyle(_btnImportCred, true, "选择密钥 JSON...", "✓ 已导入密钥（替换）", false);
                    }
                    else
                    {
                        _credTargetName = InstallEngine.ResolveCredentialTargetName(targetDir);
                    }

                    Application.DoEvents();
                    RunAndDisplayStep3Check(targetDir);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "导入 .env 失败：" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private void OnImportCredClicked(object sender, EventArgs e)
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择 GEE 服务账号密钥 JSON";
                dlg.Filter = "JSON 密钥文件 (*.json)|*.json|所有文件 (*.*)|*.*";
                dlg.CheckFileExists = true;
                if (dlg.ShowDialog(this) != DialogResult.OK) return;

                string targetDir = _txtInstallDir.Text.Trim();
                try
                {
                    string savedRel;
                    string err;
                    if (!InstallEngine.ImportCredentialFile(dlg.FileName, targetDir, out savedRel, out err))
                    {
                        MessageBox.Show(this, "密钥文件校验未通过：\r\n" + err, "JSON 无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                    _credImported = true;
                    _credTargetName = savedRel;
                    _envSkipped = false;
                    _lblCredStatus.Text = string.Format("✓ 已导入（{0} → {1}）", Path.GetFileName(dlg.FileName), savedRel);
                    _lblCredStatus.ForeColor = OkColor;
                    ApplyImportButtonStyle(_btnImportCred, true, "选择密钥 JSON...", "✓ 已导入密钥（替换）", false);

                    Application.DoEvents();
                    RunAndDisplayStep3Check(targetDir);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "导入密钥 JSON 失败：" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private void RunAndDisplayStep3Check(string targetDir)
        {
            if (!File.Exists(Path.Combine(targetDir, ".env")))
            {
                _envValidated = false;
                _envResultBox.Visible = true;
                _lblEnvResultTitle.ForeColor = AccentColor;
                _lblEnvResultTitle.Text = "GEE 密钥已保存，请继续导入 .env 文件";
                _lblEnvResultDetail.Text = "已将密钥保存为 " + _credTargetName + "；请点击上方「选择 .env 文件...」完成配置。";
                return;
            }

            bool ok;
            string msg = InstallEngine.RunConfigCheck(targetDir, out ok);
            _envValidated = ok;
            _envResultBox.Visible = true;
            if (ok)
            {
                _lblEnvResultTitle.ForeColor = OkColor;
                _lblEnvResultTitle.Text = "✓ 配置校验全部通过";
                _lblEnvResultDetail.Text = msg + "\r\n你可以直接点击右下角“下一步”完成安装并启动 SatGPT。";
            }
            else
            {
                _lblEnvResultTitle.ForeColor = WarnColor;
                _lblEnvResultTitle.Text = "当前配置仍有待补充项（不影响完成安装）";
                _lblEnvResultDetail.Text = msg;
            }
        }

        private void OnSkipEnvClicked(object sender, EventArgs e)
        {
            string targetDir = _txtInstallDir.Text.Trim();
            EnsureEnvTemplate(targetDir);
            _envSkipped = true;
            _envValidated = false;
            ShowStep(4);
        }

        private static void EnsureEnvTemplate(string targetDir)
        {
            string example = Path.Combine(targetDir, ".env.example");
            if (!File.Exists(example)) return;
            // Keep .env.example in place for reference without overwriting any user .env.
        }

        public void RenderDemoScreenshots(string outputDir)
        {
            Directory.CreateDirectory(outputDir);
            Show();
            Application.DoEvents();

            // Page 1
            ShowStep(1);
            Application.DoEvents();
            SaveFormBitmap(Path.Combine(outputDir, "step1_install_dir.png"));

            // Page 2 (realistic mid-install + completed look)
            ShowStep(2);
            UpdateStepRow(0, 100, "已完成", "SatGPT 应用文件复制完成。", OkColor);
            UpdateStepRow(1, 100, "已完成", "内置 Python 3.12 环境部署完成。", OkColor);
            UpdateStepRow(2, 68, "进行中", "正在解包依赖 (34/50)：deepseek-harness-sdk", AccentColor);
            UpdateStepRow(3, 0, "等待中", "等待上一步完成...", AccentColor);
            Application.DoEvents();
            SaveFormBitmap(Path.Combine(outputDir, "step2_progress_4bars.png"));

            // Page 3 (show imported green state on file 1 & ready state on file 2)
            _installSucceeded = true;
            _envImported = true;
            _credImported = true;
            ShowStep(3);
            _lblEnvStatus.Text = "✓ 已导入 .env（来源：.env）";
            _lblEnvStatus.ForeColor = OkColor;
            _lblCredStatus.Text = "✓ 已自动从同目录一并导入密钥文件（.private-key.json）";
            _lblCredStatus.ForeColor = OkColor;
            _envResultBox.Visible = true;
            _lblEnvResultTitle.ForeColor = OkColor;
            _lblEnvResultTitle.Text = "✓ 配置校验全部通过";
            _lblEnvResultDetail.Text = "Configuration valid (configured only; model/GEE authentication not tested).\r\n你可以直接点击右下角“下一步”完成安装并启动 SatGPT。";
            Application.DoEvents();
            SaveFormBitmap(Path.Combine(outputDir, "step3_env_config.png"));

            // Page 4
            _envSkipped = true;
            ShowStep(4);
            Application.DoEvents();
            SaveFormBitmap(Path.Combine(outputDir, "step4_finish.png"));

            Close();
        }

        private void SaveFormBitmap(string path)
        {
            using (Bitmap bmp = new Bitmap(Width, Height))
            {
                DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }

            BundlePaths bundle = BundlePaths.Discover();

            // Headless silent install mode for automated E2E verification
            string silentDir = null;
            string envSource = null;
            string credSource = null;
            bool skipEnv = false;
            string screenshotDir = null;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--silent-install" && i + 1 < args.Length)
                {
                    silentDir = args[++i];
                }
                else if (args[i] == "--env" && i + 1 < args.Length)
                {
                    envSource = args[++i];
                }
                else if (args[i] == "--cred" && i + 1 < args.Length)
                {
                    credSource = args[++i];
                }
                else if (args[i] == "--skip-env")
                {
                    skipEnv = true;
                }
                else if (args[i] == "--screenshot-dir" && i + 1 < args.Length)
                {
                    screenshotDir = args[++i];
                }
            }

            if (!string.IsNullOrEmpty(silentDir))
            {
                return RunSilentInstall(bundle, silentDir, envSource, credSource, skipEnv);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SetupWizardForm form = new SetupWizardForm(bundle);

            if (!string.IsNullOrEmpty(screenshotDir))
            {
                form.RenderDemoScreenshots(screenshotDir);
                return 0;
            }

            Application.Run(form);
            return 0;
        }

        private static int RunSilentInstall(BundlePaths bundle, string targetDir, string envSource, string credSource, bool skipEnv)
        {
            // Capture all log lines in silent mode on failure
            List<string> recentLogs = new List<string>();
            try
            {
                int[] lastPct = new int[] { -1, -1, -1, -1 };
                InstallEngine.RunFullInstall(
                    bundle,
                    targetDir,
                    delegate (int stepIndex, int percent, string status, string detail)
                    {
                        if (percent == 0 || percent == 100 || percent - lastPct[stepIndex] >= 25)
                        {
                            lastPct[stepIndex] = percent;
                            Console.WriteLine(string.Format("[STEP {0}] {1}% ({2}) {3}", stepIndex + 1, percent, status, detail));
                        }
                    },
                    delegate (string line)
                    {
                        recentLogs.Add(line);
                        if (recentLogs.Count > 40) recentLogs.RemoveAt(0);
                        if (line.StartsWith("===") || line.IndexOf("Successfully installed", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            Console.WriteLine(line);
                        }
                    });

                if (!string.IsNullOrEmpty(envSource))
                {
                    File.Copy(envSource, Path.Combine(targetDir, ".env"), true);
                    string autoCopied;
                    if (string.IsNullOrEmpty(credSource) && InstallEngine.TryAutoBringSiblingCredential(envSource, targetDir, out autoCopied))
                    {
                        Console.WriteLine("[CRED] auto-copied sibling credential -> " + autoCopied);
                    }
                }
                if (!string.IsNullOrEmpty(credSource))
                {
                    string savedRel;
                    string err;
                    if (!InstallEngine.ImportCredentialFile(credSource, targetDir, out savedRel, out err))
                    {
                        throw new InvalidOperationException("导入密钥 JSON 失败：" + err);
                    }
                    Console.WriteLine("[CRED] imported " + Path.GetFileName(credSource) + " -> " + savedRel);
                }

                if (!string.IsNullOrEmpty(envSource))
                {
                    bool ok;
                    string msg = InstallEngine.RunConfigCheck(targetDir, out ok);
                    Console.WriteLine("[ENV] imported from " + envSource + " | check_ok=" + ok);
                    Console.WriteLine("[ENV] " + msg);
                }
                else if (skipEnv)
                {
                    Console.WriteLine("[ENV] skipped (template .env.example ready in " + targetDir + ")");
                }
                Console.WriteLine("[DONE] Silent install succeeded -> " + targetDir);
                return 0;
            }
            catch (Exception ex)
            {
                foreach (string l in recentLogs) Console.Error.WriteLine("  | " + l);
                Console.Error.WriteLine("[FAILED] " + ex.Message);
                return 1;
            }
        }
    }
}

// Native offline UI. Business operations remain in the original Node application workflow.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class Workbench : Form {
    readonly string root, node, pwsh;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    readonly ComboBox kind = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 345 };
    readonly TextBox source = new TextBox { ReadOnly = true, Width = 345 };
    readonly TextBox config = new TextBox { ReadOnly = true, Width = 345 };
    readonly DateTimePicker start = new DateTimePicker { ShowCheckBox = true, Checked = false, Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd", Width = 345 };
    readonly DateTimePicker end = new DateTimePicker { ShowCheckBox = true, Checked = false, Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd", Width = 345 };
    readonly ListBox tasks = new ListBox { Dock = DockStyle.Fill, IntegralHeight = false };
    readonly TextBox taskId = new TextBox { ReadOnly = true, Dock = DockStyle.Fill };
    readonly TextBox details = new TextBox { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly TextBox query = new TextBox { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill };
    readonly Label footer = new Label { Dock = DockStyle.Bottom, Height = 44, Padding = new Padding(12,9,0,0) };
    readonly Button upload = MakeButton("核对并上传（打开确认终端）"), next = MakeButton("下一页"), inspect = MakeButton("查看 / 刷新状态"), queries = MakeButton("选择此任务的查询参数"), guide = MakeButton("生成手机使用说明"), copy = MakeButton("复制当前内容");
    readonly TableLayoutPanel body = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Padding = new Padding(12) };
    string nextCursor, loadedTask, loadedState, displayedContent;
    string[] sourcePaths = new string[0];
    bool showingInputPreview;
    readonly Timer uploadTimer = new Timer { Interval = 300 };
    Process uploadProcess;
    string uploadingTask;

    static Label MakeLabel(string text) { return new Label { Text = text, AutoSize = true, MaximumSize = new Size(345,0), Margin = new Padding(3,8,3,3) }; }
    static Button MakeButton(string text) { return new Button { Text = text, AutoSize = true, MinimumSize = new Size(95,34), Height = 34 }; }
    static Dictionary<string,object> Map(object value) { return value as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    static string TextOf(Dictionary<string,object> map, string key) { object value; return map.TryGetValue(key,out value) && value != null ? Convert.ToString(value,CultureInfo.InvariantCulture) : ""; }
    static object Value(Dictionary<string,object> map, string key) { object value; return map.TryGetValue(key,out value) ? value : null; }

    // Windows argv quoting, never shell evaluation. Handles spaces, quotes and trailing backslashes.
    internal static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\',slashes * 2 + 1); b.Append('"'); }
            else { b.Append('\\',slashes); b.Append(c); }
            slashes = 0;
        }
        b.Append('\\',slashes * 2); b.Append('"'); return b.ToString();
    }
    static string Arguments(string[] values) { return String.Join(" ",Array.ConvertAll(values,Quote)); }
    internal static string[] DateWindow(DateTime first, DateTime last) {
        if (last.Date < first.Date || (last.Date - first.Date).Days >= 31) throw new Exception("请选择先后顺序正确、最多31天的日期。");
        return new[] { first.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture) + "T00:00:00+08:00",
            last.Date.AddDays(1).ToString("yyyy-MM-dd",CultureInfo.InvariantCulture) + "T00:00:00+08:00" };
    }
    internal static string LocalErrorMessage(string errorJson) {
        const string fallback = "本地操作未完成，请保留任务和已有文件后核对。不会自动上传、覆盖或重试。";
        try {
            if (errorJson == null || errorJson.Length > 8192) return fallback;
            var report = Map(new JavaScriptSerializer().DeserializeObject(errorJson));
            string code = TextOf(report,"error");
            if (!System.Text.RegularExpressions.Regex.IsMatch(code,@"\A(?:invalid_bridge_(?:command|client_config|import_job|import_receipt|task_cursor)|invalid_activity_capture_set|interactive_terminal_required|local_file_invalid|import_task_not_saved|upload_cancelled|upload_task_changed|upload_destination_changed|uploaded_receipt_not_saved|query_bundle_not_saved|chatgpt_guide_not_saved|bridge_outcome_unknown|bridge_rejected_(?:400|401|403|404|409|413|415|429)|local_command_failed)\z")) return fallback;
            if (!(Value(report,"message") is string) || !(Value(report,"recovery") is string)) return fallback;
            string message = TextOf(report,"message"), recovery = TextOf(report,"recovery");
            if (message.Length == 0 || message.Length > 512 || recovery.Length == 0 || recovery.Length > 2048 ||
                !(Value(report,"automaticRetry") is bool) || (bool)Value(report,"automaticRetry")) return fallback;
            // Only our local CLI's fixed error contract is displayed; raw stderr is never shown.
            return message + "\r\n\r\n下一步：" + recovery;
        } catch { return fallback; }
    }
    Dictionary<string,object> Local(params string[] args) {
        if (Array.IndexOf(new[] { "overview","preview","prepare","list","inspect","queries","chatgpt" },args[0]) < 0) throw new Exception("本地操作入口不允许上传。");
        var all = new List<string> { Path.Combine(root,"backend","bridge-command.mts") }; all.AddRange(args);
        var info = new ProcessStartInfo(node,Arguments(all.ToArray())) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false), WorkingDirectory = root
        };
        using (var p = Process.Start(info)) {
            var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(30000)) { p.Kill(); throw new Exception("本地操作超时，请保留任务文件后核对。不会自动上传。"); }
            if (p.ExitCode != 0) {
                throw new Exception(LocalErrorMessage(error.Result));
            }
            return Map(json.DeserializeObject(output.Result));
        }
    }
    void RunLocal(Action action) {
        UseWaitCursor = true; body.Enabled = false;
        try { action(); } catch (Exception e) {
            // A failed action must not leave an earlier task's exports or upload readiness usable.
            // Keep the explicit task ID so the user can inspect it again, including a newly saved task.
            ResetView();
            footer.Text = "操作未完成；已清除旧显示，请重新查看任务状态。未自动上传或重试。";
            MessageBox.Show(this,e.Message,"Health AI Bridge",MessageBoxButtons.OK,MessageBoxIcon.Warning);
        }
        finally { body.Enabled = true; UseWaitCursor = false; }
    }
    string[] PickFiles(string title, bool multiple = false) {
        using (var dialog = new OpenFileDialog { Title = title, Filter = "JSON 文件 (*.json)|*.json", CheckFileExists = true, RestoreDirectory = true, Multiselect = multiple }) {
            return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileNames : null;
        }
    }
    void ResetView() { details.Clear(); ClearExport(); queries.Enabled = guide.Enabled = upload.Enabled = false; loadedTask = loadedState = null; showingInputPreview = false; }
    void ClearExport() { query.Clear(); copy.Enabled = false; displayedContent = null; }
    string[] InputArguments(string command) {
        if (kind.SelectedIndex < 0 || !start.Checked || !end.Checked) throw new Exception("请明确选择数据类别、文件，并勾选开始和结束日期。");
        return CaptureArguments(command,kind.SelectedIndex == 0 ? "sleep" : "activity",sourcePaths,DateWindow(start.Value,end.Value));
    }
    internal static string[] CaptureArguments(string command, string kind, string[] paths, string[] window) {
        if (paths.Length == 0) throw new Exception("请先选择文件。");
        if (kind == "sleep" && paths.Length != 1) throw new Exception("请重新选择一份睡眠采集文件。");
        var args = new List<string> { command, kind };
        if (paths.Length > 1) args.Add("--captures");
        args.AddRange(paths);
        args.AddRange(window);
        return args.ToArray();
    }
    void InvalidateInputPreview() {
        if (!showingInputPreview) return;
        ResetView(); footer.Text = "输入已变更，请重新预检。创建任务时仍会重新读取文件并校验。";
    }
    internal static string InputPreviewText(Dictionary<string,object> report) {
        if (TextOf(report,"status") != "validated_locally_no_task_created" ||
            (TextOf(report,"kind") != "sleep" && TextOf(report,"kind") != "activity") || report.ContainsKey("jobId"))
            throw new Exception("预检结果无法确认，请核对输入后重新预检。");
        var window = Map(Value(report,"requestedWindow")); var counts = Map(Value(report,"counts"));
        string stageCount = TextOf(counts,"sourceStages");
        return "仅预检通过；未创建任务，尚未上传。\r\n类别：" + (TextOf(report,"kind") == "sleep" ? "睡眠" : "运动") +
            "\r\n请求范围：" + TextOf(window,"start") + " 至 " + TextOf(window,"end") + "（结束不含）" +
            "\r\n来源记录数：" + TextOf(counts,"sourceRecords") + "；预计上传大小：" + TextOf(report,"requestBytes") + " 字节。" +
            (stageCount.Length > 0 ? "\r\n采集文件分期数：" + stageCount + " 段" : "") +
            "\r\n采集覆盖限制：" + TextOf(Map(Value(report,"collection")),"notice") +
            "\r\n这是上次读取时的预览；创建任务时重新读取并校验，不以预览代替上传确认。";
    }
    internal static string ReceiptSummaryText(Dictionary<string,object> report) {
        if (TextOf(report,"state") != "committed_receipt_saved") return "";
        var receipt = Map(Value(report,"receiptSummary"));
        if (receipt.Count == 0) return "";
        DateTimeOffset committedAt;
        string timestamp = TextOf(receipt,"committedAt");
        if (DateTimeOffset.TryParse(timestamp,CultureInfo.InvariantCulture,DateTimeStyles.None,out committedAt)) {
            timestamp = committedAt.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd HH:mm:ss zzz",CultureInfo.InvariantCulture);
        }
        string summary = "\r\n云端提交时间：" + timestamp + "\r\n本批接收记录：" + TextOf(receipt,"receivedRecords") + " 条";
        if (TextOf(report,"kind") == "sleep") {
            bool created = true.Equals(Value(receipt,"snapshotCreated"));
            return summary + "\r\n睡眠快照：" + TextOf(receipt,"snapshotId") + (created ? "（本批新建）" : "（本批复用）");
        }
        return summary + "\r\n本批新增或更新：" + TextOf(receipt,"changedRecords") + " 条";
    }
    bool CanOpenUpload() {
        return uploadProcess == null && loadedTask == taskId.Text && config.Text.Length > 0 &&
            Array.IndexOf(new[] { "prepared","bound_without_local_receipt","committed_receipt_saved" },loadedState) >= 0;
    }
    void UpdateUpload() { upload.Enabled = CanOpenUpload(); }
    void ObserveUploadTerminal() {
        if (!uploadProcess.HasExited) return;
        uploadTimer.Stop();
        uploadProcess.Dispose();
        uploadProcess = null;
        var finishedTask = uploadingTask;
        uploadingTask = null;
        if (taskId.Text == finishedTask) {
            ResetView();
            footer.Text = "确认终端已关闭。请点击“查看 / 刷新状态”核对本地回执。";
        } else UpdateUpload();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) {
            uploadTimer.Dispose();
            if (uploadProcess != null) uploadProcess.Dispose();
        }
        base.Dispose(disposing);
    }
    void LoadPage(string cursor) {
        tasks.Items.Clear(); taskId.Clear(); ResetView();
        nextCursor = null; next.Enabled = inspect.Enabled = false;
        var page = String.IsNullOrEmpty(cursor) ? Local("list") : Local("list",cursor);
        var items = Value(page,"tasks") as object[] ?? new object[0];
        foreach (var item in items) tasks.Items.Add(TextOf(Map(item),"jobId"));
        tasks.SelectedIndex = -1; nextCursor = TextOf(page,"nextCursor"); next.Enabled = nextCursor.Length > 0;
        footer.Text = "本页 " + items.Length + " 个本地任务编号；未读取任务正文。请选择后查看状态。";
    }
    void LoadDetails() {
        if (taskId.Text.Length == 0) throw new Exception("请先明确选择一个任务。");
        ResetView(); var report = Local("inspect",taskId.Text); var preview = Map(Value(report,"preview"));
        var window = Map(Value(preview,"requestedWindow")); var counts = Map(Value(preview,"counts"));
        string state = TextOf(report,"state"), stateText;
        switch (state) {
            case "prepared": stateText = "已准备，尚无上传成功回执"; break;
            case "bound_without_local_receipt": stateText = "已有目标绑定，服务端结果未知；请保留原任务"; break;
            case "committed_receipt_saved": stateText = "上传成功回执已保存，可以明确选择查询参数"; break;
            default: stateText = "本地回执或文件不一致；请保留文件后核对"; break;
        }
        details.Text = "类别：" + (TextOf(report,"kind") == "sleep" ? "睡眠" : "运动") + "\r\n状态：" + stateText +
            "\r\n请求范围：" + TextOf(window,"start") + " 至 " + TextOf(window,"end") + "（结束不含）" +
            "\r\n来源记录数：" + TextOf(counts,"sourceRecords") + "；源端完整性未知。";
        string stageCount = TextOf(counts,"sourceStages");
        if (stageCount.Length > 0) details.AppendText("\r\n采集文件分期数：" + stageCount + " 段");
        string collectionNotice = TextOf(Map(Value(report,"collection")),"notice");
        if (collectionNotice.Length > 0) details.AppendText("\r\n采集覆盖限制：" + collectionNotice);
        string target = TextOf(Map(Value(report,"destination")),"baseUrl");
        if (target.Length > 0) details.AppendText("\r\n绑定目标：" + target);
        details.AppendText(ReceiptSummaryText(report));
        if (TextOf(report,"recovery").Length > 0) details.AppendText("\r\n" + TextOf(report,"recovery"));
        loadedTask = taskId.Text; loadedState = state; queries.Enabled = guide.Enabled = state == "committed_receipt_saved"; UpdateUpload();
        footer.Text = "已离线查看所选任务的预检摘要和回执状态；未读取会话明细或联网。";
    }
    static string Pretty(string text) {
        var b = new StringBuilder(); bool quoted = false, escaped = false; int level = 0;
        foreach (char c in text) {
            if (quoted) { b.Append(c); if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') quoted = false; continue; }
            if (c == '"') { quoted = true; b.Append(c); }
            else if (c == '{' || c == '[') { b.Append(c); b.AppendLine(); level++; b.Append(' ',level * 2); }
            else if (c == '}' || c == ']') { level--; b.AppendLine(); b.Append(' ',level * 2); b.Append(c); }
            else if (c == ',') { b.Append(c); b.AppendLine(); b.Append(' ',level * 2); }
            else if (c == ':') b.Append(": "); else b.Append(c);
        }
        return b.ToString();
    }
    Workbench(string workspace, string nodePath, string powershellPath) {
        root = workspace; node = nodePath; pwsh = powershellPath;
        Text = "Health AI Bridge 本地工作台"; Size = new Size(1100,800); MinimumSize = new Size(1000,740); StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI",10); AutoScaleMode = AutoScaleMode.Dpi;
        var header = new Label { Text = "Health AI Bridge  本地工作台\r\n预检文件 → 创建任务 → 确认上传 → 核对回执 → 生成手机使用说明。", Dock = DockStyle.Top, Height = 66, Padding = new Padding(15,10,0,0) };
        footer.Text = "尚未执行操作。打开工作台不会读取健康文件、私人配置或联网。";
        Controls.Add(header); Controls.Add(footer); Controls.Add(body); body.BringToFront();
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,390)); body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        var left = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true }; body.Controls.Add(left,0,0);
        left.Controls.Add(MakeLabel("1. 准备本地文件")); left.Controls.Add(MakeLabel("数据类别（需明确选择）")); kind.Items.AddRange(new object[] { "睡眠采集文件","运动采集文件 / 记录数组" }); kind.SelectedIndex = -1; left.Controls.Add(kind);
        left.Controls.Add(MakeLabel("已选文件（运动可多选）")); left.Controls.Add(source);
        var browse = MakeButton("选择采集 / 运动文件…"); left.Controls.Add(browse); browse.Click += (s,e) => {
            bool activity = kind.SelectedIndex == 1;
            var paths = PickFiles(activity ? "选择同一账号的运动采集文件（可多选）" : "选择一份采集文件",activity);
            if (paths == null) return;
            sourcePaths = paths;
            source.Text = String.Join(" | ",paths);
            InvalidateInputPreview();
        };
        left.Controls.Add(MakeLabel("开始日期（北京时间，勾选后生效）")); left.Controls.Add(start);
        left.Controls.Add(MakeLabel("结束日期（包含当天；勾选后生效）")); left.Controls.Add(end);
        left.Controls.Add(MakeLabel("日期按 +08:00 计算，最多31天。未勾选不使用当前显示日期。"));
        var previewInput = MakeButton("仅预检，不创建任务"); left.Controls.Add(previewInput); previewInput.Click += (s,e) => RunLocal(() => {
            tasks.ClearSelected(); taskId.Clear(); ResetView(); inspect.Enabled = false;
            var report = Local(InputArguments("preview")); details.Text = InputPreviewText(report); showingInputPreview = true;
            footer.Text = "预检通过，未创建任务、未上传。需要保存任务时，点击“创建本地任务（重新预检）”。";
        });
        var prepare = MakeButton("创建本地任务（重新预检）"); left.Controls.Add(prepare); prepare.Click += (s,e) => RunLocal(() => {
            tasks.ClearSelected(); taskId.Clear(); ResetView(); inspect.Enabled = false;
            var result = Local(InputArguments("prepare"));
            tasks.ClearSelected(); taskId.Text = TextOf(result,"jobId"); inspect.Enabled = true; LoadDetails(); footer.Text = "已创建本地任务，原文件保留。尚未上传；可选择配置后打开确认终端。";
        });
        kind.SelectedIndexChanged += (s,e) => InvalidateInputPreview();
        start.ValueChanged += (s,e) => InvalidateInputPreview(); end.ValueChanged += (s,e) => InvalidateInputPreview();
        left.Controls.Add(MakeLabel("2. 选择上传配置（可稍后进行）")); left.Controls.Add(config);
        var browseConfig = MakeButton("选择独立 Bridge 配置…"); left.Controls.Add(browseConfig); browseConfig.Click += (s,e) => { var paths = PickFiles("选择独立 Bridge 设备配置（非华为登录信息）"); if (paths != null) { config.Text = paths[0]; UpdateUpload(); } };
        left.Controls.Add(MakeLabel("配置只在上传终端读取。不要选择华为登录信息。任务中不保存 token。")); left.Controls.Add(upload);
        left.Controls.Add(MakeLabel("请在终端确认。关闭终端后，到右侧刷新任务状态。"));
        uploadTimer.Tick += (s,e) => ObserveUploadTerminal();
        upload.Click += (s,e) => RunLocal(() => {
            if (!CanOpenUpload()) throw new Exception("请先查看所选任务状态并选择配置。");
            Guid id; if (!Guid.TryParse(taskId.Text,out id)) throw new Exception("任务编号无效。");
            var script = Path.Combine(root,"tools","Bridge-Upload.ps1");
            if (!File.Exists(script)) throw new Exception("找不到上传确认脚本，请核对工作台安装目录。");
            var arguments = Arguments(new[] { "-NoProfile","-File",script,"-TaskId",id.ToString(),"-ConfigPath",config.Text,"-NodeExecutable",node });
            var info = new ProcessStartInfo(pwsh,arguments) {
                UseShellExecute = true, WindowStyle = ProcessWindowStyle.Normal, WorkingDirectory = root
            };
            uploadProcess = Process.Start(info);
            if (uploadProcess == null) throw new Exception("未能打开上传确认终端。");
            uploadingTask = taskId.Text;
            UpdateUpload();
            uploadTimer.Start();
            footer.Text = "已打开确认终端。请在那里确认或取消，关闭后刷新所选任务状态。";
        });
        var right = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 10 }; body.Controls.Add(right,1,0);
        foreach (int height in new[] { 32,40,110,36,40,135,40,40 }) right.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
        right.RowStyles.Add(new RowStyle(SizeType.Percent,100)); right.RowStyles.Add(new RowStyle(SizeType.Absolute,30));
        right.Controls.Add(MakeLabel("3. 选择本地任务并查看状态"),0,0);
        var pager = new FlowLayoutPanel { Dock = DockStyle.Fill }; var refresh = MakeButton("刷新任务列表"); pager.Controls.Add(refresh); pager.Controls.Add(next); right.Controls.Add(pager,0,1);
        refresh.Click += (s,e) => RunLocal(() => LoadPage(null)); next.Click += (s,e) => RunLocal(() => { if (!String.IsNullOrEmpty(nextCursor)) LoadPage(nextCursor); });
        right.Controls.Add(tasks,0,2); right.Controls.Add(taskId,0,3); right.Controls.Add(inspect,0,4); right.Controls.Add(details,0,5);
        tasks.SelectedIndexChanged += (s,e) => { ResetView(); taskId.Text = tasks.SelectedIndex >= 0 ? Convert.ToString(tasks.SelectedItem) : ""; inspect.Enabled = taskId.Text.Length > 0; };
        inspect.Click += (s,e) => RunLocal(LoadDetails);
        var queryActions = new FlowLayoutPanel { Dock = DockStyle.Fill }; queryActions.Controls.Add(queries); right.Controls.Add(queryActions,0,6);
        var guideActions = new FlowLayoutPanel { Dock = DockStyle.Fill }; guideActions.Controls.Add(guide); guideActions.Controls.Add(copy); right.Controls.Add(guideActions,0,7);
        right.Controls.Add(query,0,8); right.Controls.Add(MakeLabel("说明含日期及快照标识；复制后自行发送，不自动调用 MCP。"),0,9);
        queries.Click += (s,e) => RunLocal(() => {
            ClearExport();
            if (loadedTask != taskId.Text || loadedState != "committed_receipt_saved") throw new Exception("请先查看并核对所选任务的成功回执。");
            var result = Local("queries",taskId.Text); query.Text = Pretty(json.Serialize(Value(result,"queries"))); displayedContent = "查询参数"; copy.Enabled = true;
            footer.Text = TextOf(result,"querySemantics") == "explicit_task_receipt_snapshot" ? "已选择此任务回执的睡眠快照；已保存参数，未调用 MCP。" : "已选择此任务日期窗的运动实时查询，可能包含其他批次；未调用 MCP。";
        });
        guide.Click += (s,e) => RunLocal(() => {
            ClearExport();
            if (loadedTask != taskId.Text || loadedState != "committed_receipt_saved") throw new Exception("请先查看并核对所选任务的成功回执。");
            var result = Local("chatgpt",taskId.Text);
            query.Text = TextOf(result,"prompt").Replace("\n","\r\n"); displayedContent = "手机使用说明"; copy.Enabled = query.Text.Length > 0;
            footer.Text = "已保存中文说明，含所选日期和睡眠快照标识；未发送给 ChatGPT，未调用 MCP。";
        });
        copy.Click += (s,e) => RunLocal(() => {
            if (displayedContent == null || query.Text.Length == 0) return;
            Clipboard.SetText(query.Text);
            footer.Text = displayedContent + "已复制到本机剪贴板，未发送给任何客户端。";
        });
        upload.Enabled = next.Enabled = inspect.Enabled = queries.Enabled = guide.Enabled = copy.Enabled = false;
    }
    [STAThread]
    static int Main(string[] args) {
        if (args.Length != 3) return 2;
        try {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            using (var form = new Workbench(args[0],args[1],args[2])) Application.Run(form);
            return 0;
        } catch { Console.Error.WriteLine("BRIDGE_DESKTOP_UI_FAILED"); return 1; }
    }
}

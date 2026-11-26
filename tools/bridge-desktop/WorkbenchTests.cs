// Headless date/argv, preview and CLI feedback tests. Synthetic files only; no form, credentials, browser or network.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

internal static class WorkbenchTests {
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        if (args.Length > 0 && args[0] == "--echo") { Console.WriteLine(json.Serialize(args)); return 0; }
        try {
            var window = Workbench.DateWindow(new DateTime(2026,1,1),new DateTime(2026,1,31));
            Check(window[0] == "2026-01-01T00:00:00+08:00" && window[1] == "2026-02-01T00:00:00+08:00","31-day exclusive end");
            string[] captures = { "D:\\合成 目录\\运动 1.json", "D:\\合成 目录\\运动 2.json" };
            var multiple = Workbench.CaptureArguments("preview","activity",captures,window);
            Check(multiple.Length == 7 && multiple[0] == "preview" && multiple[1] == "activity" && multiple[2] == "--captures" &&
                multiple[3] == captures[0] && multiple[4] == captures[1] && multiple[5] == window[0] && multiple[6] == window[1],
                "multi-file activity arguments retain explicit paths and independent date range");
            var single = Workbench.CaptureArguments("prepare","activity",new[] { captures[0] },window);
            Check(single.Length == 5 && single[2] == captures[0],"single-file activity command stays compatible");
            bool multipleSleepRejected = false;
            try { Workbench.CaptureArguments("preview","sleep",captures,window); } catch { multipleSleepRejected = true; }
            Check(multipleSleepRejected,"sleep accepts one capture file");
            var priorCulture = CultureInfo.CurrentCulture;
            try {
                CultureInfo.CurrentCulture = new CultureInfo("th-TH");
                var leap = Workbench.DateWindow(new DateTime(2024,2,29),new DateTime(2024,2,29));
                Check(leap[1] == "2024-03-01T00:00:00+08:00","invariant Gregorian date");
            } finally { CultureInfo.CurrentCulture = priorCulture; }
            foreach (var end in new[] { new DateTime(2025,12,31),new DateTime(2026,2,1) }) {
                bool rejected = false; try { Workbench.DateWindow(new DateTime(2026,1,1),end); } catch { rejected = true; }
                Check(rejected,"invalid range must fail");
            }
            string[] values = { "--echo", "D:\\合成 目录\\file.json", "literal $() & ` text", "quote\"slash\\", "", "trailing space ", "\\\\server\\folder\\" };
            var quoted = Array.ConvertAll(values,Workbench.Quote);
            var info = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,String.Join(" ",quoted)) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
                StandardOutputEncoding = new UTF8Encoding(false)
            };
            using (var p = Process.Start(info)) {
                string output = p.StandardOutput.ReadToEnd(); Check(p.WaitForExit(10000) && p.ExitCode == 0,"argv echo process");
                var actual = json.Deserialize<string[]>(output);
                Check(actual.Length == values.Length,"argv count");
                for (int i = 0; i < values.Length; i++) Check(actual[i] == values[i],"argv preservation");
            }
            var failure = new ProcessStartInfo("node", String.Join(" ",Array.ConvertAll(new[] {
                "backend/bridge-command.mts", "prepare", "activity", "synthetic-nonexistent-file.json",
                "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"
            },Workbench.Quote))) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true,
                RedirectStandardOutput = true, StandardErrorEncoding = new UTF8Encoding(false) };
            using (var p = Process.Start(failure)) {
                var stderr = p.StandardError.ReadToEndAsync(); var stdout = p.StandardOutput.ReadToEndAsync();
                Check(p.WaitForExit(10000) && p.ExitCode == 1,"real CLI failure");
                string display = Workbench.LocalErrorMessage(stderr.Result);
                Check(display.Contains("本地文件") && display.Contains("下一步：") && display.Contains("UTF-8 JSON"),"shared CLI feedback reaches desktop formatter");
                Check(!display.Contains("synthetic-nonexistent-file") && stdout.Result.Length == 0,"private path not reflected");
            }
            const string privateMarker = "synthetic-sensitive-stderr";
            foreach (string invalid in new[] { privateMarker, "{", "{\"error\":\"unknown_code\",\"message\":\"" + privateMarker + "\"}",
                "{\"error\":\"local_file_invalid\",\"message\":\"" + privateMarker + "\",\"automaticRetry\":true}", new String('x',8193) }) {
                string display = Workbench.LocalErrorMessage(invalid);
                Check(!display.Contains(privateMarker) && display.Contains("保留任务"),"malformed stderr uses fixed fallback");
            }
            const string sleepReceipt = "{\"state\":\"committed_receipt_saved\",\"kind\":\"sleep\",\"receiptSummary\":{" +
                "\"committedAt\":\"2026-01-03T23:10:00Z\",\"receivedRecords\":3," +
                "\"snapshotId\":\"00000000-0000-4000-8000-000000000000\",\"snapshotCreated\":false}}";
            var sleepReport = json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(sleepReceipt);
            var receiptText = Workbench.ReceiptSummaryText(sleepReport);
            Check(receiptText.Contains("2026-01-04 07:10:00 +08:00") && receiptText.Contains("本批接收记录：3 条") &&
                receiptText.Contains("00000000-0000-4000-8000-000000000000（本批复用）"),"saved sleep receipt details and Beijing time");
            sleepReport["state"] = "bound_without_local_receipt";
            Check(Workbench.ReceiptSummaryText(sleepReport) == "","unconfirmed report never displays receipt details");
            var activityReport = json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(
                "{\"state\":\"committed_receipt_saved\",\"kind\":\"activity\",\"receiptSummary\":{" +
                "\"committedAt\":\"2026-01-03T23:10:00Z\",\"receivedRecords\":2,\"changedRecords\":0}}");
            receiptText = Workbench.ReceiptSummaryText(activityReport);
            Check(receiptText.Contains("本批接收记录：2 条") && receiptText.Contains("本批新增或更新：0 条"),"activity receipt separates received records and changes");
            var sleepPreview = json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(
                "{\"status\":\"validated_locally_no_task_created\",\"kind\":\"sleep\",\"counts\":{\"sourceRecords\":3,\"sourceStages\":452}}");
            Check(Workbench.InputPreviewText(sleepPreview).Contains("采集文件分期数：452 段"),"sleep preview exposes the expected stage count");
            string syntheticFile = Path.Combine(Path.GetTempPath(),"hab-preview-" + Guid.NewGuid().ToString() + ".json");
            try {
                File.WriteAllText(syntheticFile,"[{\"id\":\"synthetic-desktop-preview\",\"activityType\":56,\"startTime\":1767229200000,\"endTime\":1767232800000,\"modifyTime\":1767312000000}]",new UTF8Encoding(false));
                var preview = new ProcessStartInfo("node",String.Join(" ",Array.ConvertAll(new[] { "backend/bridge-command.mts","preview","activity",syntheticFile,
                    "2026-01-01T00:00:00Z","2026-01-03T00:00:00Z" },Workbench.Quote))) {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false)
                };
                using (var p = Process.Start(preview)) {
                    var output = p.StandardOutput.ReadToEndAsync(); var error = p.StandardError.ReadToEndAsync();
                    Check(p.WaitForExit(10000) && p.ExitCode == 0,"real preview CLI");
                    var report = json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(output.Result);
                    string display = Workbench.InputPreviewText(report);
                    Check(display.Contains("未创建任务") && display.Contains("来源记录数：1") && display.Contains("字节") && display.Contains("重新读取并校验"),"preview summary and revalidation boundary");
                    Check(!display.Contains("synthetic-desktop-preview") && !display.Contains(syntheticFile),"preview excludes source ID and path");
                }
                bool rejected = false; try { Workbench.InputPreviewText(new System.Collections.Generic.Dictionary<string,object>()); } catch { rejected = true; }
                Check(rejected,"malformed preview cannot be displayed as success");
            } finally { File.Delete(syntheticFile); }
            Console.WriteLine("BRIDGE_DESKTOP_BOUNDARY_PASS: dates, 31-day limit, leap day, culture, Windows argv, CLI feedback, receipt summary and read-only preview."); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}

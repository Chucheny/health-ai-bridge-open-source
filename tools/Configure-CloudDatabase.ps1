param(
    [Parameter(Mandatory)][string]$ProjectRef,
    [Parameter(Mandatory)][string]$DatabaseHost
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateCloudConfig.ps1')
if ($ProjectRef -notmatch '^[a-z]{20}$' -or $DatabaseHost -notmatch '^[a-z0-9.-]+\.pooler\.supabase\.com$') { exit 1 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = 'Health AI Bridge — 本机安全配置'
$form.ClientSize = [Drawing.Size]::new(540, 260)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10)
$description = [Windows.Forms.Label]::new()
$description.SetBounds(22, 18, 496, 100)
$description.Text = "请输入刚才创建 Supabase 数据库时保存的密码。`n这不是 Google、ChatGPT 或 Netlify 的登录密码。`n用于连接你自己的 Health AI Bridge 数据库；只保存为本机加密文件，不写入聊天、公开代码或普通日志。"
$form.Controls.Add($description)
$destination = [Windows.Forms.Label]::new()
$destination.SetBounds(22, 120, 496, 22)
$destination.Text = '目标数据库：' + $ProjectRef + '（新加坡）'
$form.Controls.Add($destination)
$passwordBox = [Windows.Forms.TextBox]::new()
$passwordBox.SetBounds(22, 150, 496, 28)
$passwordBox.UseSystemPasswordChar = $true
$passwordBox.MaxLength = 1024
$form.Controls.Add($passwordBox)
$save = [Windows.Forms.Button]::new()
$save.SetBounds(288, 202, 112, 34)
$save.Text = '加密保存'
$save.DialogResult = [Windows.Forms.DialogResult]::OK
$form.Controls.Add($save)
$cancel = [Windows.Forms.Button]::new()
$cancel.SetBounds(408, 202, 110, 34)
$cancel.Text = '暂不配置'
$cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)
$form.AcceptButton = $save
$form.CancelButton = $cancel
try {
    if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK -or $passwordBox.Text.Length -eq 0) { exit 2 }
    $config = @{ schemaVersion = 1; projectRef = $ProjectRef; host = $DatabaseHost; port = 6543;
        username = 'postgres.' + $ProjectRef; password = $passwordBox.Text }
    Save-BridgePrivateConfig 'database-admin' ($config | ConvertTo-Json -Compress)
    $passwordBox.Clear()
    $config.password = $null
    Write-Output 'PRIVATE_DATABASE_CONFIG_SAVED'
} catch {
    [Windows.Forms.MessageBox]::Show('未能保存加密配置。密码没有写入日志，请返回聊天告知助手。', '配置未完成') | Out-Null
    exit 1
} finally { $passwordBox.Clear(); $form.Dispose() }

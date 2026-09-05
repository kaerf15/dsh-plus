# 家中 Windows：Tailscale Serve + dsh web（方案 B）
# 双击「家中Win-一键启动.bat」— 含 dsh 重启（先停 3080 再拉起）
# 仅重启 dsh：.\home-win-tailscale-serve.ps1 -RestartDshOnly

param(
    [switch]$RestartDshOnly
)

$ErrorActionPreference = "Stop"

$DshPort = 3080
$Backend = "http://127.0.0.1:${DshPort}"

function Get-MagicDns {
    try {
        $json = tailscale status --json 2>$null | ConvertFrom-Json
        $self = $json.Self.DNSName
        if ($self) { return $self.TrimEnd('.') }
    } catch {}
    return "lymhome.tail2453a3.ts.net"
}

function Stop-DshWeb {
    $conns = @(Get-NetTCPConnection -LocalPort $DshPort -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) {
        Write-Host "端口 $DshPort 无监听进程。"
        return
    }
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 }
    foreach ($procId in $pids) {
        Write-Host ">> 结束占用 ${DshPort} 的进程 PID $procId"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    $still = Get-NetTCPConnection -LocalPort $DshPort -State Listen -ErrorAction SilentlyContinue
    if ($still) {
        Write-Host "端口 $DshPort 仍被占用，请手动关掉 dsh 窗口后重试。" -ForegroundColor Red
        exit 1
    }
}

function Start-DshWeb {
    param([string]$MagicDns)
    if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
        Write-Host "未找到 dsh，请先安装。" -ForegroundColor Red
        exit 1
    }
    $trustedArgs = @("web", "--no-open", "--trusted-host", $MagicDns)
    Write-Host ">> 启动 dsh web --trusted-host $MagicDns"
    Start-Process -FilePath "dsh" -ArgumentList $trustedArgs -WindowStyle Normal
    Start-Sleep -Seconds 3
    $up = Get-NetTCPConnection -LocalPort $DshPort -State Listen -ErrorAction SilentlyContinue
    if ($up) {
        Write-Host "dsh 已在端口 $DshPort 监听。" -ForegroundColor Green
    } else {
        Write-Host "dsh 可能仍在启动，请查看新开的控制台窗口。" -ForegroundColor Yellow
    }
}

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    Write-Host "未找到 tailscale，请先安装并登录 Tailscale for Windows。" -ForegroundColor Red
    exit 1
}

$MagicDns = Get-MagicDns
Write-Host "MagicDNS: $MagicDns"

if (-not $RestartDshOnly) {
    Write-Host ">> tailscale serve reset（切到 tailnet 内 HTTP:80，避免 HTTPS/HTTP2 弄断 WebSocket）"
    tailscale serve reset 2>$null
    tailscale serve --bg --http=80 $Backend
    if ($LASTEXITCODE -ne 0) {
        Write-Host "serve 失败，请检查 Tailscale 是否已登录。" -ForegroundColor Red
        exit 1
    }
}

Write-Host ">> 重启 dsh web（结束旧进程 → 新进程带 trusted-host）"
Stop-DshWeb
Start-DshWeb -MagicDns $MagicDns

Write-Host ""
Write-Host "Mac 上双击：连接家中dsh.command" -ForegroundColor Green
Write-Host "URL: http://$MagicDns/  （tailnet 内 HTTP，勿用 https）"

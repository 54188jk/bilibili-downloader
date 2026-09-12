# 影视 CLI — 不需要打开前端界面
# 用法：
#   .\scripts\movie-cli.ps1 search "庆余年"
#   .\scripts\movie-cli.ps1 detail 120975 "https://cj.ffzyapi.com/api.php/provide/vod"
#   .\scripts\movie-cli.ps1 status
#   .\scripts\movie-cli.ps1 sources

param(
  [Parameter(Position=0)]
  [string]$Command = "help",
  [Parameter(Position=1)]
  [string]$Arg1 = "",
  [Parameter(Position=2)]
  [string]$Arg2 = ""
)

$API = "http://127.0.0.1:3928"

function Show-Help {
  Write-Host "=== BiliGrab 影视 CLI ===" -ForegroundColor Cyan
  Write-Host "  search <关键词>       搜索影视"
  Write-Host "  detail <id> <源url>   获取详情"
  Write-Host "  status                API 状态"
  Write-Host "  sources               数据源列表"
  Write-Host ""
}

function Invoke-Api($path) {
  try {
    $resp = Invoke-WebRequest -Uri "$API$path" -TimeoutSec 15 -UseBasicParsing
    return ($resp.Content | ConvertFrom-Json)
  } catch {
    Write-Host "API 请求失败: $($_.Exception.Message)" -ForegroundColor Red
    return $null
  }
}

switch ($Command) {
  "search" {
    if (!$Arg1) { Write-Host "用法: .\movie-cli.ps1 search <关键词>" -ForegroundColor Yellow; break }
    Write-Host "搜索中: $Arg1 ..." -ForegroundColor Gray
    $data = Invoke-Api "/api/search?wd=$([System.Uri]::EscapeDataString($Arg1))&pg=1"
    if ($data -and $data.list) {
      Write-Host "找到 $($data.count) 条结果 (耗时 $($data.elapsed)ms)" -ForegroundColor Green
      Write-Host ""
      $i = 1
      foreach ($item in $data.list) {
        $src = ""
        if ($item._src) { $src = " | 源: $($_.src -replace 'https?://','' -replace '/.*$','')" }
        Write-Host "  [$i] $($item.vod_name) | $($item.type_name) | $($item.vod_remarks)$src"
        $i++
      }
    }
  }
  "detail" {
    if (!$Arg1 -or !$Arg2) { Write-Host "用法: .\movie-cli.ps1 detail <vod_id> <源url>" -ForegroundColor Yellow; break }
    $data = Invoke-Api "/api/detail?ids=$Arg1&src=$([System.Uri]::EscapeDataString($Arg2))"
    if ($data -and $data.data) {
      $d = $data.data
      Write-Host "=== $($d.vod_name) ===" -ForegroundColor Cyan
      Write-Host "  类型: $($d.type_name)"
      Write-Host "  年份: $($d.vod_year)"
      Write-Host "  导演: $($d.vod_director)"
      Write-Host "  主演: $($d.vod_actor)"
      Write-Host "  简介: $($d.vod_content.Substring(0, [Math]::Min(200, $d.vod_content.Length)))..."
      if ($d.vod_play_from) { Write-Host "  播放源: $($d.vod_play_from)" -ForegroundColor Yellow }
    }
  }
  "status" {
    $data = Invoke-Api "/api/status"
    if ($data) {
      Write-Host "=== API 状态 ===" -ForegroundColor Cyan
      Write-Host "  端口: $($data.port)"
      Write-Host "  运行: $([math]::Round($data.uptime/60, 1)) 分钟"
      Write-Host "  数据源: $($data.sources) 个"
      Write-Host "  缓存: $($data.cacheEntries) 条"
    }
  }
  "sources" {
    $data = Invoke-Api "/api/sources"
    if ($data -and $data.sources) {
      Write-Host "=== 数据源列表 ===" -ForegroundColor Cyan
      $i = 1
      foreach ($s in $data.sources) {
        Write-Host "  [$i] $s"
        $i++
      }
    }
  }
  default { Show-Help }
}

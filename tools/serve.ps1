# Tiny static file server for the portal build folder (localhost only).
#
# Serves the folder this script lives beside on http://localhost:8787.
# The front page ("/") is the fast pre-compiled portal.html when one exists
# and is at least as new as preview.html; otherwise preview.html itself, so
# an edit that hasn't been re-compiled yet still shows current rather than
# stale. Compile with:  node tools\build-fast-preview.mjs
$root = Split-Path -Parent $PSScriptRoot
$port = 8787

$mime = @{
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
  '.json'='application/json'; '.js'='text/javascript'; '.css'='text/css'
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'
  '.webp'='image/webp'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
  '.pdf'='application/pdf'; '.txt'='text/plain; charset=utf-8'
  '.ts'='text/plain; charset=utf-8'; '.mjs'='text/javascript'
  '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  '.docx'='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Output "Serving $root on http://localhost:$port/"

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') {
      $fast = Join-Path $root 'portal.html'
      $slow = Join-Path $root 'preview.html'
      if ((Test-Path $fast) -and (Test-Path $slow) -and
          ((Get-Item $fast).LastWriteTime -ge (Get-Item $slow).LastWriteTime)) {
        $rel = 'portal.html'
      } else {
        $rel = 'preview.html'
      }
    }
    $path = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root)) {
      $res.StatusCode = 403; $res.Close(); continue
    }
    if (Test-Path $path -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      $type = $mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $res.ContentType = $type
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('Not found: ' + $rel)
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
    $res.Close()
  } catch {
    Write-Output ("ERR: " + $_.Exception.Message)
  }
}

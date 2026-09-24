# Tiny static file server for the portal build folder (localhost only).
#
# Serves the folder this script lives beside on http://localhost:8787.
# The front page ("/") is the fast pre-compiled portal.html when one exists
# and is at least as new as preview.html; otherwise preview.html itself, so
# an edit that hasn't been re-compiled yet still shows current rather than
# stale. Compile by hand with:  node tools\build-fast-preview.mjs
#
# The page also keeps itself current: a small script injected into "/" asks
# /__version every couple of seconds, and when preview.html has changed the
# server re-compiles portal.html and the page reloads itself — so an edit
# lands in the open browser window on its own, the way a dev server does.
# Sign-in survives the reload (the portal keeps it in sessionStorage).
$root = Split-Path -Parent $PSScriptRoot
$port = 8787

# node, for re-compiling portal.html when preview.html changes.
$node = 'node'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $node = 'C:\Program Files\nodejs\node.exe'
}
$builder = Join-Path $PSScriptRoot 'build-fast-preview.mjs'

# The token a page carries and polls for: a hash of preview.html's content.
# A hash rather than the file's time, because the folder lives in OneDrive and
# OneDrive touches timestamps without changing a byte — the page should only
# reload when the content actually moved.
function Get-VersionToken {
  $slow = Join-Path $root 'preview.html'
  if (Test-Path $slow) {
    try { return (Get-FileHash -Algorithm MD5 -Path $slow).Hash } catch { return '0' }
  }
  return '0'
}

# Whether portal.html was compiled from the preview.html on disk right now.
# Decided by the build stamp the compiler writes — the hash of the bytes it
# actually read — never by file times: an edit can land mid-build and leave a
# stale portal.html with a newer time than its source.
function Test-FastPageCurrent {
  $fast = Join-Path $root 'portal.html'
  $stamp = Join-Path $root 'portal.html.src.md5'
  if (-not ((Test-Path $fast) -and (Test-Path $stamp))) { return $false }
  try { return ((Get-Content $stamp -Raw).Trim() -eq (Get-VersionToken)) } catch { return $false }
}

# Bring portal.html up to preview.html. Called from the poll, so the rebuild
# has happened by the time the page reloads and the reload is the fast page.
# A failed build is not fatal: "/" then falls back to preview.html, which is
# always current, only slower to open.
function Update-FastPage {
  if (-not (Test-Path (Join-Path $root 'preview.html'))) { return }
  if (Test-FastPageCurrent) { return }
  try { & $node $builder 2>&1 | Out-Null } catch {}
}

$mime = @{
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
  '.json'='application/json'; '.js'='text/javascript'; '.css'='text/css'
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'
  '.webp'='image/webp'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
  '.pdf'='application/pdf'; '.txt'='text/plain; charset=utf-8'
  '.ts'='text/plain; charset=utf-8'; '.mjs'='text/javascript'
  '.woff2'='font/woff2'; '.webmanifest'='application/manifest+json'
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

    # The poll behind the self-reloading page. Rebuilding here means that by
    # the time the page sees a new token and reloads, the fast page is ready.
    if ($rel -eq '__version') {
      Update-FastPage
      $tok = [System.Text.Encoding]::UTF8.GetBytes((Get-VersionToken))
      $res.ContentType = 'text/plain'
      $res.Headers.Add('Cache-Control', 'no-store')
      $res.ContentLength64 = $tok.Length
      $res.OutputStream.Write($tok, 0, $tok.Length)
      $res.Close(); continue
    }

    # The live site serves React, React DOM and the fonts at /vendor/; the
    # copies are source/vendor/, so the live path answers from there too.
    if ($rel -like 'vendor/*') { $rel = 'source/' + $rel }

    $isFront = ($rel -eq '')
    if ($isFront) {
      if (Test-FastPageCurrent) {
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

      # The front page carries the reload poller, with the version it was
      # served at baked in so the very first poll already compares right.
      if ($isFront) {
        $poll = @"

<script>
(() => {
  const base = '$(Get-VersionToken)';
  const tick = async () => {
    try {
      const v = await (await fetch('/__version', { cache: 'no-store' })).text();
      if (v && v !== base) location.reload();
    } catch (e) {}
  };
  setInterval(tick, 2000);
})();
</script>
"@
        $bytes = $bytes + [System.Text.Encoding]::UTF8.GetBytes($poll)
      }

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

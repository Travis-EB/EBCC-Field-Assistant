# EBCC Field Assistant — LOCAL UI PREVIEW server (dev only).
#
# This is a dependency-free static file server used ONLY to preview the frontend
# on machines without Node.js / the SWA CLI. It MOCKS the /api/* and /.auth/*
# endpoints as a signed-in ADMIN so the full UI (including Manage Users) can be
# viewed. It is NOT the real backend and must never be used in production.
#
# For real end-to-end testing use the Azure Static Web Apps CLI:  swa start
#
# Usage:  powershell -ExecutionPolicy Bypass -File dev\static-server.ps1 -Port 8791
param(
  [int]$Port = 8791,
  [string]$Root = "$(Split-Path -Parent $PSScriptRoot)\public"
)
$ErrorActionPreference = 'Stop'
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8';
  '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8';
  '.webmanifest'='application/manifest+json; charset=utf-8';
  '.png'='image/png'; '.woff2'='font/woff2'; '.svg'='image/svg+xml';
  '.ico'='image/x-icon'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
$ticketCounter = 21099
Write-Host "EBCC dev preview on http://localhost:$Port/  root=$Root  (MOCK admin auth)"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    # Dev-only: accept rendered page images (data URLs) and save to scratchpad
    if ($path -eq '/_save' -and $req.HttpMethod -eq 'POST') {
      try {
        $name = $req.QueryString['name'] -replace '[^a-zA-Z0-9._-]', ''
        if (-not $name) { $name = 'page.png' }
        $reader = New-Object IO.StreamReader($req.InputStream)
        $dataUrl = $reader.ReadToEnd(); $reader.Close()
        $b64 = $dataUrl.Substring($dataUrl.IndexOf(',') + 1)
        $outDir = Join-Path $env:TEMP 'ebcc-pdf-pages'
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $outDir $name), [Convert]::FromBase64String($b64))
        $res.StatusCode = 200
        $ok = [Text.Encoding]::UTF8.GetBytes('saved')
        $res.OutputStream.Write($ok,0,$ok.Length); $res.Close(); continue
      } catch { try { $res.StatusCode = 500; $res.Close() } catch {}; continue }
    }
    if ($path -like '/api/*' -or $path -like '/.auth/*') {
      $json = '{"ok":true}'
      if ($path -eq '/api/ticket-number') {
        $ticketCounter++
        $json = '{"number":' + $ticketCounter + '}'
      } elseif ($path -eq '/api/me') {
        $json = '{"authenticated":true,"userId":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy","role":"admin","isAdmin":true}'
      } elseif ($path -like '/api/records*' -and $req.Url.Query -like '*userId=*') {
        $json = '{"ownerId":"u2","records":{"cpy_state":{"updatedAt":"2026-07-14T09:30:00Z","data":{"hoursPerDay":8,"ydPerLoad":28,"yardsToMove":40000,"procShifts":2,"procShiftHours":10,"job":[{"name":"Scraper: CAT657","quantity":2,"rate":466,"producer":true,"roundTime":3},{"name":"Material Processor: Wirtgen SM220","quantity":1,"rate":880,"processor":true,"ydPerHr":250},{"name":"Labor: Foreman","quantity":1,"rate":105}]}},"flat_state":{"updatedAt":"2026-07-14T10:00:00Z","data":{"flatHoursPerDay":8,"flatSqftPerDay":25000,"flatJobSqft":100000,"flatJob":[{"name":"Compactor: CAT824","quantity":1,"rate":210}]}},"ewt_records":{"updatedAt":"2026-07-20T10:00:00Z","data":[{"ts":"2026-07-20T09:00:00Z","ticketNo":"21100","date":"2026-07-19","customer":"Test Co","description":"Broke rock at north pad","signed":true,"pdf":"data:application/pdf;base64,JVBERi0xLjQKJdP0zOEKMSAwIG9iago8PD4+CmVuZG9iagp0cmFpbGVyCjw8Pj4KJSVFT0Y="}]},"lime_state":{"updatedAt":"2026-07-14T10:05:00Z","data":{"lime-rate":"33","lime-area":"50000"}},"flexbase_state":{"updatedAt":"2026-07-14T10:06:00Z","data":{"fb-area":"50000","fb-depth":"6","fb-truck-tons":"22"}}}}'
      } elseif ($path -like '/api/records*') {
        $json = '{"ownerId":"dev-admin","records":{}}'
      } elseif ($path -like '/api/users*') {
        $json = '{"users":[{"id":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy","role":"admin","lastActiveAt":"2026-07-01T15:00:00Z","counts":{"trucking_tickets":12,"load_count":1,"ewt_records":3}}]}'
      }
      $res.StatusCode = 200
      $b = [Text.Encoding]::UTF8.GetBytes($json)
      $res.ContentType = 'application/json'; $res.OutputStream.Write($b,0,$b.Length); $res.Close(); continue
    }
    $file = Join-Path $Root ($path.TrimStart('/') -replace '/','\')
    if (-not (Test-Path $file -PathType Leaf)) { $file = Join-Path $Root 'index.html' }
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  } catch {
    try { $res.StatusCode = 500; $res.Close() } catch {}
  }
}

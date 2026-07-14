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
Write-Host "EBCC dev preview on http://localhost:$Port/  root=$Root  (MOCK admin auth)"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    if ($path -like '/api/*' -or $path -like '/.auth/*') {
      $json = '{"ok":true}'
      if ($path -eq '/api/me') {
        $json = '{"authenticated":true,"userId":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy","role":"admin","isAdmin":true}'
      } elseif ($path -like '/api/records*' -and $req.Url.Query -like '*userId=*') {
        $json = '{"ownerId":"u2","records":{"cpy_state":{"updatedAt":"2026-07-14T09:30:00Z","data":{"hoursPerDay":8,"ydPerLoad":28,"yardsToMove":40000,"items":[{"name":"Scraper: CAT657","quantity":2,"rate":466,"producer":true,"roundTime":3},{"name":"Labor: Foreman","quantity":1,"rate":105}]}},"flat_state":{"updatedAt":"2026-07-14T10:00:00Z","data":{"hoursPerDay":8,"sqftPerDay":25000,"jobSqft":100000,"items":[{"name":"Compactor: CAT824","quantity":1,"rate":210}]}},"lime_state":{"updatedAt":"2026-07-14T10:05:00Z","data":{"lime-rate":"33","lime-area":"50000"}},"flexbase_state":{"updatedAt":"2026-07-14T10:06:00Z","data":{"fb-area":"50000","fb-depth":"6","fb-truck-tons":"22"}}}}'
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

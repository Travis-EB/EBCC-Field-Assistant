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
      } elseif ($path -eq '/api/send-ewt') {
        $json = '{"ok":true,"sent":true}'
      } elseif ($path -eq '/api/send-production') {
        $json = '{"ok":true,"sent":true,"recipients":["travis@earthbasics.net"],"archived":true}'
      } elseif ($path -eq '/api/send-jha') {
        $json = '{"ok":true,"sent":true,"recipients":["travis@earthbasics.net"],"archived":true,"pdfBlob":"dev-admin/jha-26-292-03-2026-08-26-999.pdf"}'
      } elseif ($path -eq '/api/send-load-count') {
        $json = '{"ok":true,"sent":true,"recipients":["office@earthbasics.net"],"archived":true}'
      } elseif ($path -eq '/api/ewt-pdf' -and $req.HttpMethod -eq 'POST') {
        $json = '{"ok":true,"path":"dev-admin/mock-' + [DateTime]::Now.Ticks + '.pdf"}'
      } elseif ($path -eq '/api/projects' -and $req.HttpMethod -eq 'POST') {
        $json = '{"ok":true,"project":{"code":"NEW","name":"NEW"}}'
      } elseif ($path -eq '/api/projects') {
        $json = '{"projects":[{"code":"26-292-03","name":"PROSPER RETAIL","fileCount":2,"totalSize":3300000,"links":[{"name":"Procore","url":"https://app.procore.com/2024/project/home"},{"name":"Autodesk Docs","url":"https://acc.autodesk.com/docs/files/projects/abc123"}]},{"code":"26-100-03","name":"NL35 III PH 1 - SITE & BUILDING 7","fileCount":5,"totalSize":12000000},{"code":"25-079-02","name":"FOX FIELD WEST BUILDING 1","fileCount":0,"totalSize":0}]}'
      } elseif ($path -eq '/api/project-files' -and $req.HttpMethod -eq 'DELETE') {
        $json = '{"ok":true}'
      } elseif ($path -eq '/api/project-files' -and $req.HttpMethod -eq 'POST') {
        $json = '{"ok":true,"name":"uploaded.pdf"}'
      } elseif ($path -eq '/api/project-files' -and $req.Url.Query -like '*sas=1*') {
        $json = '{"ok":true,"url":"/icons/logo.png"}'
      } elseif ($path -eq '/api/project-files') {
        $json = '{"files":[{"name":"Harmonson_Logistics_Center_Building_5_Fine_Grade_Takeoff_Rev4_FINAL_2026-08-04.pdf","folder":"Plans","size":2400000,"lastModified":"2026-08-01T10:00:00Z","contentType":"application/pdf"},{"name":"Soils Report.pdf","folder":"Geotech","size":900000,"lastModified":"2026-07-20T10:00:00Z","contentType":"application/pdf"},{"name":"Dropped New.pdf","folder":"","size":120000,"lastModified":"2026-08-04T10:00:00Z","contentType":"application/pdf"}]}'
      } elseif ($path -eq '/api/me') {
        $json = '{"authenticated":true,"userId":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy","role":"admin","isAdmin":true}'
      } elseif ($path -like '/api/records*' -and $req.Url.Query -like '*userId=*') {
        $json = '{"ownerId":"u2","records":{"jha_records":{"updatedAt":"2026-08-25T16:00:00Z","data":[{"id":"jhaU2A","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-08-25","contractor":"Earth Basics","preparedBy":"Gabriel Arriaga","description":"Cut/fill north pad","hazards":{"Public Exposure":true,"Underground Utilities":true},"steps":[{"step":"Strip topsoil","hazard":"Dust, equipment traffic","control":"Water truck, spotter"}],"signoffs":[{"name":"J. Ruiz","injured":"no","sig":""},{"name":"M. Lopez","injured":"yes","sig":""}],"emailedTo":["office@earthbasics.net"],"sent":true,"sentTs":"2026-08-25T16:05:00Z","pdfBlob":"u2/jha-26-292-03-2026-08-25-1.pdf","createdAt":"2026-08-25T13:00:00Z","updatedAt":"2026-08-25T16:00:00Z"}]},"lime_posts":{"updatedAt":"2026-08-21T09:00:00Z","data":[{"ts":"2026-08-21T09:00:00Z","state":"TX","rate":33,"areaSqft":50000,"sqyd":5556,"totalLbs":183333,"totalTons":91.7,"exactTrucks":9.17,"trucksToOrder":9,"effectiveRate":32.4,"pctOfSpec":98,"projectCode":"26-292-03","projectName":"PROSPER RETAIL"}]},"flexbase_posts":{"updatedAt":"2026-08-21T09:30:00Z","data":[{"ts":"2026-08-21T09:30:00Z","state":"CA","areaSqft":50000,"depthIn":6,"truckTons":22,"cubicYards":925.9,"totalTons":1666.7,"exactTrucks":75.76,"trucksNeeded":76,"lastTruckTons":16.7,"projectCode":"26-100-03","projectName":"NL35 III PH 1 - SITE & BUILDING 7"}]},"load_count":{"updatedAt":"2026-08-20T09:00:00Z","data":{"meta":{"source":"Riverside Pit","deliveredTo":"Prosper Retail","date":"2026-08-20","checker":"J. Ruiz","contractor":"EBCC","jobNum":"26-292-03"},"trucks":[{"id":"t1","truckTypeId":"super_10","truckNo":"14","name":"Alliance Trucking","loads":[{"in":"06:10","out":"07:02"},{"in":"07:40","out":"08:31"}]},{"id":"t2","truckTypeId":"end_dump","truckNo":"22","name":"Alliance Trucking","loads":[{"in":"06:20","out":"07:15"},{"in":"08:05","out":""}]}]}},"load_count_sends":{"updatedAt":"2026-08-20T15:02:00Z","data":[{"ts":"2026-08-19T15:02:00Z","date":"2026-08-19","source":"Riverside Pit","jobNum":"26-292-03","deliveredTo":"Prosper Retail","trucks":3,"loads":9,"cy":102,"byType":[{"label":"Super 10","trucks":2,"loads":6,"cy":60},{"label":"Semi End Dump","trucks":1,"loads":3,"cy":42}],"emailedTo":["office@earthbasics.net"],"sent":true,"pdfBlob":"u2/loadcount-2026-08-19-111.pdf"},{"ts":"2026-08-20T15:02:00Z","date":"2026-08-20","source":"Riverside Pit","jobNum":"26-292-03","trucks":2,"loads":3,"cy":34,"byType":[{"label":"Super 10","trucks":1,"loads":2,"cy":20},{"label":"Semi End Dump","trucks":1,"loads":1,"cy":14}],"emailedTo":[],"sent":false,"pdfBlob":"u2/loadcount-2026-08-20-123.pdf"}]},"flat_posts":{"updatedAt":"2026-08-03T11:00:00Z","data":[{"ts":"2026-08-03T11:00:00Z","state":"CA","hoursPerDay":8,"sqftPerDay":25000,"jobSqft":100000,"equipQty":2,"items":[{"name":"Compactor: CAT824","qty":1,"costPerDay":2016},{"name":"Labor: Laborer","qty":1,"costPerDay":416}],"totalCost":2432,"costPerSqFt":0.097,"daysToComplete":4}]},"cpy_posts":{"updatedAt":"2026-08-03T09:30:00Z","data":[{"ts":"2026-08-03T09:30:00Z","state":"CA","hoursPerDay":8,"ydPerLoad":26,"yardsToMove":40000,"producerQty":3,"producers":[{"name":"Scraper: CAT657","qty":2,"roundTime":3,"yardsPerDay":3744,"type":"scraper"},{"name":"Rock Truck: CAT 730 (22.9 cy)","qty":1,"roundTime":4,"yardsPerDay":2748,"type":"rock"}],"totalCost":18000,"totalYards":6492,"dirtYards":3744,"rockYards":2748,"costPerYard":2.77,"daysToComplete":6.2}]},"cpy_state":{"updatedAt":"2026-07-14T09:30:00Z","data":{"hoursPerDay":8,"ydPerLoad":28,"yardsToMove":40000,"procShifts":2,"procShiftHours":10,"job":[{"name":"Scraper: CAT657","quantity":2,"rate":466,"producer":true,"roundTime":3},{"name":"Material Processor: Wirtgen SM220","quantity":1,"rate":880,"processor":true,"ydPerHr":250},{"name":"Labor: Foreman","quantity":1,"rate":105}]}},"flat_state":{"updatedAt":"2026-07-14T10:00:00Z","data":{"flatHoursPerDay":8,"flatSqftPerDay":25000,"flatJobSqft":100000,"flatJob":[{"name":"Compactor: CAT824","quantity":1,"rate":210}]}},"ewt_records":{"updatedAt":"2026-07-20T10:00:00Z","data":[{"ts":"2026-07-20T09:00:00Z","ticketNo":"21100","date":"2026-07-19","customer":"Test Co","description":"Broke rock at north pad","signed":true,"pdf":"data:application/pdf;base64,JVBERi0xLjQKJdP0zOEKMSAwIG9iago8PD4+CmVuZG9iagp0cmFpbGVyCjw8Pj4KJSVFT0Y="},{"ts":"2026-08-03T12:00:00Z","ticketNo":"21120","date":"2026-08-03","customer":"Blob Co","printName":"Gabriel Arriaga","description":"Blob-backed ticket","signed":true,"pdf":"","pdfBlob":"u2/21120-2026-08-03-123.pdf"},{"ts":"2026-07-25T09:00:00Z","ticketNo":"21110","date":"2026-07-24","customer":"Lost PDF Co","jobNum":"26-100-03","printName":"Gabriel Arriaga","description":"PDF was lost before reaching storage","signed":true,"pdf":"","labor":[{"desc":"Operator","trade":"OP","reg":"8","ot":"2","sb":""}],"equipment":[{"name":"Scraper: CAT657","hours":"8","sb":""}],"materials":[{"desc":"Base rock","qty":"20","unit":"tons"}]}]},"lime_state":{"updatedAt":"2026-07-14T10:05:00Z","data":{"lime-rate":"33","lime-area":"50000"}},"flexbase_state":{"updatedAt":"2026-07-14T10:06:00Z","data":{"fb-area":"50000","fb-depth":"6","fb-truck-tons":"22"}}}}'
      } elseif ($path -like '/api/records*' -and $req.HttpMethod -eq 'POST') {
        # Echo a merged drafts reply: the pushed list plus one server-only draft
        $reader = New-Object IO.StreamReader($req.InputStream); $bodyTxt = $reader.ReadToEnd(); $reader.Close()
        if ($bodyTxt -like '*"ewt_drafts"*') {
          $m = [regex]::Match($bodyTxt, '"data":(\[.*\])\s*}\s*$')
          $arr = if ($m.Success) { $m.Groups[1].Value } else { '[]' }
          $extra = '{"id":"dSERVERONLY","savedAt":"2026-08-07T09:00:00Z","ticket":{"customer":"Merged From Server","jobNum":"26-013-03","labor":[],"equipment":[],"materials":[]}}'
          $arr = if ($arr -eq '[]') { '[' + $extra + ']' } else { $arr.Substring(0, $arr.Length - 1) + ',' + $extra + ']' }
          $json = '{"ok":true,"updatedAt":"2026-08-07T10:00:00Z","data":' + $arr + '}'
        } else { $json = '{"ok":true,"updatedAt":"2026-08-07T10:00:00Z"}' }
      } elseif ($path -like '/api/records*') {
        # "Laptop" drafts already on the server for the signed-in user
        $json = '{"ownerId":"dev-admin","records":{"jha_records":{"updatedAt":"2026-08-25T17:00:00Z","data":[{"id":"jhaDEV1","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-08-25","contractor":"Earth Basics","preparedBy":"Travis Pecoy","description":"Mass ex on building pad","hazards":{"Excavating/Trenching":true},"steps":[{"step":"Excavate pad","hazard":"Open cut, traffic","control":"Slope per plan, vest + spotter"}],"signoffs":[{"name":"Server Carry One","injured":"no","sig":""},{"name":"Server Carry Two","injured":"","sig":""}],"createdAt":"2026-08-25T06:00:00Z","updatedAt":"2026-08-25T17:00:00Z"}]},"ewt_drafts":{"updatedAt":"2026-08-07T08:00:00Z","data":[{"id":"dLAPTOP1","savedAt":"2026-08-07T08:00:00Z","ticket":{"ticketNo":"21130","customer":"Laptop Draft One","jobNum":"26-292-03","description":"Written on the laptop","labor":[{"desc":"Operator","trade":"OP","reg":"8","ot":"","sb":""}],"equipment":[],"materials":[]}},{"id":"dLAPTOP2","savedAt":"2026-08-07T08:30:00Z","ticket":{"customer":"Laptop Draft Two","labor":[],"equipment":[],"materials":[]}},{"id":"dDELETEDELSEWHERE","tombstone":true,"deletedAt":"2026-08-07T08:45:00Z"}]}}}'
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

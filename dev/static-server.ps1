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
# Mock per-job board (Active Jobs hub). Mutated in memory by POST /api/project-board.
$d0 = (Get-Date).ToString('yyyy-MM-dd'); $dm3 = (Get-Date).AddDays(-3).ToString('yyyy-MM-dd'); $dp4 = (Get-Date).AddDays(4).ToString('yyyy-MM-dd'); $dm1 = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
$boardJson = '{"id":"board:26-292-03","type":"project_board","code":"26-292-03","tasks":[' +
  '{"id":"t1","text":"Plans sent to the model guys","phase":"1st move","assignee":null,"due":"","done":true,"doneBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"doneAt":"2026-10-02T15:00:00Z","createdBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"createdAt":"2026-10-01T15:00:00Z","updatedAt":"2026-10-02T15:00:00Z"},' +
  '{"id":"t2","text":"Job book created","phase":"1st move","assignee":null,"due":"","done":true,"doneBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"doneAt":"2026-10-02T15:00:00Z","createdBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"createdAt":"2026-10-01T15:00:00Z","updatedAt":"2026-10-02T15:00:00Z"},' +
  '{"id":"t3","text":"Walk the site with the superintendent","phase":"1st move","assignee":{"email":"maria.lopez@earthbasics.net","name":"Maria Lopez"},"due":"' + $dm3 + '","done":false,"doneBy":null,"doneAt":"","createdBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"createdAt":"2026-10-01T15:00:00Z","updatedAt":"2026-10-01T15:00:00Z"},' +
  '{"id":"t4","text":"Lime scheduled (note the date)","phase":"1st move","assignee":{"email":"ben.carter@earthbasics.net","name":"Ben Carter"},"due":"' + $dp4 + '","done":false,"doneBy":null,"doneAt":"","createdBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"createdAt":"2026-10-01T15:00:00Z","updatedAt":"2026-10-01T15:00:00Z"},' +
  '{"id":"t5","text":"Count all loads, but only signed tickets for Durango","phase":"General","assignee":null,"due":"","done":false,"doneBy":null,"doneAt":"","createdBy":{"email":"ncowles@earthbasics.net","name":"Nick Cowles"},"createdAt":"2026-10-05T15:00:00Z","updatedAt":"2026-10-05T15:00:00Z"},' +
  '{"id":"t6","text":"Walk with the concrete guy before demob","phase":"2nd move","assignee":null,"due":"","done":true,"doneBy":{"email":"maria.lopez@earthbasics.net","name":"Maria Lopez"},"doneAt":"2026-10-12T15:00:00Z","createdBy":{"email":"travis@earthbasics.net","name":"Travis Pecoy"},"createdAt":"2026-10-01T15:00:00Z","updatedAt":"2026-10-12T15:00:00Z"}' +
  '],"notes":"- Trucking is Durango on this one - count all loads but only signed tickets get paid\n- Super is Mike (GC) - on site after 7am\n- Haul road off the north entrance only","notesBy":"Nick Cowles","notesAt":"' + $dm1 + 'T14:00:00Z","minutes":[' +
  '{"id":"m1","kind":"minutes","date":"' + $dm3 + '","title":"GC weekly meeting","body":"EB responsibilities:\n- Finish pad grading by Friday\n- Lime on the north lot next week (Brian to confirm date)\n- Super wants the haul road watered twice a day","createdBy":{"email":"brian@earthbasics.net","name":"Brian Colin"},"createdAt":"' + $dm3 + 'T20:00:00Z","updatedAt":"' + $dm3 + 'T20:00:00Z"},' +
  '{"id":"m2","kind":"lookahead","date":"' + $dm1 + '","title":"3-week look-ahead","body":"Wk 1: pad + lime\nWk 2: base rock, curbs start\nWk 3: sidewalks, topsoil","createdBy":{"email":"jasonb@earthbasics.net","name":"Jason Bowers"},"createdAt":"' + $dm1 + 'T20:00:00Z","updatedAt":"' + $dm1 + 'T20:00:00Z"},' +
  '{"id":"m3","kind":"minutes","date":"2026-10-01","title":"Kickoff","body":"Scope confirmed. Count all loads; only signed Durango tickets get paid.","createdBy":{"email":"ncowles@earthbasics.net","name":"Nick Cowles"},"createdAt":"2026-10-01T20:00:00Z","updatedAt":"2026-10-01T20:00:00Z"}' +
  '],"contacts":[' +
  '{"id":"c1","role":"GC Superintendent","name":"Mike Dawson","company":"Harmonson Builders","phone":"(214) 555-0142","email":"mike@harmonson.com","note":"On site after 7am"},' +
  '{"id":"c2","role":"Trucking","name":"Dispatch","company":"Durango Trucking","phone":"972-555-0188","email":"dispatch@durangotrucking.com","note":"Signed tickets only"},' +
  '{"id":"c3","role":"Lime","name":"Carla Reyes","company":"Texas Lime Co","phone":"+1 817 555 0199","email":"","note":""},' +
  '{"id":"c4","role":"Saw cut","name":"","company":"Precision Cutting","phone":"469.555.0120","email":"","note":""}' +
  '],"summary":{"open":3,"done":3,"updatedAt":"' + $dm1 + 'T14:00:00Z"},"updatedAt":"' + $dm1 + 'T14:00:00Z"}'
$script:board = $boardJson | ConvertFrom-Json
function New-BoardId { return ([guid]::NewGuid().ToString('N').Substring(0, 10)) }
function Board-Recompute { $open = @($script:board.tasks | Where-Object { -not $_.done }).Count; $script:board.summary.open = $open; $script:board.summary.done = @($script:board.tasks).Count - $open; $script:board.summary.updatedAt = (Get-Date).ToUniversalTime().ToString('o'); $script:board.updatedAt = $script:board.summary.updatedAt }
function Board-Json { return (ConvertTo-Json -InputObject $script:board -Depth 10 -Compress) }
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
      } elseif ($path -eq '/api/send-toolbox') {
        $json = '{"ok":true,"sent":true,"recipients":["travis@earthbasics.net"],"archived":true,"pdfBlob":"dev-admin/toolbox-26-292-03-2026-09-16-1.pdf"}'
      } elseif ($path -eq '/api/send-incident') {
        $json = '{"ok":true,"sent":true,"recipients":["chris@earthbasics.net","amber@earthbasics.net","travis@earthbasics.net"],"archived":true,"pdfBlob":"dev-admin/incident-26-292-03-2026-09-15-1.pdf","photoBlobs":[{"path":"dev-admin/incident-26-292-03-2026-09-15-1-1.jpg"},{"path":"dev-admin/incident-26-292-03-2026-09-15-1-2.jpg"}],"photosArchived":2,"photosAttached":2}'
      } elseif ($path -eq '/api/send-trucking') {
        $json = '{"ok":true,"sent":true,"recipients":["travis@earthbasics.net"],"archived":true,"photosArchived":2,"photosAttached":2}'
      } elseif ($path -eq '/api/send-load-count') {
        $json = '{"ok":true,"sent":true,"recipients":["office@earthbasics.net"],"archived":true}'
      } elseif ($path -eq '/api/ewt-pdf' -and $req.HttpMethod -eq 'POST') {
        $json = '{"ok":true,"path":"dev-admin/mock-' + [DateTime]::Now.Ticks + '.pdf"}'
      } elseif ($path -eq '/api/project-records') {
        if ($req.Url.Query -like '*code=26-292-03*') {
          $json = '{"jha":[' +
            '{"id":"j1","owner":"u2","ownerName":"Maria Lopez","date":"' + $dm1 + '","sent":true,"sentTs":"' + $dm1 + 'T13:00:00Z","emailedTo":["travis@earthbasics.net"],"pdfUrl":"/icons/logo.png","preparedBy":"Maria Lopez","contractor":"Earth Basics","description":"Fine grade pad, lime prep","hazards":["Heavy equipment","Dust"],"steps":3,"total":6,"signedCount":6,"injuredCount":0},' +
            '{"id":"j2","owner":"u2","ownerName":"Maria Lopez","date":"' + $dm3 + '","sent":false,"sentTs":"' + $dm3 + 'T13:00:00Z","emailedTo":[],"pdfUrl":null,"preparedBy":"Maria Lopez","contractor":"Earth Basics","description":"Haul road, water truck","hazards":["Traffic"],"steps":2,"total":5,"signedCount":4,"injuredCount":1}' +
            '],"talks":[{"id":"tb1","owner":"u2","ownerName":"Maria Lopez","date":"' + $dm3 + '","sent":true,"sentTs":"' + $dm3 + 'T12:00:00Z","emailedTo":["travis@earthbasics.net"],"pdfUrl":"/icons/logo.png","leader":"Maria Lopez","topics":["Heat illness","PPE"],"comments":"Hydrate","attendees":7,"signedCount":7}],' +
            '"incidents":[{"id":"ir1","owner":"u3","ownerName":"Ben Carter","date":"2026-10-12","sent":true,"sentTs":"2026-10-12T22:00:00Z","emailedTo":["travis@earthbasics.net"],"pdfUrl":"/icons/logo.png","time":"14:30","type":"Near Miss","reporter":"Ben Carter","involved":"Jose R.","location":"North lot","desc":"Scraper backed toward the water truck","injury":"","action":"Spotter assigned","witnesses":"","photoCount":2,"photoUrls":["/icons/logo.png","/icons/logo.png"],"thumb":""}],' +
            '"generatedAt":"' + $d0 + 'T00:00:00Z"}'
        } else { $json = '{"jha":[],"talks":[],"incidents":[],"generatedAt":"' + $d0 + 'T00:00:00Z"}' }
      } elseif ($path -eq '/api/schedule-assist') {
        $d1 = (Get-Date).AddDays(3).ToString('yyyy-MM-dd'); $d2 = (Get-Date).AddDays(23).ToString('yyyy-MM-dd')
        $json = '{"ok":true,"project":{"code":"26-292-03","name":"PROSPER RETAIL"},"summary":"Two CAT657 scrapers, a D6 dozer and a water truck go to Prosper Retail for three weeks starting ' + $d1 + ', with Gabriel Arriaga on the D6.","questions":["Who runs the scrapers?"],"entries":[{"kind":"machine","name":"Scraper: CAT657","qty":2,"start":"' + $d1 + '","end":"' + $d2 + '","note":"","linkName":""},{"kind":"machine","name":"Dozer: CAT D6","qty":1,"start":"' + $d1 + '","end":"' + $d2 + '","note":"","linkName":""},{"kind":"machine","name":"Water Truck","qty":1,"start":"' + $d1 + '","end":"' + $d2 + '","note":"","linkName":""},{"kind":"person","name":"Gabriel Arriaga","qty":1,"start":"' + $d1 + '","end":"' + $d2 + '","note":"","linkName":"Dozer: CAT D6"}]}'
      } elseif ($path -eq '/api/project-board' -and $req.HttpMethod -eq 'GET') {
        if ($req.Url.Query -like '*code=26-292-03*') { $json = '{"board":' + (Board-Json) + '}' }
        else { $code = ($req.QueryString['code']); $json = '{"board":{"id":"board:' + $code + '","type":"project_board","code":"' + $code + '","tasks":[],"notes":"","notesBy":"","notesAt":"","minutes":[],"contacts":[],"summary":{"open":0,"done":0,"updatedAt":""},"updatedAt":""}}' }
      } elseif ($path -eq '/api/project-board' -and $req.HttpMethod -eq 'POST') {
        $rb = New-Object IO.StreamReader($req.InputStream); $bb = $rb.ReadToEnd(); $rb.Close()
        $b = $bb | ConvertFrom-Json
        $now = (Get-Date).ToUniversalTime().ToString('o'); $me = [pscustomobject]@{ email = 'travis@earthbasics.net'; name = 'Travis Pecoy' }
        $added = $null
        switch ($b.mode) {
          'upsertTask' {
            $t = $b.task; $cur = $null; if ($t.id) { $cur = $script:board.tasks | Where-Object { $_.id -eq $t.id } }
            if ($cur) { $cur.text = $t.text; $cur.phase = $t.phase; $cur.assignee = $t.assignee; $cur.due = $t.due; $cur.updatedAt = $now }
            else { $script:board.tasks = @($script:board.tasks) + [pscustomobject]@{ id = (New-BoardId); text = $t.text; phase = $t.phase; assignee = $t.assignee; due = $t.due; done = $false; doneBy = $null; doneAt = ''; createdBy = $me; createdAt = $now; updatedAt = $now } }
          }
          'addTemplate' {
            $tpl = @{ '1st move' = @('Plans sent to the model guys','Job book created','Walk the site with the superintendent','Bench the building','Finished floor on the pad confirmed with the PM','Lime scheduled (note the date)','Erosion control in place'); '2nd move' = @('Walk with the concrete guy before demob','Landscape plans received','Walk with the landscaper before mobilizing','Plan changes checked','Rock / base scheduled'); '3rd move' = @('Backfill curbs','Grade sidewalks','Free-spread topsoil','Final walk with the superintendent','Machines called off / equipment released') }
            $added = 0
            foreach ($txt in $tpl[$b.phase]) {
              $dup = $script:board.tasks | Where-Object { $_.phase -eq $b.phase -and $_.text.ToLower() -eq $txt.ToLower() }
              if (-not $dup) { $script:board.tasks = @($script:board.tasks) + [pscustomobject]@{ id = (New-BoardId); text = $txt; phase = $b.phase; assignee = $null; due = ''; done = $false; doneBy = $null; doneAt = ''; createdBy = $me; createdAt = $now; updatedAt = $now }; $added++ }
            }
          }
          'deleteTask' { $script:board.tasks = @($script:board.tasks | Where-Object { $_.id -ne $b.id }) }
          'toggleTask' { $t = $script:board.tasks | Where-Object { $_.id -eq $b.id }; if ($t) { $t.done = [bool]$b.done; if ($b.done) { $t.doneBy = $me; $t.doneAt = $now } else { $t.doneBy = $null; $t.doneAt = '' }; $t.updatedAt = $now } }
          'setNotes' { $script:board.notes = [string]$b.notes; $script:board.notesBy = $me.name; $script:board.notesAt = $now }
          'upsertMinutes' {
            $e = $b.entry; $cur = $null; if ($e.id) { $cur = $script:board.minutes | Where-Object { $_.id -eq $e.id } }
            if ($cur) { $cur.kind = $e.kind; $cur.date = $e.date; $cur.title = $e.title; $cur.body = $e.body; $cur.updatedAt = $now }
            else { $script:board.minutes = @($script:board.minutes) + [pscustomobject]@{ id = (New-BoardId); kind = $e.kind; date = $e.date; title = $e.title; body = $e.body; createdBy = $me; createdAt = $now; updatedAt = $now } }
          }
          'deleteMinutes' { $script:board.minutes = @($script:board.minutes | Where-Object { $_.id -ne $b.id }) }
          'setContacts' { $script:board.contacts = @($b.contacts) }
        }
        Board-Recompute
        $extra = ''; if ($added -ne $null) { $extra = ',"added":' + $added }
        $json = '{"ok":true,"board":' + (Board-Json) + $extra + '}'
      } elseif ($path -eq '/api/projects' -and $req.HttpMethod -eq 'DELETE') {
        $json = '{"ok":true}'
      } elseif ($path -eq '/api/projects' -and $req.HttpMethod -eq 'POST') {
        $reader2 = New-Object IO.StreamReader($req.InputStream); $pbody = $reader2.ReadToEnd(); $reader2.Close()
        if ($pbody -like '*setFuel*') { $json = '{"ok":true,"fuelRate":4.44}' }
        elseif ($pbody -like '*setState*') { $json = '{"ok":true,"state":"TX"}' }
        elseif ($pbody -like '*setDates*') { $json = '{"ok":true,"start":"2026-10-01","finish":"2026-10-30"}' }
        elseif ($pbody -like '*setForeman*') { $json = '{"ok":true,"foreman":{"email":"maria.lopez@earthbasics.net","name":"Maria Lopez"}}' }
        elseif ($pbody -like '*setActive*') { $json = '{"ok":true,"active":true}' }
        elseif ($pbody -like '*setSchedule*') { $json = '{"ok":true}' }
        else { $json = '{"ok":true,"project":{"code":"NEW","name":"NEW"}}' }
      } elseif ($path -eq '/api/projects') {
        $soon = (Get-Date).AddDays(5).ToString('yyyy-MM-dd'); $late = (Get-Date).AddDays(-3).ToString('yyyy-MM-dd')
        $json = '{"projects":[{"code":"26-292-03","name":"PROSPER RETAIL","start":"2026-10-01","finish":"' + $soon + '","board":{"open":3,"done":3,"updatedAt":"' + $dm1 + 'T14:00:00Z"},"createdAt":"2026-06-01T10:00:00Z","lastFileAt":"2026-08-04T10:00:00Z","fuelRate":4.74,"state":"TX","active":true,"foreman":{"email":"maria.lopez@earthbasics.net","name":"Maria Lopez"},"schedule":[{"id":"a1","kind":"machine","name":"Scraper: CAT651","qty":4,"start":"2026-10-10","end":"2026-10-25","note":""},{"id":"a2","kind":"machine","name":"Dozer: CAT D6","start":"2026-10-14","end":"","note":"unit 212"},{"id":"a3","kind":"person","name":"Maria Lopez","start":"2026-10-10","end":"2026-10-25","note":"Foreman","linkId":"a1"},{"id":"a4","kind":"person","name":"Ben Carter","start":"2026-10-20","end":"2026-10-22","note":""}],"fileCount":2,"totalSize":3300000,"links":[{"name":"Procore","url":"https://app.procore.com/2024/project/home"},{"name":"Autodesk Docs","url":"https://acc.autodesk.com/docs/files/projects/abc123"}]},{"code":"26-100-03","name":"NL35 III PH 1 - SITE & BUILDING 7","start":"2026-09-01","finish":"' + $late + '","createdAt":"2026-05-01T10:00:00Z","lastFileAt":"2026-09-20T10:00:00Z","state":"CA","active":true,"fileCount":5,"totalSize":12000000},{"code":"25-079-02","name":"FOX FIELD WEST BUILDING 1","createdAt":"2026-09-28T10:00:00Z","fileCount":0,"totalSize":0}]}'
      } elseif ($path -eq '/api/project-files' -and $req.HttpMethod -eq 'DELETE') {
        $json = '{"ok":true}'
      } elseif ($path -eq '/api/project-files' -and $req.HttpMethod -eq 'POST') {
        $json = '{"ok":true,"name":"uploaded.pdf"}'
      } elseif ($path -eq '/api/project-files' -and $req.Url.Query -like '*sas=list*') {
        $json = '{"files":[{"name":"' + $d0 + '-1760000000000-1.jpg","folder":"Site Photos","size":180000,"lastModified":"' + $d0 + 'T14:00:00Z","contentType":"image/jpeg","url":"/icons/logo.png"},{"name":"' + $d0 + '-1760000000000-2.jpg","folder":"Site Photos","size":170000,"lastModified":"' + $d0 + 'T14:00:01Z","contentType":"image/jpeg","url":"/icons/logo.png"},{"name":"' + $dm3 + '-1759000000000-1.jpg","folder":"Site Photos","size":160000,"lastModified":"' + $dm3 + 'T15:00:00Z","contentType":"image/jpeg","url":"/icons/logo.png"}]}'
      } elseif ($path -eq '/api/project-files' -and $req.Url.Query -like '*sas=1*') {
        $json = '{"ok":true,"url":"/icons/logo.png"}'
      } elseif ($path -eq '/api/project-files') {
        $json = '{"files":[{"name":"Harmonson_Logistics_Center_Building_5_Fine_Grade_Takeoff_Rev4_FINAL_2026-08-04.pdf","folder":"Plans","size":2400000,"lastModified":"2026-08-01T10:00:00Z","contentType":"application/pdf"},{"name":"Soils Report.pdf","folder":"Geotech","size":900000,"lastModified":"2026-07-20T10:00:00Z","contentType":"application/pdf"},{"name":"Dropped New.pdf","folder":"","size":120000,"lastModified":"2026-08-04T10:00:00Z","contentType":"application/pdf"},{"name":"GC meeting 10-19.pdf","folder":"Meeting Minutes","size":80000,"lastModified":"2026-10-19T10:00:00Z","contentType":"application/pdf"},{"name":"2026-10-20-1-1.jpg","folder":"Site Photos","size":180000,"lastModified":"2026-10-20T10:00:00Z","contentType":"image/jpeg"}]}'
      } elseif ($path -eq '/api/me') {
        $json = '{"authenticated":true,"userId":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy","role":"admin","isAdmin":true}'
      } elseif ($path -like '/api/records*' -and $req.Url.Query -like '*userId=*') {
        $json = '{"ownerId":"u2","records":{"toolbox_records":{"updatedAt":"2026-09-15T07:30:00Z","data":[{"id":"tbU2A","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-09-15","leader":"Gabriel Arriaga","medical":"Baylor Scott & White - Frisco, 5601 Warren Pkwy","topics":{"Be aware of surroundings.":true,"Lift with legs, not your back.":true},"other":"","comments":"Crew asked for more water on the pad.","signoffs":[{"name":"J. Ruiz","sig":"","ts":"2026-09-15T07:10:00Z"},{"name":"M. Lopez","sig":"","ts":"2026-09-15T07:11:00Z"}],"emailedTo":["amber@earthbasics.net"],"sent":true,"sentTs":"2026-09-15T07:30:00Z","pdfBlob":"u2/toolbox-26-292-03-2026-09-15-1.pdf","submittedAt":"2026-09-15T07:29:00Z","createdAt":"2026-09-15T07:00:00Z","updatedAt":"2026-09-15T07:30:00Z"}]},"trucking_sends":{"updatedAt":"2026-09-14T16:10:00Z","data":[{"ts":"2026-09-14T16:10:00Z","date":"2026-09-14","subject":"EBCC Trucking Tickets 2026-09-14","ticketCount":2,"tons":41.5,"tickets":[{"id":"t1","pitTicketNo":"88213","truckNum":"14","commodity":"Flex Base","commodityType":"flex_base","tons":"21.5","yards":"","truckingCo":"Alliance Trucking","jobNum":"26-292-03","date":"2026-09-14","hasPhoto":true},{"id":"t2","pitTicketNo":"88219","truckNum":"22","commodity":"Dirt","commodityType":"dirt","tons":"20","yards":"14","truckingCo":"Alliance Trucking","jobNum":"26-292-03","date":"2026-09-14","hasPhoto":false}],"emailedTo":["office@earthbasics.net"],"sent":true,"pdfBlob":"u2/trucking-2026-09-14-1.pdf","photoBlobs":[{"ticketId":"t1","pitTicketNo":"88213","path":"u2/trucking-2026-09-14-1-1.jpg"}],"photosAttached":1}]},"incident_reports":{"updatedAt":"2026-09-12T10:00:00Z","data":[{"id":"irU2A","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-09-12","time":"09:15","reporter":"Gabriel Arriaga","type":"Injury","involved":"R. Benitez","location":"north pad","desc":"Slipped on wet subgrade stepping off the roller.","injury":"Twisted ankle, first aid on site","action":"Iced, sent for eval","witnesses":"","createdAt":"2026-09-12T09:30:00Z","updatedAt":"2026-09-12T10:00:00Z"}]},"jha_records":{"updatedAt":"2026-08-25T16:00:00Z","data":[{"id":"jhaU2A","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-08-25","contractor":"Earth Basics","preparedBy":"Gabriel Arriaga","description":"Cut/fill north pad","hazards":{"Public Exposure":true,"Underground Utilities":true},"steps":[{"step":"Strip topsoil","hazard":"Dust, equipment traffic","control":"Water truck, spotter"}],"signoffs":[{"name":"J. Ruiz","injured":"no","sig":""},{"name":"M. Lopez","injured":"yes","sig":""}],"emailedTo":["office@earthbasics.net"],"sent":true,"sentTs":"2026-08-25T16:05:00Z","pdfBlob":"u2/jha-26-292-03-2026-08-25-1.pdf","createdAt":"2026-08-25T13:00:00Z","updatedAt":"2026-08-25T16:00:00Z"}]},"lime_posts":{"updatedAt":"2026-08-21T09:00:00Z","data":[{"ts":"2026-08-21T09:00:00Z","state":"TX","rate":33,"areaSqft":50000,"sqyd":5556,"totalLbs":183333,"totalTons":91.7,"exactTrucks":9.17,"trucksToOrder":9,"effectiveRate":32.4,"pctOfSpec":98,"projectCode":"26-292-03","projectName":"PROSPER RETAIL"}]},"flexbase_posts":{"updatedAt":"2026-08-21T09:30:00Z","data":[{"ts":"2026-08-21T09:30:00Z","state":"CA","areaSqft":50000,"depthIn":6,"truckTons":22,"cubicYards":925.9,"totalTons":1666.7,"exactTrucks":75.76,"trucksNeeded":76,"lastTruckTons":16.7,"projectCode":"26-100-03","projectName":"NL35 III PH 1 - SITE & BUILDING 7"}]},"load_count":{"updatedAt":"2026-08-20T09:00:00Z","data":{"meta":{"source":"Riverside Pit","deliveredTo":"Prosper Retail","date":"2026-08-20","checker":"J. Ruiz","contractor":"EBCC","jobNum":"26-292-03"},"trucks":[{"id":"t1","truckTypeId":"super_10","truckNo":"14","name":"Alliance Trucking","loads":[{"in":"06:10","out":"07:02"},{"in":"07:40","out":"08:31"}]},{"id":"t2","truckTypeId":"end_dump","truckNo":"22","name":"Alliance Trucking","loads":[{"in":"06:20","out":"07:15"},{"in":"08:05","out":""}]}]}},"load_count_sends":{"updatedAt":"2026-08-20T15:02:00Z","data":[{"ts":"2026-08-19T15:02:00Z","date":"2026-08-19","source":"Riverside Pit","jobNum":"26-292-03","deliveredTo":"Prosper Retail","trucks":3,"loads":9,"cy":102,"byType":[{"label":"Super 10","trucks":2,"loads":6,"cy":60},{"label":"Semi End Dump","trucks":1,"loads":3,"cy":42}],"emailedTo":["office@earthbasics.net"],"sent":true,"pdfBlob":"u2/loadcount-2026-08-19-111.pdf"},{"ts":"2026-08-20T15:02:00Z","date":"2026-08-20","source":"Riverside Pit","jobNum":"26-292-03","trucks":2,"loads":3,"cy":34,"byType":[{"label":"Super 10","trucks":1,"loads":2,"cy":20},{"label":"Semi End Dump","trucks":1,"loads":1,"cy":14}],"emailedTo":[],"sent":false,"pdfBlob":"u2/loadcount-2026-08-20-123.pdf"}]},"flat_posts":{"updatedAt":"2026-08-03T11:00:00Z","data":[{"ts":"2026-08-03T11:00:00Z","state":"CA","hoursPerDay":8,"sqftPerDay":25000,"jobSqft":100000,"equipQty":2,"items":[{"name":"Compactor: CAT824","qty":1,"costPerDay":2016},{"name":"Labor: Laborer","qty":1,"costPerDay":416}],"totalCost":2432,"costPerSqFt":0.097,"daysToComplete":4}]},"cpy_posts":{"updatedAt":"2026-08-03T09:30:00Z","data":[{"ts":"2026-08-03T09:30:00Z","state":"CA","hoursPerDay":8,"ydPerLoad":26,"yardsToMove":40000,"producerQty":3,"producers":[{"name":"Scraper: CAT657","qty":2,"roundTime":3,"yardsPerDay":3744,"type":"scraper"},{"name":"Rock Truck: CAT 730 (22.9 cy)","qty":1,"roundTime":4,"yardsPerDay":2748,"type":"rock"}],"totalCost":18000,"totalYards":6492,"dirtYards":3744,"rockYards":2748,"costPerYard":2.77,"daysToComplete":6.2}]},"cpy_state":{"updatedAt":"2026-07-14T09:30:00Z","data":{"hoursPerDay":8,"ydPerLoad":28,"yardsToMove":40000,"procShifts":2,"procShiftHours":10,"job":[{"name":"Scraper: CAT657","quantity":2,"rate":466,"producer":true,"roundTime":3},{"name":"Material Processor: Wirtgen SM220","quantity":1,"rate":880,"processor":true,"ydPerHr":250},{"name":"Labor: Foreman","quantity":1,"rate":105}]}},"flat_state":{"updatedAt":"2026-07-14T10:00:00Z","data":{"flatHoursPerDay":8,"flatSqftPerDay":25000,"flatJobSqft":100000,"flatJob":[{"name":"Compactor: CAT824","quantity":1,"rate":210}]}},"ewt_records":{"updatedAt":"2026-07-20T10:00:00Z","data":[{"ts":"2026-07-20T09:00:00Z","ticketNo":"21100","date":"2026-07-19","customer":"Test Co","description":"Broke rock at north pad","signed":true,"pdf":"data:application/pdf;base64,JVBERi0xLjQKJdP0zOEKMSAwIG9iago8PD4+CmVuZG9iagp0cmFpbGVyCjw8Pj4KJSVFT0Y="},{"ts":"2026-08-03T12:00:00Z","ticketNo":"21120","date":"2026-08-03","customer":"Blob Co","printName":"Gabriel Arriaga","description":"Blob-backed ticket","signed":true,"pdf":"","pdfBlob":"u2/21120-2026-08-03-123.pdf"},{"ts":"2026-07-25T09:00:00Z","ticketNo":"21110","date":"2026-07-24","customer":"Lost PDF Co","jobNum":"26-100-03","printName":"Gabriel Arriaga","description":"PDF was lost before reaching storage","signed":true,"pdf":"","labor":[{"desc":"Operator","trade":"OP","reg":"8","ot":"2","sb":""}],"equipment":[{"name":"Scraper: CAT657","hours":"8","sb":""}],"materials":[{"desc":"Base rock","qty":"20","unit":"tons"}]}]},"lime_state":{"updatedAt":"2026-07-14T10:05:00Z","data":{"lime-rate":"33","lime-area":"50000"}},"flexbase_state":{"updatedAt":"2026-07-14T10:06:00Z","data":{"fb-area":"50000","fb-depth":"6","fb-truck-tons":"22"}}}}'
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
        $json = '{"ownerId":"dev-admin","records":{"incident_reports":{"updatedAt":"2026-09-13T15:00:00Z","data":[{"id":"irSRV1","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-09-13","time":"14:20","reporter":"Travis Pecoy","type":"Near Miss","involved":"J. Ruiz","location":"haul road","desc":"Rock truck backed toward grade checker; spotter stopped it.","injury":"","action":"Stand-down talk, spotter re-positioned","witnesses":"M. Lopez","createdAt":"2026-09-13T14:30:00Z","updatedAt":"2026-09-13T15:00:00Z"}]},"production_sends":{"updatedAt":"2026-08-26T19:00:00Z","data":[{"ts":"2026-08-25T18:00:00Z","date":"2026-08-25","kind":"cpy","projectCode":"26-292-03","projectName":"PROSPER RETAIL","amount":8000,"sent":true},{"ts":"2026-08-26T18:00:00Z","date":"2026-08-26","kind":"cpy","projectCode":"26-292-03","projectName":"PROSPER RETAIL","amount":8064,"sent":true},{"ts":"2026-08-26T19:00:00Z","date":"2026-08-26","kind":"cpy","projectCode":"26-292-03","projectName":"PROSPER RETAIL","amount":7500,"sent":true}]},"jha_records":{"updatedAt":"2026-08-25T17:00:00Z","data":[{"id":"jhaDEV1","projectCode":"26-292-03","projectName":"PROSPER RETAIL","date":"2026-08-25","contractor":"Earth Basics","preparedBy":"Travis Pecoy","description":"Mass ex on building pad","hazards":{"Excavating/Trenching":true},"steps":[{"step":"Excavate pad","hazard":"Open cut, traffic","control":"Slope per plan, vest + spotter"}],"signoffs":[{"name":"Server Carry One","injured":"no","sig":""},{"name":"Server Carry Two","injured":"","sig":""}],"createdAt":"2026-08-25T06:00:00Z","updatedAt":"2026-08-25T17:00:00Z"}]},"ewt_drafts":{"updatedAt":"2026-08-07T08:00:00Z","data":[{"id":"dLAPTOP1","savedAt":"2026-08-07T08:00:00Z","ticket":{"ticketNo":"21130","customer":"Laptop Draft One","jobNum":"26-292-03","description":"Written on the laptop","labor":[{"desc":"Operator","trade":"OP","reg":"8","ot":"","sb":""}],"equipment":[],"materials":[]}},{"id":"dLAPTOP2","savedAt":"2026-08-07T08:30:00Z","ticket":{"customer":"Laptop Draft Two","labor":[],"equipment":[],"materials":[]}},{"id":"dDELETEDELSEWHERE","tombstone":true,"deletedAt":"2026-08-07T08:45:00Z"}]}}}'
      } elseif ($path -like '/api/users*' -and $req.Url.Query -like '*scope=directory*') {
        $json = '{"users":[{"id":"u3","email":"ben.carter@earthbasics.net","name":"Ben Carter"},{"id":"u2","email":"maria.lopez@earthbasics.net","name":"Maria Lopez"},{"id":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy"}]}'
      } elseif ($path -like '/api/users*') {
        $json = '{"users":[{"id":"dev-admin","email":"travis@earthbasics.net","name":"Travis Pecoy","role":"admin","lastActiveAt":"2026-07-01T15:00:00Z","counts":{"trucking_tickets":12,"load_count":1,"ewt_records":3,"jha_records":2,"incident_reports":1}},{"id":"u2","email":"maria.lopez@earthbasics.net","name":"Maria Lopez","role":"user","lastActiveAt":"2026-09-21T18:19:23.557Z","counts":{"jha_records":4,"toolbox_records":2,"trucking_sends":1,"incident_reports":1}},{"id":"u3","email":"ben.carter@earthbasics.net","name":"Ben Carter","role":"user","lastActiveAt":"2026-08-12T15:00:00Z","counts":{}},{"id":"u4","email":"old.hand@earthbasics.net","name":"Old Hand","role":"disabled","counts":{"cpy_posts":3}}]}'
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

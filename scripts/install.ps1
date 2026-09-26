# Minecraft network setup for Windows. The Worker serves this at /s/<code> with the three
# values below filled in; people run it as:  irm <worker>/s/<code> | iex
# It runs inside the person's own PowerShell window, so it never calls `exit` (that would
# close their window): everything is in one script block that returns or throws instead.
& {
$WorkerUrl = '__WORKER_URL__'
$Code = '__CODE__'
$Mode = '__MODE__'
Write-Host "Setup for $Mode on $WorkerUrl"
}

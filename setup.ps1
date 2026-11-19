# setup.ps1 - one command on a bare Windows machine: prerequisites, questions,
# install, verify.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -y
#   powershell -ExecutionPolicy Bypass -File setup.ps1 --skip-prereqs
#
# Why this file exists: on Windows there is no shell shim - docs/install.md told
# a person to run `node setup.mjs` by hand, which needs Node to be installed
# first, by hand. This bootstrap installs git and Node 24 with winget when they
# are missing, refreshes $env:Path in this session, and only then runs
# `node setup.mjs`. That refresh is the fix for the exact failure docs/install.md
# documents: winget writes the machine PATH, the shell holds the block Explorer
# copied at sign-in, and `git --version` answers "not recognized" until the
# session reads the new block.
#
# Windows PowerShell 5.1 compatible on purpose: no `&&` (that is PowerShell 7),
# no ternary, no `??`. Every line here runs on the 5.1 a fresh Windows opens.
# -ExecutionPolicy Bypass on the invocation is what makes a `Restricted` machine
# work without the person changing a policy first; the policy is not a
# precondition for this installer.
#
# PI_SKIP_PREREQS=1 installs nothing (CI, and anyone who manages node by hand).
# The flag table and the per-OS behaviour are in docs/install.md.

[CmdletBinding()]
param(
	# The shape a person types: `-SetupArgs '--skip-prereqs','--help'`. Under
	# `powershell -File` there is no expression parsing, so that arrives as ONE
	# string with the quotes still on it — never as two arguments.
	[Parameter()]
	[string[]] $SetupArgs,
	# Everything else, positional: `setup.ps1 --dry-run --no-keys`.
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]] $Rest
)

$ErrorActionPreference = 'Stop'

function Say($message) { Write-Host $message }
function Note($message) { Write-Host "   $message" }
function Warn($message) { Write-Host "!! $message" -ForegroundColor Yellow }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# The node major mise.toml pins, read from its projection .node-version: the one
# file actions/setup-node reads and the one that exists before the docs do.
$Pin = '24'
$pinFile = Join-Path $Root '.node-version'
if (Test-Path $pinFile) {
	$match = [regex]::Match((Get-Content $pinFile -Raw), '(\d+)')
	if ($match.Success) { $Pin = $match.Groups[1].Value }
}

function Have($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

# A winget install is written to the machine or user PATH block, and this process
# inherited the block Explorer copied before the install - a new Start-menu
# window is the same Explorer and hands out the same stale block. Reading both
# blocks again is the repair, and it is why this installer does not need the
# sign-out docs/install.md#troubleshooting asks for in the manual path.
function Refresh-Path {
	$parts = @()
	foreach ($block in @('Machine', 'User')) {
		$value = [Environment]::GetEnvironmentVariable('Path', $block)
		if ($value) { $parts += $value }
	}
	$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
	$extra = @(
		"$env:ProgramFiles\nodejs",
		"$env:LOCALAPPDATA\Programs\nodejs",
		"$env:ProgramFiles\Git\cmd",
		"$env:LOCALAPPDATA\Programs\Git\cmd",
		"$env:LOCALAPPDATA\Microsoft\WinGet\Links"
	)
	if ($programFilesX86) { $extra += "$programFilesX86\nodejs" }
	foreach ($dir in $extra) {
		if ($dir -and (Test-Path $dir)) { $parts += $dir }
	}
	$env:Path = ($parts -join ';')
}

# Every install is announced with the exact command first; winget asks for
# elevation itself when a package has no per-user install, which is the only
# prompt in this script.
function Install-WithWinget($tool, $id) {
	Note "${tool}: missing - installing with winget"
	Note "   run: winget install --id $id -e --source winget"
	& winget install --id $id -e --source winget --accept-source-agreements --accept-package-agreements
	if ($LASTEXITCODE -ne 0) {
		Warn "${tool}: winget exited $LASTEXITCODE - install it by hand: winget install --id $id -e --source winget"
	}
}

Say '== prerequisites'
if ($env:PI_SKIP_PREREQS -eq '1') {
	Say '== prerequisites: PI_SKIP_PREREQS=1 - nothing checked, nothing installed'
} else {
	Refresh-Path
	$winget = Have 'winget'
	# npm ships inside the Node package: one install answers both, and asking
	# winget for the same id twice would install it twice.
	$wanted = @(
		@{ Tool = 'git'; Id = 'Git.Git' },
		@{ Tool = 'node'; Id = 'OpenJS.NodeJS.LTS' },
		@{ Tool = 'npm'; Id = 'OpenJS.NodeJS.LTS' }
	)
	foreach ($dep in $wanted) {
		if (Have $dep.Tool) { continue }
		if (-not $winget) {
			Note "$($dep.Tool): missing, and winget is not on this machine - install it by hand"
			continue
		}
		# node first when only npm is missing is not a case: npm without node is a
		# broken Node install, and reinstalling node is the fix either way.
		if ($dep.Tool -eq 'npm' -and (Have 'node')) { continue }
		Install-WithWinget $dep.Tool $dep.Id
		Refresh-Path
	}
	if ((Have 'git') -and (Have 'node') -and (Have 'npm')) {
		Note 'prerequisites: git, node and npm are on PATH - nothing to install'
	}
}

Refresh-Path
if (-not (Have 'node')) {
	Warn 'node is still not on PATH - install it, open a new window, and re-run this script:'
	Note '   winget install --id OpenJS.NodeJS.LTS -e --source winget'
	Note '   or download the LTS installer from https://nodejs.org'
	exit 1
}

$nodeVersion = (& node --version)
Say ''
Say "== setup.mjs (Node $nodeVersion, pin $Pin)"

# Each element of -SetupArgs has to reach `node setup.mjs` as its OWN argument.
# `powershell -File setup.ps1 -SetupArgs '--skip-prereqs','--help'` hands this
# script the single string "'--skip-prereqs','--help'" — -File does no expression
# parsing — and forwarding that string unchanged is how the engine came to read
# "--skip-prereqs,--help" as one unknown option. So one element is split on its
# commas, unquoted, and the result is an array node receives one element at a
# time. Nothing here changes an argument that was already one argument.
function Get-NodeArgs($items) {
	$out = @()
	foreach ($item in $items) {
		if (-not $item) { continue }
		foreach ($part in ($item -split ',')) {
			$value = $part.Trim().Trim("'").Trim('"').Trim()
			if ($value) { $out += $value }
		}
	}
	return $out
}

$nodeArgs = @(Get-NodeArgs ($SetupArgs + $Rest))
& node (Join-Path $Root 'setup.mjs') @nodeArgs
exit $LASTEXITCODE

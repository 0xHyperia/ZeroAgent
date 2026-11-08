# ZeroAgent Windows installers

The Windows bundle uses Tauri's stock NSIS and MSI installers with the ZeroAgent
identity and installer icon. Tauri handles application-data choices and upgrades.
User-profile directories outside Tauri's application-data scope stay in place,
including the original LiveAgent data and ZeroAgent's separate profile data.

The Windows release workflow runs `scripts/release/test-windows-installers.ps1`
against verified artifacts on a disposable Windows runner. On a development
machine, the script's `-DryRun` mode checks artifact metadata and writes the test
plan. Installation and removal run only on the disposable runner.

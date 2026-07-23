# Mobile local debug helper

Run this from the repository root when you want to start the mobile Android debug flow:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\mobile_dev_start.ps1
```

The script:

- checks for an existing `emulator-xxxx device` in `adb devices`
- starts the `Medium_Phone` AVD when no emulator device is available
- waits for the emulator to become ready
- runs `adb reverse tcp:8081 tcp:8081`
- starts Metro in a new PowerShell window only when Metro is not already running on port `8081`
- runs `npm.cmd run android -- --no-packager` from the repository's `mobile` directory

On Windows, use `-ExecutionPolicy Bypass` if direct script execution is blocked by local PowerShell policy.
If Chinese output looks garbled, use Windows Terminal; the script also switches the console to the UTF-8 code page automatically.

Optional parameters:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\mobile_dev_start.ps1 -AvdName Medium_Phone -MetroPort 8081
```

This helper does not start backend, web, or worker processes.

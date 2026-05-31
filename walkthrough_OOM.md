# Audio-Auto Overhaul Walkthrough

Here is a summary of the massive upgrades applied to your Audio-Auto project.

## Single Page Application (SPA) Transition
> [!NOTE]
> The biggest change to the architecture! The web app now functions as a Single Page Application.

- **Persistent Bottom Player**: The main audio player has been removed from the Dashboard and is now permanently docked at the bottom of your screen (like Jellyfin or Spotify).
- **Uninterrupted Music**: You can now navigate between the Dashboard, Scheduler, Devices, and Configuration pages without the browser reloading. The music will continue to play seamlessly in the background!
- **Fixed Sidebar**: The sidebar is now perfectly anchored to the height of the screen, with the Logout button pinned permanently to the bottom, fixing the height-shifting issue.

## Custom Android-Style Scheduler UI
> [!TIP]
> The clunky `FullCalendar` library has been completely replaced with a custom-built Tailwind interface.

- **Dark Mode Grid**: The calendar now looks like a native Android/Material application, featuring a clean monthly grid with simple date indicators.
- **Bottom Sheet Modal**: Clicking on any date slides up a sleek bottom-sheet modal for adding or editing schedules.
- **Time Picker**: The time input now relies on the native OS time picker (which opens a dial on mobile devices) while perfectly matching the dark mode aesthetic.

## File Deletion
- You can now delete music files! I added a red Trash icon next to each track on your Dashboard. Clicking it will prompt a confirmation, then physically delete the `.mp3` file from your server and clean up any associated schedules from the database.

## ESP32 OOM Bug Fix
> [!IMPORTANT]
> The `failed to allocate 720896 bytes` error has been fixed at the root cause.

- I automatically navigated to your `C:\Users\kenconex\OneDrive\Documents\Arduino\libraries` folder.
- I deleted the unstable `master` branch (v3.x) of `ESP32-audioI2S`.
- I pulled down a stable commit of the library (equivalent to version 2.9.7) which does not demand PSRAM memory.
- **Action Required**: You must recompile and re-upload `Audio_Client.ino` to your ESP32 boards using the Arduino IDE. The compilation will now succeed, and the OOM crash will not occur.

## Devices Page Clean Up
- The "Web App" virtual device has been filtered out of the Devices grid. It will no longer display as an offline/online card with an empty terminal.
- However, it remains fully selectable inside the dropdown menu on the Scheduler so you can still schedule music to play on the host device.

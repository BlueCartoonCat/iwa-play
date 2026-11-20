# IWA Play

IWA Play is an Isolated Web App (IWA) for receiving screen and media sharing
from iOS and macOS devices using AirPlay.

This version is intended for screen sharing/extension and tested only for this feature. Audio or media playback might not work properly.

## Installation

1. Open `chrome://iwa-dev` in Chrome.
2. Enable the IWA features if they are not already enabled.
3. Press **Install** and select **Update Manifest**.
4. Enter the update manifest URL:

   ```text
   https://raw.githubusercontent.com/BlueCartoonCat/iwa-play/main/update_manifest.json
   ```
5. Install the latest version.
6. Set the current device's local IP (Chrome might pick a wrong interface).
7. Set the name and resolution.
8. Press Apply to start and accept the permissions.
<img width="1312" height="1003" alt="image" src="https://github.com/user-attachments/assets/63e6b16b-eb02-4bfb-8054-c20e5e31a671" />

## License

See [LICENSE](LICENSE). The AirPlay implementation contains code and data
adapted from [UxPlay](https://github.com/FDH2/UxPlay); attribution is retained
in `app/airplay.js`.

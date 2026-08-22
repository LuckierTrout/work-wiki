# work-wiki browser clipper

This Manifest V3 extension sends the current tab to work-wiki's existing owner-authenticated `/save` confirmation screen. It never stores a password or API key in the browser extension.

1. Open `chrome://extensions` in Chrome or Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `integrations/browser-clipper` folder.
4. Pin **work-wiki Clipper**.

Use the toolbar button or the **Save page to work-wiki** context-menu action. The toolbar remembers optional default tags; the secure capture window lets you choose a vault, edit those tags, and confirm the save. If your work-wiki session has expired, the app redirects you through its normal owner sign-in flow and then back to capture.

Before publishing to an extension store, package the folder, add reviewed icon assets, and update the `host_permissions` entry if the production hostname changes.

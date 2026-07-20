# Prusa Connect setup

Prusa Connect is recommended for a CORE One with INDX because PrusaLink does not
provide the exact active tool or all of the live fields used by the dashboard.
The local PrusaLink poller still runs and remains the automatic fallback during a
Connect outage.

This integration is experimental. It uses the Prusa Connect web client's public
OAuth client and undocumented web endpoints, not a supported third-party API.
Prusa can change the login storage or endpoint behavior without notice.

## Service terms and request boundary

[Prusa Connect's terms](https://www.prusa3d.com/page/prusa-connect-prusa-link-terms-and-conditions_233705/)
require effective use of network resources and prohibit scraping, artificially
increasing queries, and overloading the service. This project makes one serialized
telemetry request no faster than every five seconds, backs off after failures,
and fetches job details or assets only when the active job requires them. Run one
overlay instance per printer and token chain.

Those limits are a load boundary, not approval from Prusa. Enable Connect only
for an account and printer you control, after reviewing the current terms and
confirming that your use is permitted. Leave `useConnect` set to `false` if you
do not accept that experimental boundary.

## Before you capture a token

Use a fresh private or incognito browser window so the overlay gets a dedicated
refresh-token chain. Do not share one token between the overlay, another overlay
instance, scripts, or an ordinary browser session. Prusa rotates a refresh token
when it is used, so competing clients can invalidate each other.

The overlay code performs read and download requests only, but the extracted web
client token is not a project-issued read-only or least-privilege credential. It
may carry broader account or printer authority than this project uses. A private
window isolates the rotation chain; it does not reduce the token's permissions.

The API key available under Prusa Connect **Settings > API keys** is intended for
network G-code sending and is not the OAuth refresh token this integration needs.
See [Prusa's network G-code guide](https://help.prusa3d.com/article/sending-g-codes-to-printer-via-network-prusa-connect-prusalink-octoprint_196761)
for that separate API-key feature.

## Capture the printer UUID and refresh token

1. Open <https://connect.prusa3d.com/> in a new private or incognito window and
   sign in.
2. Open the printer in Connect. Copy its UUID from the printer page URL. It is the
   long printer identifier, not the printer's LAN address, serial number, or API
   key.
3. Open the browser developer console while still on Connect. Review this complete
   helper, then copy and run the whole block. The same audited source is available
   as [`tools/copy-connect-token.js`](../tools/copy-connect-token.js).

   <!-- BEGIN CONNECT TOKEN HELPER -->
   ```js
   void (() => {
     'use strict';

     const expectedOrigin = 'https://connect.prusa3d.com';
     const tokenKey = 'auth.refresh_token';

     if (location.origin !== expectedOrigin) {
       console.error(`Token not shown: open ${expectedOrigin}/ and run this there.`);
       return;
     }

     let token;
     try {
       token = localStorage.getItem(tokenKey);
     } catch {
       console.error('Token not shown: this browser blocked access to Connect Local Storage.');
       return;
     }

     if (typeof token !== 'string' || token.length === 0) {
       console.error('Token not shown: sign in to Prusa Connect, then try again.');
       return;
     }

     console.info(
       'Copy the Prusa Connect refresh token printed on the next line. Treat it as a password.',
     );
     console.log(token);
     console.info(
       'After pasting it into the hidden setup prompt, clear this console and your clipboard, then close the private window.',
     );
   })();
   ```
   <!-- END CONNECT TOKEN HELPER -->

   It refuses to run outside the exact `https://connect.prusa3d.com` origin,
   reads only `auth.refresh_token`, makes no network request, and prints the token
   once so you can copy it yourself.
4. If DevTools shows its self-XSS paste warning, inspect the code first and use
   only the browser's visible built-in guidance. Never launch the browser with an
   unsafe warning-disable flag. The durable fallback is **Application > Local
   storage** in Chromium or **Storage > Local Storage** in Firefox: manually copy
   `auth.refresh_token` from `https://connect.prusa3d.com`.
5. Treat the displayed value as a password. Do not put it in an issue, terminal
   transcript, screenshot, chat, or committed file.
6. Copy the token from the console and paste it into the hidden setup prompt or
   private `config.json`. Clear the DevTools console and clipboard, then close
   every tab in that private window. Do not return that private session to Connect
   after the overlay starts using its token.

This manual handoff matches the Connect web client as verified on 2026-07-20. If
the storage key is absent or the flow has changed, stop and open an issue without
posting account data; do not substitute an access token or Connect API key.

## Configure the overlay

For a first-time configuration, run `bun run setup` and enter the UUID and
refresh token when prompted; token input is hidden. Setup never overwrites an
existing `config.json`, so add the values manually when upgrading an existing
installation. For a manual or Docker configuration, keep `config.json` private
and set:

```json
{
  "useConnect": true,
  "connectPrinterUuid": "replace-with-your-printer-uuid",
  "connectClientId": "",
  "connectRefreshToken": "replace-with-your-dedicated-refresh-token",
  "connectPollMs": 5000
}
```

Leave `connectClientId` empty to use the built-in public web-client ID. Connect is
credential-gated: `useConnect` defaults to `true`, but no cloud request is made
until both the UUID and refresh token are present. Set `useConnect` to `false`
only for an intentional PrusaLink-only deployment.

Run `bun run doctor`, then start the overlay. Doctor checks for the UUID and the
effective seed or persisted token without printing them, but deliberately does
not authenticate or rotate the token. Wait for `[connect] telemetry poll
succeeded` in the server log; the earlier `polling configured printer` startup
line only means the integration is enabled. Authentication failures are logged
without the token value.

## Rotation, backups, and recovery

The configured refresh token is only a seed. After the first successful refresh,
Prusa issues a replacement and the service atomically stores it in
`DATA_DIR/connect-token.json` (the default is `cache/connect-token.json`). That
persisted value takes precedence over `config.json` on every restart. Keep
`DATA_DIR` private, persistent, and backed up with the same care as the config.

If authentication fails and a new token is required:

1. Stop the overlay so it cannot rotate a token during recovery.
2. Rename `DATA_DIR/connect-token.json` to a private backup instead of deleting
   it. Do the same for a `.bak` sibling if one exists.
3. Use a new private browser window to capture a new dedicated refresh token.
4. Replace only `connectRefreshToken` in the ignored `config.json`.
5. Run `bun run doctor`, start the overlay, and wait for `[connect] telemetry poll
   succeeded` in its log.
6. Remove the renamed token backup only after that success signal and after no
   private incident record needs it.

Never run two overlay processes for the same token chain. In Docker, preserve the
`overlay-data` volume: removing it also removes the live rotated token and other
runtime state.

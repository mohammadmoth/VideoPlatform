# VideoPlatform

A single-room, trusted-local-network video player with one controller and multiple synchronized displays.

## Run

Use Node.js 22 or newer:

```sh
npm ci
npm start
```

The default port is **8080** (override with `PORT`). On every device use the **same server address**, for example:

- Controller: `http://192.168.1.10:8080/?master=true`
- Other screens: `http://192.168.1.10:8080/`

Replace the example IP with the computer running the server. Allow TCP 8080 through its local firewall. `localhost` only works on the server computer itself.

1. Click **Join screens** on each device. Wait for all screens to appear in the connected count.
2. Click **Play** on the controller. Every joined screen buffers before a shared scheduled start.
3. Use the controller's **Pause** and position slider to control all screens.
4. Playback starts muted to avoid browser autoplay restrictions. Use **Enable sound** on the desired device. Usually only one device should output audio to avoid echoes.

## Synchronization

- The server owns playback position and uses a monotonic clock, independent of system clock adjustments.
- Each browser estimates its clock offset from multiple round trips, preferring low-latency samples. Offsets refresh during playback.
- Play and seek wait for the joined screens to buffer approximately one second. Playback is scheduled 800 ms ahead once everyone is ready; readiness loss during the countdown restarts preparation.
- If a screen cannot prepare within 20 seconds, the operation is cancelled with an error instead of waiting forever. Fix or disconnect the problem screen and retry.
- Errors below 40 ms are ignored; small differences are corrected with up to ±4% playback-rate adjustment. Errors above 800 ms use a seek, rate-limited to avoid repeated jumps.
- A late/reconnected display catches up to the room. Controller disconnection pauses the room. Missing server messages for 10 seconds pauses a browser locally and triggers reconnection.
- Mid-playback buffering on one display does not freeze all displays: the stalled display catches up when playable again.

## Practical limits

This is browser-level synchronization, **not frame-locked hardware synchronization**. Actual error depends on network jitter, decoding speed, browser throttling, audio hardware, and display latency. Keep pages visible, disable device sleep, and prefer wired Ethernet or strong Wi-Fi. The 800 ms start lead assumes local-network latency well below that value.

Large/high-bitrate or unsupported-codec files can still buffer. Use an MP4 encoding compatible with every target device and enough network bandwidth for each screen's independent video stream. The server does not transcode video. A sufficiently slow device will need a smaller/lower-bitrate file.

There is one shared room and no authentication: anyone with server access can request the controller role if it is free. Do not expose this server directly to the public Internet. A second controller opens as a display; reconnect/reload it after the first controller leaves to claim control.

## Tests

```sh
npm test
```

Optional real-Chrome test (no additional npm packages):

```sh
CHROMIUM_PATH=/path/to/chrome npm run test:browser
```

Uses the real MP4 in multiple browser tabs to test startup with simulated clock skew, smooth correction, pause, zero/playing seeks, late joining, reconnection, lost inbound messages, and page-restoration lifecycle events. It requires a Chrome build capable of decoding the file. Without `CHROMIUM_PATH`, this test is explicitly skipped. Local browser tests do not replace validation on the actual screens/network.

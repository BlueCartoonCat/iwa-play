import {
  MDNS_ADDRESS,
  MDNS_PORT,
  AIRPLAY_PORT,
  RAOP_PORT,
  TYPES,
  createRecords,
  validateConfig,
  parsePacket,
  buildAnnouncementPackets,
  buildAnswerPacketsForQuery,
  buildProbePacket,
  hasUniqueRecordConflict,
  matchingRecords,
  decodeName,
  AirPlayReceiver,
  getVideoBlob,
  Diagnostics,
  H264CanvasSink,
} from "./airplay.js";

const $ = (id) => document.getElementById(id);
const STORE = "iwaplay-v1";
let socket = null,
  writer = null,
  reader = null,
  multicast = null,
  records = null,
  tcpReceiver = null;
let mediaUrl = null;
const logs = new Diagnostics();
const mirrorCanvas = $("mirrorCanvas");
const mirrorSink = new H264CanvasSink(mirrorCanvas, {
  onStatus: (msg) => logs.add("info", "decoder", msg),
});
let mirrorWarned = false,
  mirrorFrames = 0,
  mirrorHeartbeats = 0;
// Translate receiver events into decoder operations and bounded diagnostics.
async function mirrorEvent(event) {
  if (event.type === "connected") {
    logs.add("info", "mirror", "TCP mirror stream connected");
    return;
  }
  if (event.type === "disconnected") {
    logs.add("info", "mirror", "TCP mirror stream disconnected");
    return;
  }
  if (event.type === "encrypted") {
    if (!mirrorWarned) {
      mirrorWarned = true;
      logs.add(
        "warn",
        "fairplay",
        "Encrypted AirPlay mirror stream received without usable stream keys; ciphertext is ignored. Check FairPlay SAP and streamConnectionID setup.",
      );
      showState(
        "Mirroring unsupported",
        "error",
        "The encrypted mirror stream could not be keyed for decryption.",
      );
    }
    return;
  }
  if (event.type === "unknown") {
    logs.add(
      "warn",
      "mirror",
      `Unknown mirror packet type ${event.rawType}, marker ${event.marker}, payload ${event.length} bytes; header: ${event.headerHex}. Packet skipped without closing TCP.`,
    );
    return;
  }
  if (event.type === "invalid") {
    logs.add(
      "warn",
      "mirror",
      `Invalid mirror header: type ${event.rawType}, marker ${event.marker}, size ${event.length}; first bytes: ${event.headerHex}. Scanning for a valid packet boundary.`,
    );
    return;
  }
  if (event.type === "resync") {
    logs.add(
      "warn",
      "mirror",
      `Mirror stream resynchronized after discarding ${event.discarded} byte(s); previous header: ${event.headerHex}`,
    );
    return;
  }
  if (event.type === 5) {
    logs.add(
      "info",
      "mirror",
      `Stream report received (${event.data.length} bytes)`,
    );
    return;
  }
  if (event.type === 2) {
    if (++mirrorHeartbeats % 40 === 1)
      logs.add("info", "mirror", "Heartbeat received");
    return;
  }
  if (event.type === 1) {
    logs.add(
      "info",
      "mirror",
      "AVC codec data: " + event.data.length + " bytes",
    );
    try {
      await mirrorSink.configure(event.data);
      mirrorCanvas.hidden = false;
    } catch (e) {
      logs.add("error", "decoder", e.message);
    }
    return;
  }
  if (event.type === 0) {
    if (!mirrorSink.decode(event.data)) {
      if (++mirrorFrames % 60 === 1)
        logs.add(
          "warn",
          "decoder",
          `Dropped H.264 frame (${event.data.length} bytes): ${mirrorSink.lastDecodeIssue || "unknown decode error"}`,
        );
    } else if (++mirrorFrames % 120 === 1)
      logs.add("info", "mirror", "Displaying decrypted H.264 video");
  }
}
logs.add("info", "app", "IWA Play starting");
let generation = 0,
  started = false,
  busy = false,
  probing = false,
  lastMulticast = 0;
let lastConfig = null;
const timers = new Set();
const utf8 = new TextDecoder();
const photo = $("airplayPhoto"),
  video = $("airplayVideo");
function releaseMedia() {
  photo.hidden = true;
  video.hidden = true;
  mirrorCanvas.hidden = true;
  mirrorSink.close();
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (mediaUrl) {
    URL.revokeObjectURL(mediaUrl);
    mediaUrl = null;
  }
  showState(
    "Ready for AirPlay",
    "ready",
    "Share a photo or compatible video from your device.",
  );
}

function showPhoto(data, type) {
  releaseMedia();
  mediaUrl = URL.createObjectURL(new Blob([data], { type }));
  photo.src = mediaUrl;
  photo.hidden = false;
  showState("Showing photo", "ready", "");
}

async function showVideo(url, startPosition = 0) {
  releaseMedia();
  video.hidden = false;
  showState("Loading video…", "idle", "");
  try {
    const uri = new URL(url);
    if (uri.protocol === "http:") {
      const blob = await getVideoBlob(url);
      mediaUrl = URL.createObjectURL(blob);
      video.src = mediaUrl;
    } else if (uri.protocol === "https:") video.src = url;
    else throw Error("Unsupported video protocol");
    if (
      Number.isFinite(startPosition) &&
      startPosition > 0 &&
      startPosition < 1
    ) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = Math.max(0, video.duration * startPosition);
        },
        { once: true },
      );
    }
    void video.play().catch(() => {
      showState(
        "Video unavailable",
        "error",
        "This video format cannot play in Chrome.",
      );
    });
    showState("Playing video", "ready", "");
  } catch (e) {
    releaseMedia();
    throw e;
  }
}
video.addEventListener("timeupdate", () => {
  if (tcpReceiver) {
    tcpReceiver.current.position = video.currentTime || 0;
    tcpReceiver.current.duration = Number.isFinite(video.duration)
      ? video.duration
      : 0;
  }
});
video.addEventListener("ended", () => {
  releaseMedia();
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Persist the receiver identity so peers see the same device after a restart.
function identity() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE) || "{}") || {};
  } catch {}
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(saved.mac || "")) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    bytes[0] = (bytes[0] | 2) & 0xfe; // locally administered unicast identity
    saved.mac = [...bytes]
      .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
      .join(":");
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(saved.pi || "")) {
    saved.pi = crypto.randomUUID();
  }
  if (!saved.name) saved.name = "IWA Play";
  if (!Number.isInteger(saved.displayWidth)) saved.displayWidth = 1920;
  if (!Number.isInteger(saved.displayHeight)) saved.displayHeight = 1080;
  const host =
    "iwaplay-" + saved.mac.replaceAll(":", "").slice(-6).toLowerCase();
  try {
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {}
  return { ...saved, host };
}
const device = identity();
$("deviceName").value = device.name;
if (device.ip || device.ips?.length)
  $("lanIp").value = (device.ips?.length ? device.ips : [device.ip]).join(", ");
function setResolutionControls(
  width = device.displayWidth,
  height = device.displayHeight,
) {
  const value = `${width}x${height}`;
  const preset = $("resolutionPreset");
  const available = [...preset.options].some(
    (option) => option.value === value,
  );
  preset.value = available ? value : "custom";
  $("resolutionWidth").value = String(width);
  $("resolutionHeight").value = String(height);
  $("customResolution").hidden = available;
}

function selectedResolution() {
  const value = $("resolutionPreset").value;
  const [width, height] = (
    value === "custom"
      ? [$("resolutionWidth").value, $("resolutionHeight").value]
      : value.split("x")
  ).map(Number);
  return { displayWidth: width, displayHeight: height };
}
setResolutionControls();
$("resolutionPreset").addEventListener("change", () => {
  const custom = $("resolutionPreset").value === "custom";
  $("customResolution").hidden = !custom;
  if (!custom)
    setResolutionControls(
      ...$("resolutionPreset").value.split("x").map(Number),
    );
});
setName(device.name);
let detectedInterfaces = [];
function showInterfaces(interfaces, { select = true } = {}) {
  detectedInterfaces = interfaces;
  if (select && interfaces.length)
    $("lanIp").value = interfaces.map((item) => item.address).join(", ");
}

async function detectLanAddress({ select = true } = {}) {
  try {
    const response = await fetch("/__network/interfaces", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw Error("Interface lookup unavailable");
    const interfaces = await response.json();
    if (interfaces.length) {
      showInterfaces(interfaces, { select });
      return true;
    }
    throw Error("No IPv4 interfaces detected");
  } catch {
    const saved =
      Array.isArray(device.ips) && device.ips.length
        ? device.ips
        : device.ip
          ? [device.ip]
          : [];
    if (saved.length) {
      showInterfaces(
        saved.map((address, index) =>
          typeof address === "string"
            ? { name: `Interface ${index + 1}`, address }
            : address,
        ),
        { select },
      );
      return true;
    }
    showInterfaces([]);
    return false;
  }
}

function saveConfig(c) {
  Object.assign(device, {
    ip: c.ip,
    ips: c.ips,
    name: c.name,
    displayWidth: c.displayWidth,
    displayHeight: c.displayHeight,
  });
  try {
    localStorage.setItem(
      STORE,
      JSON.stringify({
        ip: device.ip,
        ips: device.ips,
        name: device.name,
        displayWidth: device.displayWidth,
        displayHeight: device.displayHeight,
        mac: device.mac,
        pi: device.pi,
        pk: device.pk,
        privateJwk: device.privateJwk,
      }),
    );
  } catch {}
}

function setName(name) {
  document.title = name;
}

function showState(label, kind, help) {
  $("stateLabel").textContent = label;
  $("stateDot").dataset.state = kind;
  $("helperText").textContent = help;
}

function showSetup(error = "") {
  $("setupOverlay").hidden = false;
  $("setupOverlay").setAttribute("aria-hidden", "false");
  selectModalTab("settings");
  showError(error);
  $("lanIp").focus();
}

function hideSetup() {
  $("setupOverlay").hidden = true;
  $("setupOverlay").setAttribute("aria-hidden", "true");
}

function showError(msg) {
  const e = $("setupError");
  e.hidden = !msg;
  e.textContent = msg;
}

function selectModalTab(tab) {
  const settings = tab === "settings";
  $("modalTitle").textContent = settings ? "Settings" : "Logs";
  $("settingsPanel").hidden = !settings;
  $("logsPanel").hidden = settings;
  $("settingsTab").classList.toggle("selected", settings);
  $("logsTab").classList.toggle("selected", !settings);
  $("settingsTab").setAttribute("aria-selected", String(settings));
  $("logsTab").setAttribute("aria-selected", String(!settings));
  if (!settings) drawLog();
}

function drawLog() {
  const output = $("logOutput");
  output.replaceChildren();
  for (const item of logs.events) {
    const row = document.createElement("div");
    row.className = "log-entry";
    row.dataset.level = item.level;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = item.at.slice(11, 19);
    const message = document.createElement("span");
    message.className = "log-msg";
    message.textContent = `[${item.area}] ${item.message}`;
    row.append(time, message);
    output.append(row);
  }
  output.scrollTop = output.scrollHeight;
}
logs.on(() => {
  if (!$("logsPanel").hidden) drawLog();
});
function openSettings() {
  if (busy) return;
  $("deviceName").value = device.name;
  if (device.ips?.length) $("lanIp").value = device.ips.join(", ");
  else if (device.ip) $("lanIp").value = device.ip;
  setResolutionControls(device.displayWidth, device.displayHeight);
  $("connectButton").textContent = "Apply";
  showSetup();
  void detectLanAddress({ select: false });
}
$("settingsButton").addEventListener("click", openSettings);
$("closeSettings").addEventListener("click", hideSetup);
$("setupOverlay").addEventListener("click", (event) => {
  if (event.target === $("setupOverlay")) hideSetup();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("setupOverlay").hidden) hideSetup();
});
$("settingsTab").addEventListener("click", () => selectModalTab("settings"));
$("logsTab").addEventListener("click", () => selectModalTab("logs"));
function messageFor(error) {
  const msg = String(error?.message ?? error);
  if (/local network is blocked|permission|notallowederror/i.test(msg))
    return "Chrome blocked network access. Allow Local network and Apps on device for this installed IWA, then retry.";
  if (/EADDRINUSE|address already in use|bind|port.*use/i.test(msg))
    return "UDP 5353 or TCP 49152 is unavailable. Close the other listener and retry.";
  if (/UDPSocket missing|TCPServerSocket is unavailable/i.test(msg))
    return "Open the installed Isolated Web App, not the localhost browser tab.";
  if (/already (in use|advertised)/i.test(msg))
    return "That receiver hostname is already in use on your network. Choose another computer or regenerate the receiver identity.";
  return msg;
}

// Discovery owns its timers and socket handles. Generation tokens prevent
// callbacks from an earlier start from affecting a later receiver instance.
function cancelTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

function schedule(callback, ms) {
  const id = setTimeout(() => {
    timers.delete(id);
    callback();
  }, ms);
  timers.add(id);
}

async function transmit(packet, ip = MDNS_ADDRESS, port = MDNS_PORT) {
  if (!writer) throw Error("Network socket closed");
  await writer.write({ data: packet, remoteAddress: ip, remotePort: port });
  if (ip === MDNS_ADDRESS) lastMulticast = Date.now();
}

async function transmitBurst(packets, ip = MDNS_ADDRESS, port = MDNS_PORT) {
  for (const packet of packets) await transmit(packet, ip, port);
}

async function advertise(myGeneration) {
  if (!started || myGeneration !== generation || !records) return;
  await transmitBurst(buildAnnouncementPackets(records));
  logs.add("info", "mdns", "Sent periodic AirPlay announcement");
}

async function goodbye() {
  if (!writer || !records) return;
  try {
    await transmitBurst(buildAnnouncementPackets(records, { goodbye: true }));
  } catch {}
}

function isKnown(record, answers) {
  return answers.some((existing) => {
    if (
      existing.section !== 0 ||
      existing.type !== record.type ||
      existing.name.toLowerCase() !== record.name.toLowerCase() ||
      existing.ttl < record.ttl / 2
    )
      return false;
    if (record.type === TYPES.PTR)
      return (
        existing.target?.toLowerCase() ===
        decodeName(record.data, 0).name.toLowerCase()
      );
    if (record.type === TYPES.A)
      return existing.address === [...record.data].join(".");
    if (record.type === TYPES.SRV)
      return (
        existing.port === ((record.data[4] << 8) | record.data[5]) &&
        existing.target?.toLowerCase() ===
          decodeName(record.data, 6).name.toLowerCase()
      );
    if (record.type === TYPES.TXT) {
      const values = [];
      for (let p = 0; p < record.data.length;) {
        const size = record.data[p++];
        values.push(utf8.decode(record.data.subarray(p, p + size)));
        p += size;
      }
      return JSON.stringify(values) === JSON.stringify(existing.values);
    }
    return false;
  });
}

async function respond(packet, address, port, myGeneration) {
  if (!started || myGeneration !== generation || !address || !port) return;
  const legacy = port !== MDNS_PORT;
  const unicast = legacy || packet.questions.some((q) => q.unicastRequested);
  const matches = matchingRecords(packet.questions, records);
  if (!matches.length) return;
  if (!unicast && Date.now() - lastMulticast < 1000) return;
  const omit = unicast ? [] : matches.filter((r) => isKnown(r, packet.records));
  if (omit.length === matches.length) return;
  const responsePackets = buildAnswerPacketsForQuery(packet, records, {
    legacy,
    omit,
  });
  if (responsePackets.length) {
    await transmitBurst(
      responsePackets,
      unicast ? address : MDNS_ADDRESS,
      unicast ? port : MDNS_PORT,
    );
    logs.add(
      "info",
      "mdns",
      "Answered " +
        matches.length +
        " discovery record(s) " +
        (unicast ? "unicast" : "multicast"),
    );
  }
}

async function listen(myGeneration, myReader) {
  try {
    while (myGeneration === generation) {
      const { value, done } = await myReader.read();
      if (done || myGeneration !== generation) break;
      const bytes =
        value?.data instanceof Uint8Array
          ? value.data
          : new Uint8Array(value?.data || []);
      let packet;
      try {
        packet = parsePacket(bytes);
      } catch {
        continue;
      }
      if (packet.isResponse) {
        if (probing && hasUniqueRecordConflict(packet, records)) {
          // Report collision while probing; do not publish a duplicate identity.
          probing = false;
          await fail(
            new Error("Receiver hostname already advertised on this network."),
            myGeneration,
          );
          break;
        }
        continue;
      }
      if (!started || !matchingRecords(packet.questions, records).length)
        continue;
      const address = value.remoteAddress,
        port = value.remotePort;
      logs.add(
        "info",
        "mdns",
        "Matching query for " +
          packet.questions
            .map((q) => q.name)
            .slice(0, 2)
            .join(", "),
      );
      // RFC 6762 encourages small random delays to avoid simultaneous replies.
      schedule(
        () => {
          void respond(packet, address, port, myGeneration).catch(() => {});
        },
        20 + Math.random() * 101,
      );
    }
  } catch {
    if (myGeneration === generation && started)
      await fail(new Error("Network connection closed."), myGeneration);
  } finally {
    try {
      myReader.releaseLock();
    } catch {}
  }
}

async function closeSocket() {
  if (tcpReceiver) {
    try {
      await tcpReceiver.stop();
    } catch {}
    tcpReceiver = null;
  }
  if ($("airplayPhoto")) releaseMedia();
  try {
    await reader?.cancel();
  } catch {}
  try {
    await multicast?.leaveGroup(MDNS_ADDRESS);
  } catch {}
  try {
    writer?.releaseLock();
  } catch {}
  try {
    socket?.close();
  } catch {}
  reader = null;
  writer = null;
  multicast = null;
  socket = null;
}

async function stop() {
  const wasStarted = started;
  started = false;
  probing = false;
  generation++;
  cancelTimers();
  if (wasStarted) {
    logs.add(
      "info",
      "network",
      "Stopping advertising, sending goodbye packets",
    );
    await goodbye();
  }
  await closeSocket();
  records = null;
  mirrorSink.close();
  mirrorCanvas.hidden = true;
  showState("Not connected", "error", "Reopen the receiver to try again.");
}

async function fail(err, myGeneration) {
  if (myGeneration !== generation) return;
  logs.add("error", "app", String(err?.message ?? err));
  await stop();
  $("connectButton").disabled = false;
  $("connectButton").textContent = "Apply";
  showSetup(messageFor(err));
}

async function applySettings(c) {
  if (busy || !started || !tcpReceiver) return;
  busy = true;
  $("connectButton").disabled = true;
  $("connectButton").textContent = "Apply";
  const token = generation,
    oldConfig = tcpReceiver.config,
    oldRecords = records;
  try {
    cancelTimers();
    started = false;
    probing = false;
    await goodbye();
    tcpReceiver.config = c;
    records = createRecords(c);
    setName(c.name);
    probing = true;
    const probe = buildProbePacket(records);
    await wait(Math.floor(Math.random() * 250));
    for (let i = 0; i < 3; i++) {
      if (token !== generation) throw Error("Settings apply cancelled");
      await transmit(probe);
      await wait(250);
    }
    await wait(250);
    if (token !== generation) throw Error("Settings apply cancelled");
    probing = false;
    started = true;
    saveConfig(c);
    await advertise(token);
    schedule(() => {
      void advertise(token).catch(() => {});
    }, 1000);
    showState("Ready for AirPlay", "ready", "");
    hideSetup();
  } catch (error) {
    if (token === generation) {
      probing = false;
      tcpReceiver.config = oldConfig;
      records = oldRecords;
      setName(oldConfig.name);
      started = true;
      await advertise(token).catch(() => {});
      schedule(() => {
        void advertise(token).catch(() => {});
      }, 1000);
      showError(messageFor(error));
      selectModalTab("settings");
    }
  } finally {
    busy = false;
    $("connectButton").disabled = false;
    $("connectButton").textContent = "Apply";
  }
}

// Start TCP before advertising: discovery must never announce a dead endpoint.
async function start() {
  if (busy) return;
  let c;
  try {
    const ips = [
      ...new Set(
        $("lanIp")
          .value.split(/[\s,;]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!ips.length)
      ips.push(
        ...detectedInterfaces.map((item) => item.address).filter(Boolean),
      );
    const resolution = selectedResolution();
    const raw = {
      name: $("deviceName").value,
      ip: ips[0],
      ips,
      hostname: device.host,
      mac: device.mac,
      pi: device.pi,
      pk: device.pk,
      port: AIRPLAY_PORT,
      raopPort: RAOP_PORT,
      raop: true,
      experimentalMirror: true,
      ...resolution,
    };
    c = validateConfig(raw);
  } catch (e) {
    showError(e.message);
    return;
  }
  if (started && tcpReceiver) {
    await applySettings(c);
    return;
  }
  busy = true;
  logs.add(
    "info",
    "network",
    "Starting receiver: " + c.name + " on " + c.ips.join(", "),
  );
  mirrorWarned = false;
  mirrorFrames = 0;
  mirrorHeartbeats = 0;
  $("connectButton").disabled = true;
  $("connectButton").textContent = "Apply";
  showError("");
  showState(
    "Connecting…",
    "idle",
    "Making the receiver visible on your local network.",
  );
  const myGeneration = ++generation;
  try {
    if (!("UDPSocket" in globalThis)) throw Error("UDPSocket missing");
    const receiver = new AirPlayReceiver(c, {
      onPhoto: showPhoto,
      onPlay: showVideo,
      onStop: () => releaseMedia(),
      onRate: (rate) => {
        if (rate === 0) video.pause();
        else void video.play().catch(() => {});
      },
      onSeek: (seconds) => {
        if (!video.hidden) video.currentTime = seconds;
      },
      onPeer: (msg, err) => {
        const text =
          String(msg) + (err ? " " + String(err?.message ?? err) : "");
        logs.add(
          /error|rejected|not implemented|unavailable/i.test(text)
            ? "warn"
            : "info",
          "airplay",
          text,
        );
      },
      onMirror: (event) =>
        mirrorEvent(event).catch((e) => logs.add("error", "mirror", e.message)),
    });
    tcpReceiver = receiver;
    device.privateJwk = await receiver.initIdentity(device.privateJwk);
    device.pk = [...receiver.pairing.publicKey]
      .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
      .join("");
    c = validateConfig({ ...c, pk: device.pk });
    // Start real TCP server first; never advertise a dead AirPlay endpoint.
    await receiver.listen();
    // The optional RAOP socket may have failed while AirPlay remains healthy.
    // Never announce a service without its TCP listener.
    c = validateConfig({ ...c, raop: receiver.config.raop });
    logs.add(
      "info",
      "network",
      "TCP receiver ready on " +
        AIRPLAY_PORT +
        " with mirror TCP 49154" +
        (c.raop ? ", RAOP TCP 49153 / UDP 49157+49158" : ""),
    );
    records = createRecords(c);
    const candidate = new UDPSocket({
      localAddress: "0.0.0.0",
      localPort: MDNS_PORT,
      multicastAllowAddressSharing: true,
      multicastTimeToLive: 1,
      multicastLoopback: true,
    });
    socket = candidate;
    const opened = await candidate.opened;
    if (!opened.multicastController)
      throw Error("Multicast sockets unavailable in this Chrome IWA.");
    multicast = opened.multicastController;
    await multicast.joinGroup(MDNS_ADDRESS);
    logs.add(
      "info",
      "mdns",
      "Joined multicast " + MDNS_ADDRESS + ":" + MDNS_PORT,
    );
    if (myGeneration !== generation) throw Error("Start cancelled");
    writer = opened.writable.getWriter();
    reader = opened.readable.getReader();
    void listen(myGeneration, reader);
    probing = true;
    logs.add("info", "mdns", "Probing receiver hostname for collisions");
    const probe = buildProbePacket(records);
    // Three probes, 250 ms apart, then 250 ms for any final reply.
    await wait(Math.floor(Math.random() * 250));
    for (let i = 0; i < 3; i++) {
      if (myGeneration !== generation)
        throw Error("Receiver identity conflict");
      await transmit(probe);
      await wait(250);
    }
    probing = false;
    if (myGeneration !== generation) throw Error("Start cancelled");
    started = true;
    await advertise(myGeneration);
    logs.add(
      "info",
      "mdns",
      "Broadcast AirPlay" +
        (c.raop ? " / RAOP" : "") +
        " on " +
        c.ips.length +
        " interface address(es) for " +
        c.name,
    );
    schedule(() => {
      void advertise(myGeneration).catch(() => {});
    }, 1000);
    saveConfig(c);
    setName(c.name);
    showState("Ready for AirPlay", "ready", "");
    hideSetup();
  } catch (e) {
    if (myGeneration === generation) {
      logs.add("error", "app", "Start failed: " + String(e?.message ?? e));
      started = false;
      probing = false;
      generation++;
      cancelTimers();
      await closeSocket();
      records = null;
      showState("Not connected", "error", "Reopen the receiver to try again.");
      showSetup(messageFor(e));
    }
  } finally {
    busy = false;
    $("connectButton").disabled = false;
    $("connectButton").textContent = "Apply";
  }
}

$("setupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void start();
});
window.addEventListener("online", () => {
  if (started) {
    const token = generation;
    void advertise(token).catch(() => {});
  }
});

window.addEventListener("pagehide", () => {
  if (started && writer && records) {
    // Best-effort on page unload. Chrome may terminate the page before writes finish.
    for (const packet of buildAnnouncementPackets(records, { goodbye: true })) {
      void writer
        .write({
          data: packet,
          remoteAddress: MDNS_ADDRESS,
          remotePort: MDNS_PORT,
        })
        .catch(() => {});
    }
  }
  started = false;
  probing = false;
  generation++;
  cancelTimers();
});

async function boot() {
  const detected = await detectLanAddress();
  const configured = Boolean(
    (Array.isArray(device.ips) && device.ips.length) || device.ip,
  );
  if (configured && detected) {
    $("deviceName").value = device.name;
    await start();
  } else showSetup();
}

void boot(); // showtime

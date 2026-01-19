const $ = (id) => document.getElementById(id);

/* =========================================================
   Loader: ensure command_builder.js is available
   ========================================================= */

function ensureCommandBuilderLoaded(done) {
  if (window.CommandBuilder && typeof window.CommandBuilder.generateStandalone === "function") {
    done();
    return;
  }

  // Load once
  if (document.querySelector('script[data-solace-builder="command_builder"]')) {
    const existing = document.querySelector('script[data-solace-builder="command_builder"]');
    existing.addEventListener("load", () => done(), { once: true });
    return;
  }

  const s = document.createElement("script");
  s.src = "command_builder.js";
  s.defer = true;
  s.setAttribute("data-solace-builder", "command_builder");
  s.addEventListener("load", () => done(), { once: true });
  document.head.appendChild(s);
}

/* =========================================================
   CSP-safe actions (Copy / Download) and other button wiring
   ========================================================= */

async function copyOut(preId) {
  const el = document.getElementById(preId);
  const text = (el && el.innerText) ? el.innerText : "";
  if (!text) return;

  // Prefer Clipboard API; fallback to execCommand for older contexts.
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) {
    // fall through
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (_) {}
  ta.remove();
}

function downloadOut(preId, filename) {
  const el = document.getElementById(preId);
  const text = (el && el.innerText) ? el.innerText : "";

  // Heuristic: Compose outputs are YAML; run commands are plain text.
  const isCompose = String(preId || "").startsWith("compose-");
  const mime = isCompose ? "text/yaml;charset=utf-8" : "text/plain;charset=utf-8";
  const blob = new Blob([text], { type: mime });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || (isCompose ? "docker-compose.yml" : "command.txt");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initCspActionHandlers() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");
    const target = btn.getAttribute("data-target") || "";
    const filename = btn.getAttribute("data-filename") || "";

    switch (action) {
      case "copy-out":
        copyOut(target);
        break;
      case "download-out":
        downloadOut(target, filename);
        break;
      default:
        break;
    }
  });
}

// HA-only ports (must be grouped with other -p args, and HA only)
const HA_PORT_BINDINGS = [
  { port: 8741, proto: "tcp" },
  { port: 8300, proto: "tcp" },
  { port: 8301, proto: "tcp" },
  { port: 8301, proto: "udp" },
  { port: 8302, proto: "tcp" },
  { port: 8302, proto: "udp" }
];

/* =========================================================
   Common helpers
   ========================================================= */

function isMacos() {
  return ($("macos")?.value || "no").trim() === "yes";
}

function runtimeIsPodman() {
  return ($("runtime")?.value || "docker").trim() === "podman";
}

function splitEnvString(raw) {
  return String(raw || "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const IMAGE_PATH_STANDARD = "docker.io/solace/solace-pubsub-standard";
const IMAGE_PATH_ENTERPRISE = "solace-pubsub-enterprise";

/* =========================================================
   Scaling params textarea syncing (max spool usage)
   ========================================================= */
function updateScalingEnvVar(key, value) {
  const ta = $("scaling_params");
  if (!ta) return;

  let s = String(ta.value || "").trim();

  // Replace existing occurrence anywhere in the string:
  // matches: --env <key>=<non-space>
  const re = new RegExp(`(^|\\s)--env\\s+${key}=([^\\s]+)`, "g");

  if (re.test(s)) {
    // reset lastIndex and replace
    re.lastIndex = 0;
    s = s.replace(re, `$1--env ${key}=${value}`);
  } else {
    // Append, maintaining your whitespace-delimited baseline style
    s = s ? `${s} --env ${key}=${value}` : `--env ${key}=${value}`;
  }

  ta.value = s;
}

function removeScalingEnvVar(key) {
  const ta = $("scaling_params");
  if (!ta) return;

  let s = String(ta.value || "");

  // Remove any: --env <key>=<non-space>, including its leading whitespace (if any)
  const re = new RegExp(`(^|\\s)--env\\s+${key}=([^\\s]+)`, "g");
  s = s.replace(re, "");

  // Normalize whitespace back to single spaces
  s = s.replace(/\s+/g, " ").trim();

  ta.value = s;
}

function setBadgeText(badgeId, text) {
  const b = $(badgeId);
  if (b) b.textContent = text;
}

/* =========================================================
   Scaling limits by software edition (Stage 1: logic only)
   ========================================================= */

const STANDARD_SCALING_LIMITS = {
  system_scaling_maxconnectioncount: 1000,
  system_scaling_maxqueuemessagecount: 240,
  system_scaling_maxkafkabrokerconnectioncount: 10000,
  system_scaling_maxbridgecount: 25,
  system_scaling_maxsubscriptioncount: 500000,
  system_scaling_maxguaranteedmessagesize: 30,
};

// Max spool usage is entered in GB in the UI (converted to MB in scaling_params)
const STANDARD_MAX_SPOOL_GB = 800;
const ENTERPRISE_MAX_SPOOL_GB = 6000;

let _standardScalingLimitExceededOnce = false;

/**
 * Marks that the user attempted to exceed a Standard Edition limit.
 * Returns true only the first time per page load.
 */
function noteStandardLimitExceededOnce() {
  if (_standardScalingLimitExceededOnce) return false;
  _standardScalingLimitExceededOnce = true;
  return true;
}

function enableEnterpriseLabelsOnce() {
  document.body.classList.add("show-enterprise-labels");
}

function getSoftwareEdition() {
  return ($("software_edition")?.value || "standard").trim();
}

function isStandardEdition() {
  return getSoftwareEdition() !== "enterprise";
}

function getAllowedIndexForStandard(cfg) {
  const limit = STANDARD_SCALING_LIMITS[cfg.key];
  if (typeof limit !== "number") return null;

  // Choose the highest stop <= limit (handles cases where limit is between stops)
  let allowed = 0;
  for (let i = 0; i < cfg.values.length; i++) {
    if (cfg.values[i] <= limit) allowed = i;
  }
  return allowed;
}

const SCALING_SLIDERS = [
    { sliderId: "sp_maxconnections",   badgeId: "badge_maxconnections",   key: "system_scaling_maxconnectioncount",            values: [100, 1000, 10000, 100000, 200000], labels: ["100","1,000","10,000","100,000","200,000"] },
    { sliderId: "sp_maxqueuemsg",      badgeId: "badge_maxqueuemsg",      key: "system_scaling_maxqueuemessagecount",         values: [100, 240, 3000],                    labels: ["100M","240M","3000M"] },
    { sliderId: "sp_maxkafkabridges",  badgeId: "badge_maxkafkabridges",  key: "system_scaling_maxkafkabridgecount",          values: [0, 10, 50, 200],                     labels: ["0","10","50","200"] },
    { sliderId: "sp_maxkafkabrokerconns", badgeId: "badge_maxkafkabrokerconns", key: "system_scaling_maxkafkabrokerconnectioncount", values: [0, 300, 2000, 10000], labels: ["0","300","2,000","10,000"] },
    { sliderId: "sp_maxbridges",       badgeId: "badge_maxbridges",       key: "system_scaling_maxbridgecount",               values: [25, 500, 5000],                      labels: ["25","500","5,000"] },
    { sliderId: "sp_maxsubs",          badgeId: "badge_maxsubs",          key: "system_scaling_maxsubscriptioncount",         values: [50000, 500000, 5000000],             labels: ["50,000","500,000","5,000,000"] },
    { sliderId: "sp_maxgmsize",        badgeId: "badge_maxgmsize",        key: "system_scaling_maxguaranteedmessagesize",     values: [10, 30],                             labels: ["10","30"] },
  ];

function setEnterpriseTrackCueForSliderOLD(slider, cfg, allowedIdx) {
  const wrap = slider.closest(".scaling-track-wrap");
  if (!wrap) return;

  const maxIdx = cfg.values.length - 1;

  // Enterprise selected OR no standard limit -> no special zone, no marker
  if (!isStandardEdition() || allowedIdx === null || allowedIdx >= maxIdx) {
    wrap.style.setProperty("--std-cutoff", "100%");
    wrap.style.setProperty("--std-cutoff-px", "0px");
    wrap.style.setProperty("--show-cutoff", "0");
    wrap.style.setProperty("--marker-opacity", "0");
    wrap.style.setProperty("--marker-on", "0");
    wrap.style.setProperty("--marker", "0");
    wrap.style.setProperty("--markerVisible", "0");
    wrap.style.setProperty("--cutoff-visible", "0");
    wrap.style.setProperty("--cutoff-opacity", "0");
    wrap.style.setProperty("--cutoff", "100%");
    wrap.style.setProperty("--cutoff-marker", "0");
    wrap.style.setProperty("--cutoff-marker-opacity", "0");
    wrap.style.setProperty("--cutoffMarker", "0");
    // use the ::after opacity directly
    wrap.style.setProperty("--after-opacity", "0");
    wrap.style.setProperty("--marker", "0");
    wrap.style.setProperty("--markerOpacity", "0");
    wrap.style.setProperty("--markerOn", "0");
    wrap.style.setProperty("--marker-on", "0");
    wrap.style.setProperty("--marker_opacity", "0");
    wrap.style.setProperty("--marker-on", "0");
    wrap.style.setProperty("--markerOpacity", "0");
    wrap.style.setProperty("--markervisible", "0");
    wrap.style.setProperty("--markerVisible", "0");
    wrap.style.setProperty("--marker-opacity", "0");
    wrap.style.setProperty("--marker", "0");
    wrap.style.setProperty("--markerOn", "0");
    wrap.style.setProperty("--marker-on", "0");
    wrap.style.setProperty("--markeropacity", "0");
    wrap.style.setProperty("--marker_visible", "0");
    wrap.style.setProperty("--marker", "0");
    wrap.style.setProperty("--marker", "0");
    wrap.style.setProperty("--marker", "0");
    // simplest: directly control ::after via inline style using CSS var + class:
    wrap.classList.remove("has-cutoff-marker");
    return;
  }

  const pct = (allowedIdx / maxIdx) * 100;
  wrap.style.setProperty("--std-cutoff", `${pct}%`);

  // Convert to px so ::after can position precisely inside the left/right padding
  const leftPad = 10;
  const rightPad = 10;
  const rect = wrap.getBoundingClientRect();
  const usable = Math.max(0, rect.width - leftPad - rightPad);
  const px = leftPad + (usable * (pct / 100));

  wrap.style.setProperty("--std-cutoff-px", `${px}px`);
  wrap.classList.add("has-cutoff-marker");
}


function setEnterpriseTrackCueForSlider(slider, cfg, allowedIdx) {
  const wrap = slider.closest(".scaling-track-wrap");
  if (!wrap) return;

  const maxIdx = cfg.values.length - 1;

  // Enterprise selected OR no standard limit -> no special zone/marker/label
  if (!isStandardEdition() || allowedIdx === null || allowedIdx >= maxIdx) {
    wrap.style.setProperty("--std-cutoff", "100%");
    wrap.classList.remove("has-cutoff-marker");
    wrap.classList.remove("has-enterprise-label");
    return;
  }

  const pct = (allowedIdx / maxIdx) * 100;
  wrap.style.setProperty("--std-cutoff", `${pct}%`);

  // Convert % to px for marker + label position inside the padded track area
  const leftPad = 10;
  const rightPad = 10;
  const rect = wrap.getBoundingClientRect();
  const usable = Math.max(0, rect.width - leftPad - rightPad);
  const px = leftPad + (usable * (pct / 100));

  wrap.style.setProperty("--std-cutoff-px", `${px}px`);

  //wrap.style.setProperty("--enterprise-label-left", `${px}px`);  
  const maxLeft = rect.width - 10; // keep within wrap padding
  wrap.style.setProperty("--enterprise-label-left", `${Math.min(px, maxLeft)}px`);

  wrap.classList.add("has-cutoff-marker");
  wrap.classList.add("has-enterprise-label");
}

function attachScalingSliderHandlers() {
  // NOTE: these IDs must match your existing HTML.
  

  SCALING_SLIDERS.forEach(cfg => {
    const slider = $(cfg.sliderId);
    if (!slider) return;

    const apply = () => {
      let idx = Math.max(0, Math.min(cfg.values.length - 1, parseInt(slider.value, 10) || 0));

      let allowedIdx = null;
	  
      if (isStandardEdition()) {
        allowedIdx = getAllowedIndexForStandard(cfg);
        if (allowedIdx !== null && idx > allowedIdx) {
          // User attempted to exceed a Standard Edition limit -> snap back
          if (noteStandardLimitExceededOnce()) {
              setCalloutVisible("scaling_limit_note", true);
			  enableEnterpriseLabelsOnce(); // <- show Enterprise labels after first exceed attempt
          }
          idx = allowedIdx;
          slider.value = String(idx);
        }
      }
	  
	  setEnterpriseTrackCueForSlider(slider, cfg, allowedIdx);

      setBadgeText(cfg.badgeId, cfg.labels[idx]);
      updateScalingEnvVar(cfg.key, cfg.values[idx]);
      build();
    };

    slider._applyScaling = apply;
    slider.addEventListener("input", apply);
    slider.addEventListener("change", apply);
  });
}


function enforceEditionScalingLimits() {
  // Clamp all scaling sliders (and their textarea envs) when switching editions.
  if (typeof SCALING_SLIDERS === "undefined") return;

  SCALING_SLIDERS.forEach(cfg => {
    const slider = $(cfg.sliderId);
    if (!slider) return;

    let idx = Math.max(0, Math.min(cfg.values.length - 1, parseInt(slider.value, 10) || 0));

    if (isStandardEdition()) {
      const allowedIdx = getAllowedIndexForStandard(cfg);
      if (allowedIdx !== null && cfg.values[idx] > STANDARD_SCALING_LIMITS[cfg.key]) {
        if (noteStandardLimitExceededOnce()) {
			setCalloutVisible("scaling_limit_note", true);
			enableEnterpriseLabelsOnce(); // <- show Enterprise labels after first exceed attempt
        }
        idx = allowedIdx;
        slider.value = String(idx);
      }
    }

    // Apply badge + textarea sync for the (possibly clamped) idx
    setBadgeText(cfg.badgeId, cfg.labels[idx]);
    updateScalingEnvVar(cfg.key, cfg.values[idx]);
  });

  // Clamp max spool usage input (GB) based on edition
  const spool = $("max_spool_usage_gb");
  if (spool) {
    const raw = String(spool.value ?? "").trim();
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const maxGb = isStandardEdition() ? STANDARD_MAX_SPOOL_GB : ENTERPRISE_MAX_SPOOL_GB;
      if (n > maxGb) {
        if (noteStandardLimitExceededOnce()) {
			setCalloutVisible("scaling_limit_note", true);
			enableEnterpriseLabelsOnce(); // <- show Enterprise labels after first exceed attempt
        }
        spool.value = String(maxGb);
        syncTextareaFromMaxSpoolUsage();
      }
    }
  }
}

function syncMaxSpoolUsageFromTextarea() {
  const ta = $("scaling_params");
  const input = $("max_spool_usage_gb");
  if (!ta || !input) return;

  const m = String(ta.value || "").match(/--env\s+messagespool_maxspoolusage=(\d+)/);
  if (m && m[1]) {
    const mb = parseInt(m[1], 10);
    input.value = String(mb / 1000);
  } else {
    input.value = "0";
  }
}

function syncTextareaFromMaxSpoolUsage() {
  const input = $("max_spool_usage_gb");
  if (!input) return;

  const raw = String(input.value ?? "").trim();
  if (raw === "") {
    input.value = "0";
    removeScalingEnvVar("messagespool_maxspoolusage");
    return;
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) {
    input.value = "0";
    removeScalingEnvVar("messagespool_maxspoolusage");
    return;
  }

  const maxGb = isStandardEdition() ? STANDARD_MAX_SPOOL_GB : ENTERPRISE_MAX_SPOOL_GB;
  const gb = Math.min(maxGb, Math.max(0, n));

  if (isStandardEdition() && n > maxGb) {
    if (noteStandardLimitExceededOnce()) {
      // Stage 2 will show an "Important Note" callout here.
    }
  }

  if (gb !== n) input.value = String(gb);

  if (gb === 0) {
    removeScalingEnvVar("messagespool_maxspoolusage");
  } else {
    updateScalingEnvVar("messagespool_maxspoolusage", Math.round(gb * 1000));
  }
}

/* =========================================================
   Ports selection UI
   ========================================================= */

function setPortChecked(port, checked) {
  document.querySelectorAll(`input[type="checkbox"][data-port="${port}"]`).forEach((cb) => {
    cb.checked = checked;
  });
}

function clearPorts() {
  document.querySelectorAll('input[type="checkbox"][data-port]').forEach((cb) => (cb.checked = false));
  document.querySelectorAll(".ports-btn-toggle").forEach((btn) => setProtocolButtonLabel(btn));
  build();
}

function recommendedPorts() {
	// "55555", "55443", "9000", "9443", "8080", "1943", "2222", "8008", "1443"
  const recommended = [55555, 55443, 9000, 9443, 8080, 1943, 8008, 1443, 2222];
  document.querySelectorAll('input[type="checkbox"][data-port]').forEach((cb) => {
    const p = parseInt(cb.getAttribute("data-port"), 10);
    cb.checked = recommended.includes(p);
  });
  document.querySelectorAll(".ports-btn-toggle").forEach((btn) => setProtocolButtonLabel(btn));
  build();
}

function tlsOnlyPorts() {
  document.querySelectorAll(".ports-table tr").forEach((row) => {
    const labelCell = row.querySelector(".ports-label");
    const checkbox = row.querySelector('input[type="checkbox"][data-port]');
    if (!labelCell || !checkbox) return;

    if ((labelCell.textContent || "").includes("(Plain)")) {
      checkbox.checked = false;
    }
  });
  document.querySelectorAll(".ports-btn-toggle").forEach((btn) => setProtocolButtonLabel(btn));
  build();
}

function setProtocolButtonLabel(btn) {
  const portsStr = btn.getAttribute("data-toggle-ports") || "";
  const ports = portsStr
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (!ports.length) return;

  const anyUnchecked = ports.some((p) => {
    const cb = document.querySelector(`input[type="checkbox"][data-port="${p}"]`);
    return cb && !cb.checked;
  });

  btn.textContent = anyUnchecked ? "Select all" : "Clear all";
}

function toggleProtocolFromAttr(btn) {
  const portsStr = btn.getAttribute("data-toggle-ports") || "";
  const ports = portsStr
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (!ports.length) return;

  const anyUnchecked = ports.some((p) => {
    const cb = document.querySelector(`input[type="checkbox"][data-port="${p}"]`);
    return cb && !cb.checked;
  });

  ports.forEach((p) => setPortChecked(p, anyUnchecked));
  setProtocolButtonLabel(btn);
  build();
}

/* =========================================================
   Callouts / visibility
   ========================================================= */

function setCalloutVisible(id, visible) {
  const el = $(id);
  if (!el) return;

  if (visible) {
    el.classList.remove("callout-hidden");
    el.setAttribute("aria-hidden", "false");
  } else {
    el.classList.add("callout-hidden");
    el.setAttribute("aria-hidden", "true");
  }
}

function setFadedSectionVisible(id, visible) {
  const el = $(id);
  if (!el) return;
  if (visible) el.classList.remove("fade-hidden");
  else el.classList.add("fade-hidden");
}

function syncRuntimeNetworkConstraints() {
  // slirp4netns only valid with podman
  const runtime = ($("runtime")?.value || "docker").trim();
  const net = $("network_mode");
  if (!net) return;

  const slirpOption = Array.from(net.options).find((o) => o.value === "slirp4netns");
  if (slirpOption) slirpOption.disabled = runtime !== "podman";

  // macOS disables host networking
  const hostOption = Array.from(net.options).find((o) => o.value === "host");
  if (hostOption) hostOption.disabled = isMacos();
  if (isMacos() && net.value === "host") net.value = "bridge";
}

function syncMacosUi() {
  setCalloutVisible("macos_note", isMacos());
}

function syncSoftwareEditionUi() {
  const edition = ($("software_edition")?.value || "standard").trim();
  
  setCalloutVisible("enterprise_note", edition === "enterprise");
  
  const img = $("image_path");
  if (!img) return;

  // Only auto-switch if the image path is currently one of our known defaults
  const cur = (img.value || "").trim();
  const isKnownDefault = (cur === IMAGE_PATH_STANDARD || cur === IMAGE_PATH_ENTERPRISE);

  if (!isKnownDefault) return;

  img.value = (edition === "enterprise") ? IMAGE_PATH_ENTERPRISE : IMAGE_PATH_STANDARD;
}

function syncStorageTipVisibility() {
  const net = ($("network_mode")?.value || "bridge").trim();
  setCalloutVisible("storage_tip_podman_slirp", runtimeIsPodman() && net === "slirp4netns");
}

function syncEncryptedPasswordNoteVisibility() {
  const method = ($("password_method")?.value || "").trim();
  setCalloutVisible("pw_encrypted_note", method === "encrypted_password");
}

function syncPortsSectionVisibility() {
  const net = ($("network_mode")?.value || "bridge").trim();
  setFadedSectionVisible("ports_wrap", net !== "host");
}

/* =========================================================
   HA pre-shared key + UI
   ========================================================= */

function generateHaPsk(targetLength) {
  const valueEl = $("ha_psk_value");
  if (!valueEl) return;

  const minLen = 44;
  const maxLen = 344;

  let length;
  if (Number.isFinite(targetLength)) {
    length = Math.max(minLen, Math.min(maxLen, Math.floor(targetLength)));
  } else {
    length = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
  }

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);

  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[buf[i] % chars.length];
  }

  valueEl.value = out;
}

function syncHaPskModeUi() {
  const mode = ($("ha_psk_mode")?.value || "direct").trim();
  const row = $("ha_psk_file_row");
  if (!row) return;
  row.style.display = mode === "file" ? "" : "none";
}

/* =========================================================
   Dark mode
   ========================================================= */

function setDarkMode(on) {
  document.body.classList.toggle("dark", !!on);

  const btn = $("dark_mode_toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("is-on", !!on);
    btn.textContent = on ? "Light mode" : "Dark mode";
  }
}

function initDarkMode() {
  const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  setDarkMode(!!mq?.matches);

  $("dark_mode_toggle")?.addEventListener("click", () => {
    setDarkMode(!document.body.classList.contains("dark"));
  });

  mq?.addEventListener?.("change", (e) => setDarkMode(!!e.matches));
}

/* =========================================================
   Output generation (delegated to CommandBuilder)
   ========================================================= */
   
   
   
   
   
   
   
   
   
   //////////////////////////////////////////////////////////////

function build() {
  syncRuntimeNetworkConstraints();
  syncPortsSectionVisibility();
  syncMacosUi();
  syncSoftwareEditionUi();
  syncStorageTipVisibility();
  syncEncryptedPasswordNoteVisibility();
  syncHaPskModeUi();

  const mode = ($("mode")?.value || "standalone").trim();
  const fmt = ($("output_format")?.value || "run").trim();
  const isHA = mode === "ha";

  $("standalone_section").style.display = isHA ? "none" : "";
  $("ha_section").style.display = isHA ? "" : "none";

  $("run_outputs").style.display = fmt === "run" ? "" : "none";
  $("compose_outputs").style.display = fmt === "compose" ? "" : "none";

  $("out-standalone").style.display = isHA ? "none" : "";
  $("out-primary").style.display = isHA ? "" : "none";
  $("out-backup").style.display = isHA ? "" : "none";
  $("out-monitor").style.display = isHA ? "" : "none";

  $("compose-out-standalone").style.display = isHA ? "none" : "";
  $("compose-out-primary").style.display = isHA ? "" : "none";
  $("compose-out-backup").style.display = isHA ? "" : "none";
  $("compose-out-monitor").style.display = isHA ? "" : "none";

  setCalloutVisible("ha-post-deploy-tips", isHA);

  document.querySelectorAll(".ports-btn-toggle").forEach((btn) => setProtocolButtonLabel(btn));

  if (!window.CommandBuilder) return;

  if (fmt === "run") {
    if (!isHA) {
      $("output").innerText = window.CommandBuilder.generateStandalone();
    } else {
      $("output-primary").innerText = window.CommandBuilder.generateHANode("primary");
      $("output-backup").innerText = window.CommandBuilder.generateHANode("backup");
      $("output-monitor").innerText = window.CommandBuilder.generateHANode("monitor");
    }
  } else {
    if (!isHA) {
      $("compose-standalone").innerText = window.CommandBuilder.generateComposeStandalone();
    } else {
      $("compose-primary").innerText = window.CommandBuilder.generateComposeHANode("primary");
      $("compose-backup").innerText = window.CommandBuilder.generateComposeHANode("backup");
      $("compose-monitor").innerText = window.CommandBuilder.generateComposeHANode("monitor");
    }
  }
}

/* =========================================================
   Init
   ========================================================= */

function initOnceBuilderReady() {
  initDarkMode();
  initCspActionHandlers();
  
  recommendedPorts();
  generateHaPsk(60);

  attachScalingSliderHandlers();
  syncMaxSpoolUsageFromTextarea();

  document.querySelectorAll("input,select,textarea").forEach((el) => {
    el.addEventListener("input", () => {
      if (el.id === "max_spool_usage_gb") syncTextareaFromMaxSpoolUsage();
      if (el.id === "scaling_params") syncMaxSpoolUsageFromTextarea();
      build();
    });
    el.addEventListener("change", () => {
      if (el.id === "max_spool_usage_gb") syncTextareaFromMaxSpoolUsage();
      if (el.id === "scaling_params") syncMaxSpoolUsageFromTextarea();
      build();
    });
    if (el.id === "max_spool_usage_gb") {
      el.addEventListener("blur", () => {
        syncTextareaFromMaxSpoolUsage();
        build();
      });
    }
  });

  document.querySelectorAll(".ports-btn-toggle").forEach((btn) => {
    btn.addEventListener("click", () => toggleProtocolFromAttr(btn));
  });

  document.querySelector("[data-action='clear-ports']")?.addEventListener("click", clearPorts);
  document.querySelector("[data-action='recommended-ports']")?.addEventListener("click", recommendedPorts);
  document.querySelector("[data-action='tls-only-ports']")?.addEventListener("click", tlsOnlyPorts);

  $("ha_psk_mode")?.addEventListener("change", () => {
    syncHaPskModeUi();
    build();
  });

  $("output_format")?.addEventListener("change", build);

  $("software_edition")?.addEventListener("change", () => {
    // Repaint all tracks based on the selected edition
    SCALING_SLIDERS.forEach(cfg => {
      const slider = $(cfg.sliderId);
      if (!slider) return;

      // Re-run clamp + badge + env update
      if (typeof slider._applyScaling === "function") {
        slider._applyScaling();
      }
	  
	  enforceEditionScalingLimits();
	
      const allowedIdx = isStandardEdition() ? getAllowedIndexForStandard(cfg) : null;
      setEnterpriseTrackCueForSlider(slider, cfg, allowedIdx);
    });
  });

  window.addEventListener("resize", () => {
    SCALING_SLIDERS.forEach(cfg => {
      const slider = $(cfg.sliderId);
      if (!slider) return;
      const allowedIdx = isStandardEdition() ? getAllowedIndexForStandard(cfg) : null;
      setEnterpriseTrackCueForSlider(slider, cfg, allowedIdx);
    });
  });

  build();
}

document.addEventListener("DOMContentLoaded", () => {
  ensureCommandBuilderLoaded(() => {
    initOnceBuilderReady();
  });
});

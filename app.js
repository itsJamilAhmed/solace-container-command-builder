const $ = id => document.getElementById(id);
const WRAP_AT = 95;

// HA-only ports (must be grouped with other -p args, and HA only)
const HA_PORT_BINDINGS = [
  { port: 8741, proto: "tcp" },
  { port: 8300, proto: "tcp" },
  { port: 8301, proto: "tcp" },
  { port: 8301, proto: "udp" },
  { port: 8302, proto: "tcp" },
  { port: 8302, proto: "udp" }
];

function isMacos() {
  return ($("macos")?.value || "no").trim() === "yes";
}

function splitEnvString(str) {
  if (!str) return [];
  return str.split(/\s+(?=--env)/).map(s => s.trim()).filter(Boolean);
}

function wrapWithImageLast(args, imageArg) {
  const FORCE_NEWLINE_PREFIXES = [
    "--name=",
    "--env nodetype=monitoring",
    "--env redundancy_activestandbyrole=active",
    "--env redundancy_activestandbyrole=backup"
  ];

  let out = "";
  let line = "";

  for (const arg of args) {
    const forceNewLine = FORCE_NEWLINE_PREFIXES.some(prefix => arg.startsWith(prefix));

    if (forceNewLine) {
      if (line.trim()) {
        out += line.trim() + " \\\n  ";
        line = "";
      }
      out += arg + " \\\n  ";
      continue;
    }

    if ((line + arg).length > WRAP_AT) {
      out += line.trim() + " \\\n  ";
      line = "";
    }
    line += arg + " ";
  }

  out += line.trim();

  if (out.trim().length > 0) {
    return `${out} \\\n  ${imageArg}`;
  }
  return `${imageArg}`;
}

/* ---------- preshared key helper ---------- */
function generateHaPsk(targetLength) {
  const valueEl = document.getElementById("ha_psk_value");
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
  window.crypto.getRandomValues(buf);

  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[buf[i] % chars.length];
  }

  valueEl.value = out;

  if (typeof build === "function") build();
}
window.generateHaPsk = generateHaPsk;

/* ---------- port helpers ---------- */

function addHaPorts(args) {
  HA_PORT_BINDINGS.forEach(({ port, proto }) => {
    if (proto === "tcp") {
      args.push(`-p ${port}:${port}`);
    } else {
      args.push(`-p ${port}:${port}/${proto}`);
    }
  });
}

function getSelectedPorts() {
  const ports = [];
  document.querySelectorAll("[data-port]:checked").forEach(cb => {
    ports.push(cb.dataset.port);
  });
  return [...new Set(ports)];
}

function clearPorts() {
  document.querySelectorAll("[data-port]").forEach(cb => (cb.checked = false));
  build();
}

function recommendedPorts() {
  clearPorts();
  ["55555", "55443", "9000", "9443", "8080", "1943", "2222", "8008", "1443"].forEach(p => {
    const cb = document.querySelector(`[data-port="${p}"]`);
    if (cb) cb.checked = true;
  });
  build();
}

function setProtocolButtonLabel(btn, ports) {
  const boxes = ports
    .map(p => document.querySelector(`[data-port="${p}"]`))
    .filter(Boolean);
  const allChecked = boxes.length > 0 && boxes.every(b => b.checked);
  btn.textContent = allChecked ? "Clear" : "Select all";
}

function toggleProtocolFromAttr(btn) {
  const ports = (btn.dataset.togglePorts || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const boxes = ports
    .map(p => document.querySelector(`[data-port="${p}"]`))
    .filter(Boolean);

  const enable = boxes.some(b => !b.checked);
  boxes.forEach(b => (b.checked = enable));

  setProtocolButtonLabel(btn, ports);
  build();
}

window.clearPorts = clearPorts;
window.recommendedPorts = recommendedPorts;
window.toggleProtocolFromAttr = toggleProtocolFromAttr;

/* ---------- TLS server cert helpers ---------- */

function tlsServerCertArgs() {
  const certPath = (document.getElementById("tls_servercertificate_filepath")?.value || "").trim();
  const passPath = (document.getElementById("tls_servercertificate_passphrasefilepath")?.value || "").trim();

  const args = [];
  if (certPath) args.push(`--env tls_servercertificate_filepath=${certPath}`);
  if (passPath) args.push(`--env tls_servercertificate_passphrasefilepath=${passPath}`);
  return args;
}

/* ---------- UI sync helpers ---------- */

function setCalloutVisible(el, visible) {
  if (!el) return;
  el.classList.toggle("callout-hidden", !visible);
  el.setAttribute("aria-hidden", visible ? "false" : "true");
}

/* NEW: macos note + disable host mode */
function syncMacosUi() {
  const mac = isMacos();
  const note = $("macos_note");
  setCalloutVisible(note, mac);

  const netSel = $("network_mode");
  const hostOpt = netSel?.querySelector('option[value="host"]');

  if (hostOpt) {
    hostOpt.disabled = mac;
  }

  // If MacOS is yes, host mode cannot be selected; force bridge if currently host
  if (mac && netSel && netSel.value === "host") {
    netSel.value = "bridge";
  }
}

/* NEW: storage tip only for podman + slirp4netns */
function syncStorageTipVisibility() {
  const tip = $("storage_tip_podman_slirp");
  const runtime = ($("runtime")?.value || "").trim();
  const net = ($("network_mode")?.value || "").trim();
  setCalloutVisible(tip, runtime === "podman" && net === "slirp4netns");
}

/* NEW: hide protocols section when host network mode selected */
function syncPortsSectionVisibility() {
  const portsSection = $("ports_section");
  const net = ($("network_mode")?.value || "").trim();
  if (!portsSection) return;
  portsSection.style.display = (net === "host") ? "none" : "block";
}

/* ---------- shared args (run commands) ---------- */

function buildBaseArgs(isHA) {
  const args = [];

  args.push(`${$("runtime").value} run -d`);

  if ($("uid").value) {
    args.push(`--user ${$("uid").value}`);
  }

  const netMode = ($("network_mode")?.value || "bridge").trim();

  // Port mappings are not needed for host mode
  if (netMode !== "host") {
    for (const p of getSelectedPorts()) {
      // MacOS special case: map host 55554 -> container 55555
      if (isMacos() && p === "55555") {
        args.push(`-p 55554:55555`);
      } else {
        args.push(`-p ${p}:${p}`);
      }
    }
    if (isHA) {
      addHaPorts(args);
    }
  } else {
    // still include HA node ports? no, host networking implies direct host ports, no -p
    // (and you are hiding protocols section anyway)
  }

  args.push(`--net ${netMode}`);

  if ($("storage_path").value) {
    args.push(`--mount type=bind,source=${$("storage_path").value},target=/var/lib/solace`);
  }

  const method = $("password_method").value;
  const value = ($("pw_value")?.value || "").trim();

  if (value) {
    args.push(`--env username_admin_${method}=${value}`);
    args.push(`--env username_admin_globalaccesslevel=admin`);
  }

  splitEnvString($("scaling_params").value).forEach(e => args.push(e));

  if (isHA) {
    args.push(`--env configsync_enable=yes`);
  }

  return args;
}

function imageRef() {
  return `${$("image_path").value}:${$("image_version").value}`;
}

/* ---------- standalone (run command) ---------- */

function generateStandalone() {
  const args = buildBaseArgs(false);

  tlsServerCertArgs().forEach(a => args.push(a));

  args.push(`--name=${$("standalone_name").value}`);
  args.push(`--env routername=${$("standalone_name").value}`);

  if ($("restart_policy").value) {
    args.push(`--restart=${$("restart_policy").value}`);
  }

  return wrapWithImageLast(args, imageRef());
}

/* ---------- HA (run commands) ---------- */

function haNodes() {
  return {
    primary: { name: $("ha_primary_name").value, host: $("ha_primary_host").value },
    backup: { name: $("ha_backup_name").value, host: $("ha_backup_host").value },
    monitor: { name: $("ha_monitor_name").value, host: $("ha_monitor_host").value }
  };
}

function haConnectVia(role, nodes) {
  return ["primary", "backup", "monitor"].map(
    r => `--env redundancy_group_node_${nodes[r].name}_connectvia=${nodes[r].host}`
  );
}

function haPskEnvArg() {
  const mode = (document.getElementById("ha_psk_mode")?.value || "direct").trim();
  const keyValue = (document.getElementById("ha_psk_value")?.value || "").trim();
  const filePath = (document.getElementById("ha_psk_filepath")?.value || "").trim();

  if (mode === "direct") {
    return keyValue ? `--env redundancy_authentication_presharedkey_key=${keyValue}` : "";
  }
  if (mode === "file") {
    return filePath ? `--env redundancy_authentication_presharedkey_keyfilepath=${filePath}` : "";
  }
  return "";
}

function generateHANode(role) {
  const nodes = haNodes();
  const args = buildBaseArgs(true);

  args.push(`--env redundancy_enable=true`);

  const pskArg = haPskEnvArg();
  if (pskArg) args.push(pskArg);

  haConnectVia(role, nodes).forEach(a => args.push(a));

  if (role === "primary") args.push(`--env redundancy_activestandbyrole=active`);
  if (role === "backup") args.push(`--env redundancy_activestandbyrole=backup`);
  if (role === "monitor") args.push(`--env nodetype=monitoring`);

  tlsServerCertArgs().forEach(a => args.push(a));

  args.push(`--name=${nodes[role].name}`);
  args.push(`--env routername=${nodes[role].name}`);

  if ($("restart_policy").value) {
    args.push(`--restart=${$("restart_policy").value}`);
  }

  return wrapWithImageLast(args, imageRef());
}

/* ---------------- Docker Compose generation (per-host) ---------------- */

function composeEscape(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseScalingForCompose(raw) {
  const res = {
    env: [], ulimits: [], shm_size: "", unmapped: []
  };

  if (!raw) return res;

  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === "--env") {
      const kv = tokens[i + 1];
      if (kv) { res.env.push(kv); i++; }
      else { res.unmapped.push(t); }
      continue;
    }

    if (t.startsWith("--env")) {
      const kv = t.replace(/^--env\s*/, "");
      if (kv && kv !== "--env") res.env.push(kv);
      else res.unmapped.push(t);
      continue;
    }

    if (t === "--ulimit") {
      const uv = tokens[i + 1];
      if (uv) {
        const eq = uv.indexOf("=");
        if (eq > 0) res.ulimits.push({ name: uv.slice(0, eq), value: uv.slice(eq + 1) });
        else res.unmapped.push(`--ulimit ${uv}`);
        i++;
      } else res.unmapped.push(t);
      continue;
    }

    if (t.startsWith("--shm-size=")) {
      res.shm_size = t.split("=", 2)[1] || "";
      continue;
    }

    res.unmapped.push(t);
  }

  return res;
}

function collectEnvCommon(isHA) {
  const env = [];

  const method = $("password_method").value;
  const value = ($("pw_value")?.value || "").trim();
  if (value) {
    env.push(`username_admin_${method}=${value}`);
    env.push(`username_admin_globalaccesslevel=admin`);
  }

  tlsServerCertArgs().forEach(a => {
    const kv = a.replace(/^--env\s+/, "");
    if (kv) env.push(kv);
  });

  if (isHA) env.push(`configsync_enable=yes`);

  const scaling = parseScalingForCompose($("scaling_params").value);
  scaling.env.forEach(kv => env.push(kv));

  return { env, scaling };
}

function collectPortsForCompose(isHA) {
  const bindings = [];
  const netMode = ($("network_mode")?.value || "bridge").trim();

  // Compose also does not publish ports with network_mode: host
  if (netMode === "host") return [];

  for (const p of getSelectedPorts()) {
    // MacOS special case mapping
    if (isMacos() && p === "55555") {
      bindings.push(`55554:55555`);
    } else {
      bindings.push(`${p}:${p}`);
    }
  }

  if (isHA) {
    HA_PORT_BINDINGS.forEach(({ port, proto }) => {
      bindings.push(proto === "udp" ? `${port}:${port}/udp` : `${port}:${port}`);
    });
  }

  const seen = new Set();
  return bindings.filter(b => (seen.has(b) ? false : (seen.add(b), true)));
}

function collectVolumesForCompose() {
  const vols = [];
  const sp = ($("storage_path")?.value || "").trim();
  if (sp) vols.push(`${sp}:/var/lib/solace`);
  return vols;
}

function buildComposeYaml(serviceName, spec) {
  const lines = [];
  lines.push("services:");
  lines.push(`  ${serviceName}:`);
  lines.push(`    container_name: "${composeEscape(spec.container_name)}"`);
  lines.push(`    image: "${composeEscape(spec.image)}"`);

  if (spec.restart) lines.push(`    restart: "${composeEscape(spec.restart)}"`);
  if (spec.user) lines.push(`    user: "${composeEscape(spec.user)}"`);
  if (spec.network_mode) lines.push(`    network_mode: "${composeEscape(spec.network_mode)}"`);

  if (spec.shm_size) lines.push(`    shm_size: "${composeEscape(spec.shm_size)}"`);

  if (spec.ulimits && spec.ulimits.length) {
    lines.push("    ulimits:");
    spec.ulimits.forEach(u => {
      lines.push(`      ${u.name}: "${composeEscape(u.value)}"`);
    });
  }

  if (spec.network_mode === "host") {
    if (spec.ports && spec.ports.length) {
      lines.push(`    # Note: ports are omitted because network_mode: "host" conflicts with port publishing in Compose.`);
    }
  } else {
    if (spec.ports && spec.ports.length) {
      lines.push("    ports:");
      spec.ports.forEach(p => lines.push(`      - "${composeEscape(p)}"`));
    }
  }

  if (spec.volumes && spec.volumes.length) {
    lines.push("    volumes:");
    spec.volumes.forEach(v => lines.push(`      - "${composeEscape(v)}"`));
  }

  if (spec.environment && spec.environment.length) {
    lines.push("    environment:");
    spec.environment.forEach(e => lines.push(`      - "${composeEscape(e)}"`));
  }

  if (spec.unmapped && spec.unmapped.length) {
    lines.push("    # Unmapped docker run options from Scaling Parameters:");
    spec.unmapped.forEach(u => lines.push(`    # - ${u}`));
  }

  return lines.join("\n");
}

function generateComposeStandalone() {
  const name = $("standalone_name").value;
  const image = imageRef();

  const { env: commonEnv, scaling } = collectEnvCommon(false);
  const environment = [...commonEnv, `routername=${name}`];

  const spec = {
    container_name: name,
    image,
    restart: $("restart_policy").value || "",
    user: $("uid").value || "",
    network_mode: $("network_mode").value || "bridge",
    ports: collectPortsForCompose(false),
    volumes: collectVolumesForCompose(),
    environment,
    shm_size: scaling.shm_size,
    ulimits: scaling.ulimits,
    unmapped: scaling.unmapped
  };

  return buildComposeYaml(name, spec);
}

function generateComposeHANode(role) {
  const nodes = haNodes();
  const name = nodes[role].name;
  const image = imageRef();

  const { env: commonEnv, scaling } = collectEnvCommon(true);

  const environment = [...commonEnv, `redundancy_enable=true`];

  const pskMode = (document.getElementById("ha_psk_mode")?.value || "direct").trim();
  const keyValue = (document.getElementById("ha_psk_value")?.value || "").trim();
  const filePath = (document.getElementById("ha_psk_filepath")?.value || "").trim();
  if (pskMode === "direct" && keyValue) environment.push(`redundancy_authentication_presharedkey_key=${keyValue}`);
  else if (pskMode === "file" && filePath) environment.push(`redundancy_authentication_presharedkey_keyfilepath=${filePath}`);

  ["primary", "backup", "monitor"].forEach(r => {
    environment.push(`redundancy_group_node_${nodes[r].name}_connectvia=${nodes[r].host}`);
  });

  if (role === "primary") environment.push(`redundancy_activestandbyrole=active`);
  if (role === "backup") environment.push(`redundancy_activestandbyrole=backup`);
  if (role === "monitor") environment.push(`nodetype=monitoring`);

  environment.push(`routername=${name}`);

  const spec = {
    container_name: name,
    image,
    restart: $("restart_policy").value || "",
    user: $("uid").value || "",
    network_mode: $("network_mode").value || "bridge",
    ports: collectPortsForCompose(true),
    volumes: collectVolumesForCompose(),
    environment,
    shm_size: scaling.shm_size,
    ulimits: scaling.ulimits,
    unmapped: scaling.unmapped
  };

  return buildComposeYaml(name, spec);
}

/* ---------- build / render ---------- */

function syncHaPskModeUi() {
  const mode = document.getElementById("ha_psk_mode")?.value;
  const row = document.getElementById("ha_psk_file_row");
  if (!row) return;
  row.style.display = (mode === "file") ? "block" : "none";
}

function setHAVisibility(isHA) {
  $("standalone_section").style.display = isHA ? "none" : "block";
  $("ha_section").style.display = isHA ? "block" : "none";

  if (isHA) $("ha_section").open = true;

  $("out-standalone").style.display = isHA ? "none" : "block";
  $("out-primary").style.display = isHA ? "block" : "none";
  $("out-backup").style.display = isHA ? "block" : "none";
  $("out-monitor").style.display = isHA ? "block" : "none";

  $("compose-out-standalone").style.display = isHA ? "none" : "block";
  $("compose-out-primary").style.display = isHA ? "block" : "none";
  $("compose-out-backup").style.display = isHA ? "block" : "none";
  $("compose-out-monitor").style.display = isHA ? "block" : "none";

  setCalloutVisible($("ha-post-deploy-tips"), isHA);
}

function setOutputFormatVisibility() {
  const fmt = ($("output_format")?.value || "run").trim();
  $("run_outputs").style.display = (fmt === "run") ? "block" : "none";
  $("compose_outputs").style.display = (fmt === "compose") ? "block" : "none";
}

function build() {
  const isHA = $("mode").value === "ha";

  // NEW: MacOS note + host disable/force bridge
  syncMacosUi();

  // NEW: if host, hide protocols section
  syncPortsSectionVisibility();

  // Existing
  setHAVisibility(isHA);
  setOutputFormatVisibility();

  // Existing but now uses fade callout
  syncStorageTipVisibility();

  document.querySelectorAll(".ports-btn-toggle[data-toggle-ports]").forEach(btn => {
    const ports = btn.dataset.togglePorts.split(",").map(s => s.trim()).filter(Boolean);
    setProtocolButtonLabel(btn, ports);
  });

  if (!isHA) {
    $("output").innerText = generateStandalone();
  } else {
    $("output-primary").innerText = generateHANode("primary");
    $("output-backup").innerText = generateHANode("backup");
    $("output-monitor").innerText = generateHANode("monitor");
  }

  if (!isHA) {
    $("compose-standalone").innerText = generateComposeStandalone();
  } else {
    $("compose-primary").innerText = generateComposeHANode("primary");
    $("compose-backup").innerText = generateComposeHANode("backup");
    $("compose-monitor").innerText = generateComposeHANode("monitor");
  }
}

/* ---------- init ---------- */

document.addEventListener("DOMContentLoaded", () => {
  recommendedPorts();
  generateHaPsk(60);

  document.querySelectorAll("input,select,textarea").forEach(el => {
    el.addEventListener("input", build);
    el.addEventListener("change", build);
  });

  document.getElementById("ha_psk_mode")?.addEventListener("change", () => {
    syncHaPskModeUi();
    build();
  });
  syncHaPskModeUi();

  document.getElementById("output_format")?.addEventListener("change", build);

  build();
});

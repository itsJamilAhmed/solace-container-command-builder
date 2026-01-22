// Command generation logic extracted from the known-good builder.
// This file intentionally preserves the exact command construction, argument ordering,
// wrapping, and forced-newline behavior from "app (with correct argument builder).js".
(function (global) {
const $ = id => document.getElementById(id);
const WRAP_AT = 95;

/* NOTE: The following block is copied from your known-good builder file up to (but not including)
   its build/init section, so command construction behavior remains identical. */

function splitEnvString(raw) {
  return String(raw || "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);
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

// Ensure image arg is last. Also apply specific forced-newline rules and wrapping width behavior.
function wrapWithImageLast(args, imageArg) {
  const FORCE_NEWLINE_PREFIXES = [
    "--name=",
    "--env nodetype=monitoring",
    "--env redundancy_activestandbyrole=primary",
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

  // Remove any trailing whitespace AND any trailing "\" continuation we may have already added
  out = out.replace(/\s+$/, "");
  out = out.replace(/\\\s*$/, "");     // drop trailing backslash if present
  out = out.replace(/\s+$/, "");       // clean up any trailing space after removal

  if (out.length > 0) {
    return `${out} \\\n  ${imageArg}`;
  }
  return `${imageArg}`;
}

/* ---------- shared args (run commands) ---------- */

function isMacos() {
  return ($("macos")?.value || "no").trim() === "yes";
}

function addHaPorts(args) {
  for (const pb of HA_PORT_BINDINGS) {
    args.push(`-p ${pb.port}:${pb.port}/${pb.proto}`);
  }
}

function getSelectedPorts() {
  const out = [];
  document.querySelectorAll('input[type="checkbox"][data-port]').forEach(cb => {
    if (cb.checked) out.push(cb.getAttribute("data-port"));
  });
  out.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return out;
}

function tlsServerCertArgs() {
  const out = [];
  const cert = ($("tls_servercertificate_filepath")?.value || "").trim();
  const pass = ($("tls_servercertificate_passphrasefilepath")?.value || "").trim();

  if (cert) out.push(`--env tls_servercertificate_filepath=${cert}`);
  if (pass) out.push(`--env tls_servercertificate_passphrasefilepath=${pass}`);

  return out;
}

function moveNameArgToSecondLast(args) {
  let nameArg = null;

  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i].startsWith("--name=")) {
      nameArg = args.splice(i, 1)[0];
      break;
    }
  }

  if (nameArg) {
    args.push(nameArg);
  }
}

function imageRef() {
  return `${$("image_path").value}:${$("image_version").value}`;
}

/* ---------- standalone ---------- */

function generateStandalone() {
  // Name for standalone
  const args = [];
  args.push(`${$("runtime").value} run -d`);

  if ($("uid").value) {
    args.push(`--user ${$("uid").value}`);
  }

  const netMode = ($("network_mode")?.value || "bridge").trim();

  if (netMode !== "host") {
    for (const p of getSelectedPorts()) {
      if (isMacos() && p === "55555") args.push(`-p 55554:55555`);
      else args.push(`-p ${p}:${p}`);
    }
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

  const raw = ($("scaling_params")?.value || "").trim();
  if (raw) {
    const tokens = raw.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      if ((tokens[i] === "--env" || tokens[i] === "--ulimit") && tokens[i + 1]) {
        args.push(`${tokens[i]} ${tokens[i + 1]}`);
        i++; // skip value token
      } else {
        args.push(tokens[i]);
      }
    }
  }

  tlsServerCertArgs().forEach(a => args.push(a));

  if ($("restart_policy").value) {
    args.push(`--restart ${$("restart_policy").value}`);
  }

  args.push(`--env routername=${$("standalone_name").value}`);
  args.push(`--hostname=${$("standalone_name").value}`);
  args.push(`--name=${$("standalone_name").value}`);

  moveNameArgToSecondLast(args);
  return wrapWithImageLast(args, imageRef());
}

/* ---------- HA ---------- */

function haNodes() {
  return {
    primary: { name: $("ha_primary_name").value, host: $("ha_primary_host").value },
    backup: { name: $("ha_backup_name").value, host: $("ha_backup_host").value },
    monitor: { name: $("ha_monitor_name").value, host: $("ha_monitor_host").value }
  };
}

// Switching to every node having the awareness of the 3 connect-via to follow the documentation example.
function haConnectViaAll(nodes) {
  return [
    `--env redundancy_group_node_${nodes.primary.name}_connectvia=${nodes.primary.host}`,
    `--env redundancy_group_node_${nodes.primary.name}_nodetype=message_routing`,

    `--env redundancy_group_node_${nodes.backup.name}_connectvia=${nodes.backup.host}`,
    `--env redundancy_group_node_${nodes.backup.name}_nodetype=message_routing`,

    `--env redundancy_group_node_${nodes.monitor.name}_connectvia=${nodes.monitor.host}`,
    `--env redundancy_group_node_${nodes.monitor.name}_nodetype=monitoring`,
  ];
}

function haPskEnvArg() {
  const mode = ($("ha_psk_mode")?.value || "direct").trim();
  if (mode === "file") {
    const filePath = ($("ha_psk_filepath")?.value || "").trim();
    if (!filePath) return "";
    return `--env redundancy_authentication_presharedkey_filepath=${filePath}`;
  }
  const v = ($("ha_psk_value")?.value || "").trim();
  if (!v) return "";
  return `--env redundancy_authentication_presharedkey_key=${v}`;
}

function generateHANode(role) {
  const nodes = haNodes();
  const args = [];

  args.push(`${$("runtime").value} run -d`);

  if ($("uid").value) {
    args.push(`--user ${$("uid").value}`);
  }

  const netMode = ($("network_mode")?.value || "bridge").trim();

  if (netMode !== "host") {
    for (const p of getSelectedPorts()) {
      if (isMacos() && p === "55555") args.push(`-p 55554:55555`);
      else args.push(`-p ${p}:${p}`);
    }
    addHaPorts(args);
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
  
  args.push(`--env redundancy_enable=yes`);
  args.push(`--env configsync_enable=yes`);

  const raw = ($("scaling_params")?.value || "").trim();
  if (raw) {
    const tokens = raw.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      if ((tokens[i] === "--env" || tokens[i] === "--ulimit") && tokens[i + 1]) {
        args.push(`${tokens[i]} ${tokens[i + 1]}`);
        i++; // skip value token
      } else {
        args.push(tokens[i]);
      }
    }
  }

  const pskArg = haPskEnvArg();
  if (pskArg) args.push(pskArg);

  haConnectViaAll(nodes).forEach(a => args.push(a));

  if (role === "primary") args.push(`--env redundancy_activestandbyrole=primary`);
  if (role === "backup") args.push(`--env redundancy_activestandbyrole=backup`);
  if (role === "monitor") args.push(`--env nodetype=monitoring`);

  tlsServerCertArgs().forEach(a => args.push(a));

  if ($("restart_policy").value) {
    args.push(`--restart ${$("restart_policy").value}`);
  }

  args.push(`--env routername=${nodes[role].name}`);
  args.push(`--hostname=${nodes[role].name}`);
  args.push(`--name=${nodes[role].name}`);

  moveNameArgToSecondLast(args);
  return wrapWithImageLast(args, imageRef());
}

/* ---------- Compose generation ---------- */

function composeEscape(v) {
  const s = String(v);
  if (s === "") return '""';
  if (/^[A-Za-z0-9._/:=-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseScalingForCompose(raw) {
  const res = { env: [], ulimits: [], shm_size: "", unmapped: [] };
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

  if (netMode === "host") return [];

  for (const p of getSelectedPorts()) {
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


function collectPortsForCompose(isHA) {
  const netMode = ($("network_mode")?.value || "bridge").trim();
  if (netMode === "host") return [];

  const ports = getSelectedPorts().map(p => {
    if (isMacos() && p === "55555") return "55554:55555";
    return `${p}:${p}`;
  });

  if (isHA) {
    for (const pb of HA_PORT_BINDINGS) {
      ports.push(`${pb.port}:${pb.port}/${pb.proto}`);
    }
  }

  return ports;
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
  lines.push(`    hostname: "${composeEscape(spec.container_name)}"`);
  lines.push(`    image: "${composeEscape(spec.image)}"`);

  if (spec.restart) lines.push(`    restart: "${composeEscape(spec.restart)}"`);
  if (spec.user) lines.push(`    user: "${composeEscape(spec.user)}"`);
  if (spec.network_mode) lines.push(`    network_mode: "${composeEscape(spec.network_mode)}"`);

  if (spec.shm_size) lines.push(`    shm_size: "${composeEscape(spec.shm_size)}"`);

  if (spec.ulimits && spec.ulimits.length) {
    lines.push("    ulimits:");
    spec.ulimits.forEach(u => {
      const name = u.name;
      const raw = String(u.value ?? "").trim();

      // docker-compose expects ulimits as either an integer, or {soft,hard}.
      // Convert docker/podman "soft:hard" form into the structured form.
      if (raw.includes(":")) {
        const [softRaw, hardRaw] = raw.split(":", 2);
        const soft = Number(softRaw);
        const hard = Number(hardRaw);
        lines.push(`      ${name}:`);
        if (Number.isFinite(soft)) lines.push(`        soft: ${soft}`);
        else lines.push(`        soft: "${composeEscape(softRaw)}"`);
        if (Number.isFinite(hard)) lines.push(`        hard: ${hard}`);
        else lines.push(`        hard: "${composeEscape(hardRaw)}"`);
      } else {
        const n = Number(raw);
        if (Number.isFinite(n)) lines.push(`      ${name}: ${n}`);
        else lines.push(`      ${name}: "${composeEscape(raw)}"`);
      }
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

  const environment = [...commonEnv, `redundancy_enable=yes`];

  const pskMode = (document.getElementById("ha_psk_mode")?.value || "direct").trim();
  const keyValue = (document.getElementById("ha_psk_value")?.value || "").trim();
  const filePath = (document.getElementById("ha_psk_filepath")?.value || "").trim();
  if (pskMode === "direct" && keyValue) environment.push(`redundancy_authentication_presharedkey_key=${keyValue}`);
  else if (pskMode === "file" && filePath) environment.push(`redundancy_authentication_presharedkey_keyfilepath=${filePath}`);

  ["primary", "backup", "monitor"].forEach(r => {
    environment.push(`redundancy_group_node_${nodes[r].name}_connectvia=${nodes[r].host}`);
    environment.push(
      `redundancy_group_node_${nodes[r].name}_nodetype=${r === "monitor" ? "monitoring" : "message_routing"}`
    );
  });

  if (role === "primary") environment.push(`redundancy_activestandbyrole=primary`);
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


// Export only the generation entrypoints used by app.js.
global.CommandBuilder = {
  generateStandalone,
  generateHANode,
  generateComposeStandalone,
  generateComposeHANode,
};
})(window);

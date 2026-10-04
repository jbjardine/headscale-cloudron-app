(function () {
  "use strict";
  var ui = window.HeadscalePackage;
  var $ = function (id) { return document.getElementById(id); };
  var nodes = [], current = null, polling = false;
  function message(text, error) { $("message").textContent = text;$("message").className = "pkg-notice" + (error ? " pkg-error" : "");$("message").hidden = !text; }
  function status(data) {
    current = data;
    var state = data.status || {};
    $("connection-status").replaceChildren(ui.element("span", "pkg-badge" + (state.state === "running" ? " pkg-badge-active" : ""), state.state || "Unknown"), ui.element("span", "", state.message || ""));
    $("gateway-addresses").textContent = (state.officialIps || []).length ? "Tailscale: " + state.officialIps.join(", ") + " · Headscale: " + (state.headscaleIps || []).join(", ") : "No gateway address.";
    $("key-state").textContent = data.hasOfficialKey ? "Key saved. Leave blank to keep it." : "No key saved.";
    var ports = data.settings.rules.map(function (rule) { return "tcp:" + rule.listenPort; });
    $("grant-example").textContent = JSON.stringify({ grants: [{ src: ["tag:cloud-dev"], dst: ["tag:headscale-gateway"], ip: ports.length ? ports : ["tcp:1445"] }] }, null, 2);
  }
  function input(label, type, value, min, max) {
    var wrap = ui.element("div"), field = ui.element("input");
    field.type = type;field.value = value;field.required = true;if (min !== undefined) field.min = min;if (max !== undefined) field.max = max;
    var caption = ui.element("label", "", label);caption.appendChild(field);wrap.appendChild(caption);
    return { wrap: wrap, field: field };
  }
  function unusedListenPort() {
    var used = new Set(Array.from(document.querySelectorAll(".rule-listen-port")).map(function (field) { return Number(field.value); }));
    for (var port = 1445; port <= 65535; port++) if (!used.has(port)) return port;
    for (var lower = 1024; lower < 1445; lower++) if (!used.has(lower)) return lower;
    return null;
  }
  function addRule(rule) {
    if (!nodes.length) { message("Register a Headscale machine before adding a service.", true);return; }
    var row = ui.element("div", "pkg-rule"), grid = ui.element("div", "pkg-inline-fields");
    var machineLabel = ui.element("label", "", "Headscale machine"), machine = ui.element("select");machine.className = "rule-node";
    nodes.forEach(function (node) { (node.ipAddresses || []).forEach(function (ip) {
      var option = new Option((node.givenName || node.name || "Machine " + node.id) + " · " + ip, node.id + "|" + ip);machine.appendChild(option);
    }); });
    if (!machine.options.length) { message("No machine has a Headscale VPN address.", true);return; }
    if (rule) {
      var wanted = rule.nodeId + "|" + rule.targetIp;
      if (!Array.from(machine.options).some(function (item) { return item.value === wanted; })) machine.appendChild(new Option("Unavailable machine · " + rule.targetIp, wanted));
      machine.value = wanted;
    }
    machineLabel.appendChild(machine);grid.appendChild(machineLabel);
    var destination = input("Destination TCP port", "number", rule ? rule.targetPort : 445, 1, 65535);destination.field.className = "rule-target-port";grid.appendChild(destination.wrap);
    var listenPort = rule ? rule.listenPort : unusedListenPort();
    if (listenPort === null) { message("No unused gateway port is available.", true);return; }
    var port = input("Gateway TCP port", "number", listenPort, 1024, 65535);port.field.className = "rule-listen-port";grid.appendChild(port.wrap);
    row.appendChild(grid);
    var actions = ui.element("div", "pkg-actions"), remove = ui.element("button", "pkg-button", "Remove service");remove.type = "button";remove.addEventListener("click", function () { row.remove(); });actions.appendChild(remove);row.appendChild(actions);$("rules").appendChild(row);
  }
  function sourceFields() { $("source-fields").hidden = $("source-mode").value !== "restricted"; }
  function showSettings(data) {
    var s = data.settings;
    $("enabled").checked = s.enabled;$("headscale-user").value = s.headscaleUserId;$("source-mode").value = s.sourceMode;
    $("allowed-sources").value = s.allowedSources.join("\n");$("max-connections").value = s.maxConnections;$("max-mbps").value = s.maxBytesPerSecond * 8 / 1000000;$("idle-timeout").value = s.idleTimeoutSeconds;
    $("rules").replaceChildren();s.rules.forEach(addRule);sourceFields();status(data);
  }
  $("add-rule").addEventListener("click", function () { addRule(); });
  $("source-mode").addEventListener("change", sourceFields);
  $("gateway-form").addEventListener("submit", async function (event) {
    event.preventDefault();$("save").disabled = true;message("");
    var settings = {
      enabled: $("enabled").checked, headscaleUserId: $("headscale-user").value, officialAuthKey: $("official-key").value.trim(), sourceMode: $("source-mode").value,
      allowedSources: $("allowed-sources").value.split(/[\n,]/).map(function (value) { return value.trim(); }).filter(Boolean),
      maxConnections: Number($("max-connections").value), maxBytesPerSecond: Math.round(Number($("max-mbps").value) * 1000000 / 8), idleTimeoutSeconds: Number($("idle-timeout").value),
      rules: Array.from(document.querySelectorAll(".pkg-rule")).map(function (row) {
        var machine = row.querySelector(".rule-node").value.split("|");
        return { nodeId: machine[0], targetIp: machine[1], targetPort: Number(row.querySelector(".rule-target-port").value), listenPort: Number(row.querySelector(".rule-listen-port").value) };
      })
    };
    try { var data = await ui.api("/api/v1/package/gateway", { method: "PUT", body: settings });$("official-key").value = "";status(data);message(settings.enabled ? "Saved. Connecting…" : "Saved. Gateway disabled."); }
    catch (error) { message(error.message, true); }
    finally { $("save").disabled = false; }
  });
  Promise.all([ui.api("/api/v1/user"), ui.api("/api/v1/node"), ui.api("/api/v1/package/gateway")]).then(function (results) {
    (results[0].users || []).forEach(function (user) { $("headscale-user").appendChild(new Option(ui.userName(user), String(user.id))); });
    nodes = results[1].nodes || [];$("no-machines").hidden = Boolean(nodes.length);$("add-rule").disabled = !nodes.length;showSettings(results[2]);$("save").disabled = false;
  }).catch(function (error) { message(error.message, true); });
  window.setInterval(async function () {
    if (polling || document.hidden || !current) return;polling = true;
    try { status(await ui.api("/api/v1/package/gateway")); }
    catch (_) { $("connection-status").textContent = "Connection status unavailable. Retrying…"; }
    finally { polling = false; }
  }, 5000);
})();

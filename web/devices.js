(function () {
  "use strict";
  var ui = window.HeadscalePackage, $ = function (id) { return document.getElementById(id); };
  var nodes = [], users = [], expanded = new Set(), loading = 0;
  var grouped = ui.stored("headscale-package-group-devices", "true") !== "false", collapsed;
  try { collapsed = new Set(JSON.parse(ui.stored("headscale-package-collapsed-users", "[]"))); } catch (_) { collapsed = new Set(); }
  function userId(node) { return nodeTags(node).length ? "tagged" : String((node.user || {}).id || "none"); }
  function userName(node) { return nodeTags(node).length ? "Tagged machines" : (node.user && node.user.id ? ui.userName(node.user) : "Unassigned machines"); }
  function nodeName(node) { return node.givenName || node.name || "Machine " + node.id; }
  function nodeTags(node) { return node.tags || node.forcedTags || []; }
  function fact(list, label, value) { list.append(ui.element("dt", "", label), ui.element("dd", "", value)); }
  function action(parent, label, handler, dangerous) { var button = ui.element("button", "pkg-button" + (dangerous ? " pkg-danger" : ""), label);button.type = "button";button.addEventListener("click", handler);parent.appendChild(button); }
  function device(node) {
    var id = String(node.id), name = nodeName(node), card = ui.element("details", "pkg-entry");card.dataset.nodeId = id;card.open = expanded.has(id);
    card.addEventListener("toggle", function () { if (!card.isConnected) return;if (card.open) expanded.add(id);else expanded.delete(id); });
    var summary = ui.element("summary"), dot = ui.element("span", "pkg-state-dot" + (node.online ? " pkg-state-dot-online" : ""));dot.setAttribute("aria-hidden", "true");summary.appendChild(dot);
    var title = ui.element("span", "pkg-entry-name", name);title.appendChild(ui.element("span", "pkg-entry-id", "#" + id));summary.appendChild(title);
    summary.appendChild(ui.element("span", "pkg-entry-meta", (node.online ? "Online" : "Offline") + " · " + (node.ipAddresses || []).join(" · ")));card.appendChild(summary);
    var content = ui.element("div", "pkg-entry-body"), facts = ui.element("dl", "pkg-facts");
    fact(facts, "User", userName(node));fact(facts, "Hostname", node.name || name);fact(facts, "Addresses", (node.ipAddresses || []).join(", ") || "Not assigned");
    fact(facts, "Last seen", node.online ? "Online now" : (Date.parse(node.lastSeen) > 0 ? ui.date(node.lastSeen) : "Never"));fact(facts, "Created", ui.date(node.createdAt));fact(facts, "Expiry", Date.parse(node.expiry) > 0 ? ui.date(node.expiry) : "No expiry");
    fact(facts, "Tags", (node.validTags || []).concat(nodeTags(node)).filter(function (tag, i, all) { return all.indexOf(tag) === i; }).join(", ") || "None");content.appendChild(facts);
    var actions = ui.element("div", "pkg-actions");
    action(actions, "Rename machine", function () {
      ui.formDialog("Rename " + name, "", [{name: "name", label: "Machine name", value: name}], "Save name", async function (value) {
        await ui.api("/api/v1/node/" + encodeURIComponent(id) + "/rename/" + encodeURIComponent(value.name), {method: "POST"});await load();ui.message("Machine renamed.");
      });
    });
    action(actions, "Edit tags", function () {
      ui.formDialog("Tags for " + name, nodeTags(node).length ? "Separate tags with commas. At least one tag is required." : "Adding tags removes user ownership. This cannot be undone.", [{name: "tags", label: "Tags", value: nodeTags(node).join(", "), maxLength: 1000}], "Save tags", async function (value) {
        var tags = value.tags.split(",").map(function (tag) { return tag.trim(); }).filter(Boolean);
        await ui.api("/api/v1/node/" + encodeURIComponent(id) + "/tags", {method: "POST", body: {tags: tags}});await load();ui.message("Machine tags saved.");
      });
    });
    action(actions, "Expire machine", function () {
      ui.formDialog("Expire " + name + "?", "Authentication will be required again.", [], "Expire machine", async function () {
        await ui.api("/api/v1/node/" + encodeURIComponent(id) + "/expire", {method: "POST"});await load();ui.message("Machine expired.");
      }, true);
    });
    action(actions, "Delete machine", function () {
      ui.formDialog("Delete " + name + "?", "The machine must register again to reconnect.", [], "Delete machine", async function () {
        await ui.api("/api/v1/node/" + encodeURIComponent(id), {method: "DELETE"});await load();ui.message("Machine deleted.");
      }, true);
    });content.appendChild(actions);
    var routes = Array.from(new Set((node.availableRoutes || []).concat(node.approvedRoutes || [])));
    if (routes.length) {
      content.appendChild(ui.element("h3", "", "Subnet routes"));var form = ui.element("form"), inputs = [];
      routes.forEach(function (route) { var label = ui.element("label", "pkg-check"), checkbox = ui.element("input");checkbox.type = "checkbox";checkbox.value = route;checkbox.checked = (node.approvedRoutes || []).includes(route);inputs.push(checkbox);label.append(checkbox, document.createTextNode(route));form.appendChild(label); });
      var save = ui.element("button", "pkg-button", "Save approved routes");save.type = "submit";form.appendChild(save);
      form.addEventListener("submit", async function (event) {
        event.preventDefault();save.disabled = true;
        try { await ui.api("/api/v1/node/" + encodeURIComponent(id) + "/approve_routes", {method: "POST", body: {routes: inputs.filter(function (input) { return input.checked; }).map(function (input) { return input.value; })}});await load();ui.message("Approved routes saved."); }
        catch (error) { ui.message(error.message, true);save.disabled = false; }
      });content.appendChild(form);
    }
    card.appendChild(content);return card;
  }
  function render() {
    var query = $("device-search").value.trim().toLowerCase(), selected = $("device-user").value, sort = $("device-sort").value;
    var filtered = nodes.filter(function (node) { return (!selected || userId(node) === selected) && [nodeName(node), node.name, userName(node)].concat(node.ipAddresses || []).join(" ").toLowerCase().includes(query); });
    filtered.sort(function (a, b) {
      if (sort === "id") return String(a.id).localeCompare(String(b.id), undefined, {numeric: true});
      if (sort === "lastSeen") return (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0);
      return nodeName(a).localeCompare(nodeName(b), undefined, {numeric: true, sensitivity: "base"});
    });
    $("group-users").setAttribute("aria-pressed", String(grouped));$("device-count").textContent = filtered.length + " of " + nodes.length + " machines · " + filtered.filter(function (node) { return node.online; }).length + " online";$("devices").replaceChildren();
    if (!filtered.length) { $("devices").appendChild(ui.element("p", "pkg-empty", nodes.length ? "No machines match these filters." : "Create an enrollment key to connect your first machine."));return; }
    if (!grouped) { filtered.forEach(function (node) { $("devices").appendChild(device(node)); });return; }
    var groups = new Map();filtered.forEach(function (node) { var id = userId(node);if (!groups.has(id)) groups.set(id, {name: userName(node), nodes: []});groups.get(id).nodes.push(node); });
    Array.from(groups.entries()).sort(function (a, b) { return a[1].name.localeCompare(b[1].name, undefined, {sensitivity: "base"}); }).forEach(function (entry) {
      var id = entry[0], group = entry[1], details = ui.element("details", "pkg-device-group");details.dataset.groupUserId = id;details.open = Boolean(query) || !collapsed.has(id);
      details.addEventListener("toggle", function () { if (!details.isConnected || query) return;if (details.open) collapsed.delete(id);else collapsed.add(id);ui.remember("headscale-package-collapsed-users", JSON.stringify(Array.from(collapsed))); });
      var summary = ui.element("summary"), title = ui.element("span", "pkg-entry-name", group.name);summary.appendChild(title);
      summary.appendChild(ui.element("span", "pkg-entry-meta", group.nodes.length + " machines · " + group.nodes.filter(function (node) { return node.online; }).length + " online"));details.appendChild(summary);
      group.nodes.forEach(function (node) { details.appendChild(device(node)); });$("devices").appendChild(details);
    });
  }
  async function load() {
    var version = ++loading;$("refresh-devices").disabled = true;
    try {
      var data = await Promise.all([ui.api("/api/v1/node"), ui.api("/api/v1/user")]);if (version !== loading) return;nodes = data[0].nodes || [];users = data[1].users || [];
      var previous = $("device-user").value || new URLSearchParams(location.search).get("user") || "";
      $("device-user").replaceChildren(new Option("All users", ""));$("register-user").replaceChildren();
      users.forEach(function (user) { $("device-user").appendChild(new Option(ui.userName(user), String(user.id)));$("register-user").appendChild(new Option(ui.userName(user), String(user.id))); });
      if (nodes.some(function (node) { return userId(node) === "tagged"; })) $("device-user").appendChild(new Option("Tagged machines", "tagged"));
      if (nodes.some(function (node) { return userId(node) === "none"; })) $("device-user").appendChild(new Option("Unassigned machines", "none"));
      $("device-user").value = previous;$("register-submit").disabled = !users.length;render();
    } catch (error) { if (version === loading) { ui.message(error.message, true);$("devices").replaceChildren(ui.element("p", "pkg-empty", "Machines could not be loaded. Try Refresh.")); } }
    finally { if (version === loading) $("refresh-devices").disabled = false; }
  }
  $("device-search").addEventListener("input", render);$("device-user").addEventListener("change", render);$("device-sort").addEventListener("change", render);
  $("group-users").addEventListener("click", function () { grouped = !grouped;ui.remember("headscale-package-group-devices", String(grouped));render(); });$("refresh-devices").addEventListener("click", load);
  $("register-device").addEventListener("submit", async function (event) {
    event.preventDefault();$("register-submit").disabled = true;
    try {
      var user = users.find(function (user) { return String(user.id) === $("register-user").value; });
      if (!user || !user.name) throw new Error("Choose a user with a username.");
      await ui.api("/api/v1/node/register?user=" + encodeURIComponent(user.name) + "&key=" + encodeURIComponent($("registration-key").value.trim()), {method: "POST"});$("registration-key").value = "";await load();ui.message("Machine registered.");
    }
    catch (error) { ui.message(error.message, true); }
    finally { $("register-submit").disabled = !users.length; }
  });load();
})();

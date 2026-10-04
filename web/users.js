(function () {
  "use strict";
  var ui = window.HeadscalePackage, $ = function (id) { return document.getElementById(id); };
  var users = [], nodes = [], keys = [], expanded = new Set(), loading = 0;
  var selected = new URLSearchParams(location.search).get("user");if (selected) expanded.add(selected);
  function userId(item) { return String((item.user || {}).id || ""); }
  function link(text, href) { var node = ui.element("a", "pkg-button", text);node.href = href;return node; }
  function fact(list, label, value) { list.append(ui.element("dt", "", label), ui.element("dd", "", value)); }
  async function expire(key) {
    try { await ui.api("/api/v1/preauthkey/expire", {method: "POST", body: {id: String(key.id)}});await load();ui.message("Key expired. Existing machines remain registered."); }
    catch (error) { ui.message(error.message, true); }
  }
  function render() {
    var query = $("user-search").value.trim().toLowerCase(), sort = $("user-sort").value;
    var filtered = users.filter(function (user) { return [ui.userName(user), user.name, user.email, user.id].join(" ").toLowerCase().includes(query); });
    filtered.sort(function (a, b) {
      if (sort === "id") return String(a.id).localeCompare(String(b.id), undefined, {numeric: true});
      if (sort === "created") return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
      return ui.userName(a).localeCompare(ui.userName(b), undefined, {sensitivity: "base"});
    });
    $("user-count").textContent = filtered.length + " of " + users.length + " users";$("users").replaceChildren();
    if (!filtered.length) { $("users").appendChild(ui.element("p", "pkg-empty", users.length ? "No users match your search." : "Create a user to register your first machine."));return; }
    filtered.forEach(function (user) {
      var id = String(user.id), name = ui.userName(user), devices = nodes.filter(function (node) { return userId(node) === id; });
      var allKeys = keys.filter(function (key) { return userId(key) === id; }), active = allKeys.filter(function (key) { return ui.keyState(key) === "Active"; });
      var card = ui.element("details", "pkg-entry");card.dataset.userId = id;card.open = expanded.has(id);
      card.addEventListener("toggle", function () { if (!card.isConnected) return;if (card.open) expanded.add(id);else expanded.delete(id); });
      var summary = ui.element("summary"), title = ui.element("span", "pkg-entry-name", name);title.appendChild(ui.element("span", "pkg-entry-id", "#" + id));summary.appendChild(title);
      summary.appendChild(ui.element("span", "pkg-entry-meta", devices.length + " machines · " + active.length + " active keys"));card.appendChild(summary);
      var content = ui.element("div", "pkg-entry-body"), facts = ui.element("dl", "pkg-facts");
      fact(facts, "Username", user.name || name);fact(facts, "Email", user.email || "Not set");fact(facts, "Created", ui.date(user.createdAt));content.appendChild(facts);
      var actions = ui.element("div", "pkg-actions");actions.append(link("View machines", "/web/devices.html?user=" + encodeURIComponent(id)), link("Create enrollment key", "/web/keys.html?user=" + encodeURIComponent(id)));
      var rename = ui.element("button", "pkg-button", "Rename user");rename.type = "button";
      rename.addEventListener("click", function () {
        ui.formDialog("Rename " + name, "Machines and keys are kept.", [{name: "name", label: "Username", value: user.name || name, maxLength: 100}], "Save name", async function (value) {
          await ui.api("/api/v1/user/" + encodeURIComponent(id) + "/rename/" + encodeURIComponent(value.name), {method: "POST"});await load();ui.message("User renamed.");
        });
      });actions.appendChild(rename);
      var remove = ui.element("button", "pkg-button pkg-danger", "Delete user");remove.type = "button";remove.disabled = devices.length > 0;
      if (devices.length) remove.title = "Remove this user's machines before deleting the user.";
      remove.addEventListener("click", function () {
        ui.formDialog("Delete " + name + "?", "The user and their keys will be removed.", [], "Delete user", async function () {
          await ui.api("/api/v1/user/" + encodeURIComponent(id), {method: "DELETE"});await load();ui.message("User deleted.");
        }, true);
      });actions.appendChild(remove);content.appendChild(actions);content.appendChild(ui.element("h3", "", "Active enrollment keys"));
      if (active.length) content.appendChild(ui.keyTable(active.slice(-5), expire));else content.appendChild(ui.element("p", "pkg-muted", "No active enrollment keys for this user."));
      var history = ui.element("a", "pkg-inline-link", "View all " + allKeys.length + " enrollment keys");history.href = "/web/keys.html?user=" + encodeURIComponent(id);content.appendChild(history);
      card.appendChild(content);$("users").appendChild(card);
    });
  }
  async function load() {
    var version = ++loading;$("refresh-users").disabled = true;
    try {
      var data = await Promise.all([ui.api("/api/v1/user"), ui.api("/api/v1/node"), ui.api("/api/v1/preauthkey")]);if (version !== loading) return;
      users = data[0].users || [];nodes = data[1].nodes || [];keys = data[2].preAuthKeys || [];render();
    } catch (error) { if (version === loading) { ui.message(error.message, true);$("users").replaceChildren(ui.element("p", "pkg-empty", "Users could not be loaded. Try Refresh.")); } }
    finally { if (version === loading) $("refresh-users").disabled = false; }
  }
  $("user-search").addEventListener("input", render);$("user-sort").addEventListener("change", render);$("refresh-users").addEventListener("click", load);
  $("new-user").addEventListener("click", function () {
    ui.formDialog("Create a user", "", [{name: "name", label: "Username", maxLength: 100}, {name: "email", label: "Email (optional)", type: "email", required: false}], "Create user", async function (values) {
      var data = await ui.api("/api/v1/user", {method: "POST", body: values});expanded.add(String(data.user.id));await load();ui.message("User created.");
    });
  });
  load();
})();

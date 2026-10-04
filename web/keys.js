(function () {
  "use strict";
  var ui = window.HeadscalePackage;
  var $ = function (id) { return document.getElementById(id); };
  var loadingVersion = 0;
  var userLoadingVersion = 0;

  function message(text, error) {
    $("message").textContent = text;
    $("message").className = "pkg-notice" + (error ? " pkg-error" : "");
    $("message").hidden = !text;
  }

  async function loadUsers(selected) {
    var version = ++userLoadingVersion;
    $("user").disabled = true;$("create-key").disabled = true;
    var data = await ui.api("/api/v1/user");
    if (version !== userLoadingVersion) return;
    var users = data.users || [];
    $("user").replaceChildren();
    if (!users.length) $("user").appendChild(new Option("Create a user first", ""));
    users.forEach(function (user) { $("user").appendChild(new Option(ui.userName(user), String(user.id))); });
    if (selected && users.some(function (user) { return String(user.id) === String(selected); })) $("user").value = selected;
    $("user").disabled = !users.length;
    $("create-key").disabled = !users.length;
    await loadKeys();
  }

  async function loadKeys() {
    var version = ++loadingVersion;
    var user = $("user").value;
    if (!user) return;
    $("key-list").textContent = "Loading keys…";
    try {
      var data = await ui.api("/api/v1/preauthkey?user=" + encodeURIComponent(user));
      if (version !== loadingVersion) return;
      var keys = data.preAuthKeys || [];
      if (!keys.length) { $("key-list").textContent = "No keys yet. Create one above to connect your first machine."; return; }
      var wrap = ui.element("div", "pkg-table-wrap");
      var table = ui.element("table", "pkg-table");
      var head = ui.element("thead");
      var header = ui.element("tr");
      ["Key", "Registration type", "Enrollment expiry", "Status", "Action"].forEach(function (text) { var th = ui.element("th", "", text); th.scope = "col"; header.appendChild(th); });
      head.appendChild(header);table.appendChild(head);
      var body = ui.element("tbody");
      keys.slice().reverse().forEach(function (key) {
        var expired = !key.expiration || new Date(key.expiration).getTime() <= Date.now();
        var used = key.used && !key.reusable;
        var row = ui.element("tr");
        row.appendChild(ui.element("td", "", "#" + key.id));
        var type = ui.element("td", "", key.reusable ? "Reusable" : "One registration");
        if (key.ephemeral) type.appendChild(ui.element("span", "pkg-badge", "Temporary machines"));
        row.appendChild(type);
        row.appendChild(ui.element("td", "", key.expiration ? new Date(key.expiration).toLocaleString() : "No expiry"));
        var status = ui.element("td");
        status.appendChild(ui.element("span", "pkg-badge" + (!expired && !used ? " pkg-badge-active" : ""), expired ? "Expired" : used ? "Used" : "Active"));
        row.appendChild(status);
        var actions = ui.element("td");
        if (!expired && !used) {
          var button = ui.element("button", "pkg-button", "Expire");button.type = "button";
          button.setAttribute("aria-label", "Expire enrollment key " + key.id);
          button.addEventListener("click", async function () {
            button.disabled = true;
            try { await ui.api("/api/v1/preauthkey/expire", { method: "POST", body: { id: String(key.id) } });await loadKeys();message("Key expired. Existing machines remain registered."); }
            catch (error) { message(error.message, true);button.disabled = false; }
          });
          actions.appendChild(button);
        } else { actions.textContent = "—"; }
        row.appendChild(actions);body.appendChild(row);
      });
      table.appendChild(body);wrap.appendChild(table);$("key-list").replaceChildren(wrap);
    } catch (error) { if (version === loadingVersion) { $("key-list").textContent = "Keys could not be loaded.";message(error.message, true); } }
  }

  $("purpose").addEventListener("change", function () {
    var purpose = $("purpose").value;
    $("reusable").checked = purpose !== "machine";
    $("ephemeral").checked = purpose === "cloud";
    $("lifetime").value = purpose === "machine" ? "168" : "2160";
  });
  $("user").addEventListener("change", loadKeys);
  $("create-user").addEventListener("click", async function () {
    var name = $("username").value.trim().toLowerCase();
    if (!name) { $("username").focus();message("Enter a username first.", true);return; }
    $("create-user").disabled = true;
    try { var data = await ui.api("/api/v1/user", { method: "POST", body: { name: name } });await loadUsers(data.user.id);$("username").value = "";$("new-user").open = false;message("User created."); }
    catch (error) { message(error.message, true); }
    finally { $("create-user").disabled = false; }
  });
  $("key-form").addEventListener("submit", async function (event) {
    event.preventDefault();$("create-key").disabled = true;message("");
    var tags = $("tags").value.split(",").map(function (tag) { return tag.trim(); }).filter(Boolean);
    try {
      var data = await ui.api("/api/v1/preauthkey", { method: "POST", body: {
        user: $("user").value, expiration: new Date(Date.now() + Number($("lifetime").value) * 3600000).toISOString(),
        reusable: $("reusable").checked, ephemeral: $("ephemeral").checked, aclTags: tags
      } });
      if (!data.preAuthKey || !data.preAuthKey.key) throw new Error("The server did not return the complete key. Check the key list before creating another one.");
      ui.showCreatedKey(data.preAuthKey);
      await loadKeys();
    } catch (error) { message(error.message, true); }
    finally { $("create-key").disabled = !$("user").value; }
  });
  loadUsers(new URLSearchParams(window.location.search).get("user")).catch(function (error) { message(error.message, true); });
})();

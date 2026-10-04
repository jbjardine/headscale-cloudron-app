(function () {
  "use strict";
  if (window.HeadscalePackage) return;

  var nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, options) {
    var url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    var method = ((options && options.method) || input.method || "GET").toUpperCase();
    if (url.origin === window.location.origin && url.pathname.startsWith("/web/api/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      options = Object.assign({}, options);
      var headers = new Headers(options.headers || input.headers);
      headers.set("X-Headscale-UI", "1");
      options.headers = headers;
    }
    var response = await nativeFetch(input, options);
    if (response.ok && method === "POST" && url.origin === window.location.origin && url.pathname === "/web/api/v1/preauthkey" && !window.location.pathname.endsWith("/keys.html")) {
      response.clone().json().then(function (data) {
        if (data.preAuthKey && data.preAuthKey.key) showCreatedKey(data.preAuthKey);
      }).catch(function () { /* The caller handles request failures. */ });
    }
    return response;
  };

  async function api(path, options) {
    options = Object.assign({ credentials: "same-origin" }, options);
    if (options.body && typeof options.body !== "string") {
      options.headers = Object.assign({ "Content-Type": "application/json" }, options.headers);
      options.body = JSON.stringify(options.body);
    }
    var response = await window.fetch("/web" + path, options);
    var data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.message || "Request failed (HTTP " + response.status + ")");
    return data;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function userName(user) {
    return user.displayName || user.name || user.email || "User " + user.id;
  }

  async function copy(text, button) {
    var original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch (_) {
      button.textContent = "Select and copy the text";
    }
    window.setTimeout(function () { button.textContent = original; }, 2000);
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function showCreatedKey(key) {
    var previous = document.getElementById("pkg-created-key");
    if (previous) previous.close();
    var dialog = element("dialog", "pkg-dialog");
    dialog.id = "pkg-created-key";
    dialog.setAttribute("aria-labelledby", "pkg-key-title");
    var heading = element("h2", "", "Key created");
    heading.id = "pkg-key-title";
    dialog.appendChild(heading);
    dialog.appendChild(element("p", "pkg-muted", "Displayed once. Copy before closing."));
    var label = element("label", "pkg-label", "Your enrollment key");
    label.htmlFor = "pkg-key-value";
    dialog.appendChild(label);
    var secret = element("input", "pkg-secret");
    secret.id = "pkg-key-value";
    secret.type = "password";
    secret.readOnly = true;
    secret.autocomplete = "off";
    secret.value = key.key;
    dialog.appendChild(secret);
    var actions = element("div", "pkg-actions");
    var copyButton = element("button", "pkg-button pkg-primary", "Copy key");
    copyButton.type = "button";
    copyButton.addEventListener("click", function () { copy(secret.value, copyButton); });
    actions.appendChild(copyButton);
    var reveal = element("button", "pkg-button", "Show key");
    reveal.type = "button";
    reveal.setAttribute("aria-controls", secret.id);
    reveal.setAttribute("aria-pressed", "false");
    reveal.addEventListener("click", function () {
      var hidden = secret.type === "password";
      secret.type = hidden ? "text" : "password";
      reveal.textContent = hidden ? "Hide key" : "Show key";
      reveal.setAttribute("aria-pressed", String(hidden));
    });
    actions.appendChild(reveal);
    dialog.appendChild(actions);
    var origin = window.location.origin;
    dialog.appendChild(element("h3", "", "Connection command"));
    var command = element("pre", "pkg-command", "tailscale up --login-server=" + shellQuote(origin) + " --auth-key='<your enrollment key>'");
    dialog.appendChild(command);
    var commandCopy = element("button", "pkg-button", "Copy connection command (includes key)");
    commandCopy.type = "button";
    commandCopy.addEventListener("click", function () {
      copy("tailscale up --login-server=" + shellQuote(origin) + " --auth-key=" + shellQuote(secret.value), commandCopy);
    });
    dialog.appendChild(commandCopy);
    dialog.appendChild(element("p", "pkg-note", "Key expiry does not disconnect registered machines."));
    var footer = element("div", "pkg-actions pkg-dialog-footer");
    var close = element("button", "pkg-button", "Close");
    close.type = "button";
    close.addEventListener("click", function () { dialog.close(); });
    footer.appendChild(close);
    dialog.appendChild(footer);
    dialog.addEventListener("close", function () { secret.value = ""; dialog.remove(); }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    copyButton.focus();
  }

  function date(value, fallback) {
    var parsed = value && new Date(value);
    return parsed && !isNaN(parsed.getTime()) ? parsed.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}) : (fallback || "—");
  }

  function keyState(key) {
    if (key.expiration && new Date(key.expiration).getTime() <= Date.now()) return "Expired";
    return key.used && !key.reusable ? "Used" : "Active";
  }

  function keyTable(keys, onExpire) {
    var wrap = element("div", "pkg-table-wrap");
    var table = element("table", "pkg-table");
    var labels = ["Key", "Registration type", "Enrollment expiry", "Status", "Action"];
    var head = element("thead"), header = element("tr"), body = element("tbody");
    labels.forEach(function (text) { var th = element("th", "", text);th.scope = "col";header.appendChild(th); });
    head.appendChild(header);table.appendChild(head);
    keys.slice().reverse().forEach(function (key) {
      var state = keyState(key), row = element("tr");
      var cells = [element("td", "pkg-key-id", "#" + key.id), element("td", "", key.reusable ? "Reusable" : "One registration"),
        element("td", "", key.expiration ? date(key.expiration) : "No expiry"), element("td"), element("td")];
      if (key.ephemeral) cells[1].appendChild(element("span", "pkg-badge", "Temporary machines"));
      cells[3].appendChild(element("span", "pkg-badge" + (state === "Active" ? " pkg-badge-active" : ""), state));
      if (state === "Active" && onExpire) {
        var button = element("button", "pkg-button pkg-small-button", "Expire");button.type = "button";
        button.setAttribute("aria-label", "Expire enrollment key " + key.id);
        button.addEventListener("click", async function () {
          button.disabled = true;
          try { await onExpire(key); } finally { if (button.isConnected) button.disabled = false; }
        });
        cells[4].appendChild(button);
      } else { cells[4].textContent = "—"; }
      cells.forEach(function (cell, i) { cell.dataset.label = labels[i];row.appendChild(cell); });
      body.appendChild(row);
    });
    table.appendChild(body);wrap.appendChild(table);return wrap;
  }

  function message(text, error) {
    var node = document.getElementById("message");
    node.textContent = text;node.className = "pkg-notice" + (error ? " pkg-error" : "");node.hidden = !text;
  }

  function formDialog(title, description, fields, action, callback, dangerous) {
    var dialog = element("dialog", "pkg-dialog"), form = element("form");
    var heading = element("h2", "", title);heading.id = "pkg-action-title";dialog.setAttribute("aria-labelledby", heading.id);
    form.appendChild(heading);form.appendChild(element("p", "pkg-muted", description));
    var inputs = {};
    fields.forEach(function (field) {
      var label = element("label", "pkg-label", field.label), input = element("input");
      input.id = "pkg-field-" + field.name;label.htmlFor = input.id;input.type = field.type || "text";
      input.value = field.value || "";input.required = field.required !== false;input.maxLength = field.maxLength || 200;
      form.appendChild(label);form.appendChild(input);inputs[field.name] = input;
    });
    var error = element("p", "pkg-notice pkg-error");error.hidden = true;error.setAttribute("role", "alert");form.appendChild(error);
    var actions = element("div", "pkg-actions pkg-dialog-footer");
    var cancel = element("button", "pkg-button", "Cancel");cancel.type = "button";cancel.addEventListener("click", function () { dialog.close(); });
    var submit = element("button", "pkg-button " + (dangerous ? "pkg-danger" : "pkg-primary"), action);submit.type = "submit";
    actions.append(cancel, submit);form.appendChild(actions);dialog.appendChild(form);document.body.appendChild(dialog);
    dialog.addEventListener("close", function () { dialog.remove(); }, {once: true});
    form.addEventListener("submit", async function (event) {
      event.preventDefault();submit.disabled = true;cancel.disabled = true;error.hidden = true;
      try {
        var values = {};Object.keys(inputs).forEach(function (name) { values[name] = inputs[name].value.trim(); });
        await callback(values);dialog.close();
      } catch (failure) { error.textContent = failure.message;error.hidden = false; }
      finally { submit.disabled = false;cancel.disabled = false; }
    });
    dialog.showModal();(Object.values(inputs)[0] || cancel).focus();return dialog;
  }

  function stored(name, fallback) { try { return localStorage.getItem(name) || fallback; } catch (_) { return fallback; } }
  function remember(name, value) { try { localStorage.setItem(name, value); } catch (_) { /* Private browsing can disable storage. */ } }
  function theme(value) {
    remember("headscale-package-theme", value);
    document.documentElement.dataset.theme = value === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
  }
  theme(stored("headscale-package-theme", "light"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { if (stored("headscale-package-theme", "light") === "system") theme("system"); });

  function navigation() {
    var sidebar = document.querySelector(".pkg-sidebar");if (!sidebar) return;
    var brand = element("a", "pkg-brand", "Headscale");brand.href = "/web/users.html";
    var nav = element("nav");nav.setAttribute("aria-label", "Main navigation");
    var current = window.location.pathname.replace(/\/$/, "");
    if (["/web", "/web/index.html", "/web/users"].includes(current)) current = "/web/users.html";
    [["users", "Users"], ["devices", "Devices"], ["keys", "Enrollment keys"], ["gateway", "Tailscale gateway"], ["settings", "Settings"]].forEach(function (entry) {
      var link = element("a", "", entry[1]);link.href = "/web/" + entry[0] + ".html";
      if (current === new URL(link.href).pathname) link.setAttribute("aria-current", "page");nav.appendChild(link);
    });
    sidebar.replaceChildren(brand, nav);
    var skip = element("a", "pkg-skip-link", "Skip to content");skip.href = "#main-content";
    var main = document.querySelector(".pkg-main");if (main) { main.id = "main-content";main.tabIndex = -1;document.body.prepend(skip); }
  }

  window.HeadscalePackage = { api: api, element: element, userName: userName, copy: copy, showCreatedKey: showCreatedKey,
    date: date, keyState: keyState, keyTable: keyTable, message: message, formDialog: formDialog,
    stored: stored, remember: remember, theme: theme };
  navigation();
})();

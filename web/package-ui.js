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
    var heading = element("h2", "", "Enrollment key created");
    heading.id = "pkg-key-title";
    dialog.appendChild(heading);
    dialog.appendChild(element("p", "pkg-muted", "Save this key now. Headscale only returns the complete key when it is created."));
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
    dialog.appendChild(element("h3", "", "Connect your machine"));
    var command = element("pre", "pkg-command", "tailscale up --login-server=" + shellQuote(origin) + " --auth-key='<your enrollment key>'");
    dialog.appendChild(command);
    var commandCopy = element("button", "pkg-button", "Copy connection command (includes key)");
    commandCopy.type = "button";
    commandCopy.addEventListener("click", function () {
      copy("tailscale up --login-server=" + shellQuote(origin) + " --auth-key=" + shellQuote(secret.value), commandCopy);
    });
    dialog.appendChild(commandCopy);
    dialog.appendChild(element("p", "pkg-note", "Enrollment expiry only prevents new registrations. It does not disconnect machines that are already registered."));
    var footer = element("div", "pkg-actions pkg-dialog-footer");
    var close = element("button", "pkg-button", "Done — I saved the key");
    close.type = "button";
    close.addEventListener("click", function () { dialog.close(); });
    footer.appendChild(close);
    dialog.appendChild(footer);
    dialog.addEventListener("close", function () { secret.value = ""; dialog.remove(); }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    copyButton.focus();
  }

  function addNavigation() {
    if (document.body.classList.contains("pkg-shell")) return;
    var userLink = document.querySelector('a[href="/web/"], a[href="/web/users"], a[href="/web/users.html"]');
    if (!userLink) return;
    var item = userLink.closest("li") || userLink.parentElement;
    if (!item || !item.parentElement) return;
    [["/web/keys.html", "Enrollment keys"], ["/web/gateway.html", "Tailscale gateway"]].forEach(function (entry) {
      if (document.querySelector('a[href="' + entry[0] + '"]')) return;
      var row = element(item.tagName.toLowerCase(), item.className);
      var link = element("a", userLink.className, entry[1]);
      link.href = entry[0];
      link.setAttribute("data-sveltekit-reload", "");
      row.appendChild(link);
      item.parentElement.appendChild(row);
    });
  }

  window.HeadscalePackage = { api: api, element: element, userName: userName, copy: copy, showCreatedKey: showCreatedKey };
  document.addEventListener("DOMContentLoaded", function () {
    addNavigation();
    new MutationObserver(addNavigation).observe(document.body, { childList: true, subtree: true });
  }, { once: true });
})();

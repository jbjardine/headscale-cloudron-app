(function () {
  "use strict";
  var ui = window.HeadscalePackage, $ = function (id) { return document.getElementById(id); };
  $("login-server").value = location.origin;$("theme").value = ui.stored("headscale-package-theme", "light");
  $("theme").addEventListener("change", function () { ui.theme($("theme").value); });
  async function connection() {
    $("test-connection").disabled = true;$("server-status").textContent = "Checking connection…";
    try {
      await ui.api("/api/v1/user");$("server-status").replaceChildren(ui.element("span", "pkg-badge pkg-badge-active", "Connected"), document.createTextNode("Headscale is responding."));
      $("connection-checked").textContent = "Last checked: " + ui.date(new Date().toISOString());ui.message("");
    } catch (error) { $("server-status").textContent = "Connection unavailable";ui.message(error.message, true); }
    finally { $("test-connection").disabled = false; }
  }
  $("test-connection").addEventListener("click", connection);
  ui.api("/api/v1/package/info").then(function (data) {
    $("versions").replaceChildren();[["App package", data.version], ["Headscale", data.headscaleVersion], ["Upstream UI", data.upstreamUiVersion]].forEach(function (entry) {
      $("versions").append(ui.element("dt", "", entry[0]), ui.element("dd", "", entry[1] || "Unknown"));
    });
  }).catch(function (error) { $("versions").textContent = "Versions unavailable";ui.message(error.message, true); });
  connection();
})();

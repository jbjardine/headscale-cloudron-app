(function () {
  var API_URL = "/web/api/v1/node";
  var DEVICE_PATH_RE = /\/web\/devices\.html\/?$/;
  var HEADER_ATTR = "data-headscale-device-user-header";
  var CONTROL_ATTR = "data-headscale-user-sort-control";
  var NODE_ID_RE = /^\s*(\d+)\s*:/;
  var nodesById = new Map();
  var collapsedUsers = new Set();
  var groupEnabled = true;
  var refreshPromise = null;
  var scheduled = false;
  var applying = false;

  function isDevicePage() {
    return DEVICE_PATH_RE.test(window.location.pathname);
  }

  function ensureStyles() {
    if (document.getElementById("headscale-device-user-groups-style")) return;

    var style = document.createElement("style");
    style.id = "headscale-device-user-groups-style";
    style.textContent = [
      ".headscale-device-user-header{align-items:center;background:rgba(15,118,110,.08);border:1px solid rgba(15,118,110,.2);border-radius:.25rem;color:#0f766e;cursor:pointer;display:flex;font:inherit;font-size:.9rem;font-weight:700;gap:.45rem;margin:.45rem 0 .05rem;padding:.3rem .5rem;text-align:left;width:100%;}",
      ".headscale-device-user-header:hover{background:rgba(15,118,110,.13);}",
      ".headscale-device-user-header:focus-visible{outline:2px solid rgba(15,118,110,.75);outline-offset:2px;}",
      ".headscale-device-user-header-chevron{display:inline-block;font-weight:900;text-align:center;width:1rem;}",
      ".headscale-device-user-header-name{flex:0 1 auto;}",
      ".headscale-device-user-header-count{border:1px solid rgba(15,118,110,.25);border-radius:.25rem;color:#0f766e;font-size:.72rem;font-weight:600;padding:.05rem .35rem;}",
      ".headscale-user-sort-button{min-width:3rem;}"
    ].join("");
    document.head.appendChild(style);
  }

  function buttonText(button) {
    return (button.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findSortButtonGroup() {
    return Array.from(document.querySelectorAll(".btn-group")).find(function (group) {
      var labels = Array.from(group.querySelectorAll("button")).map(buttonText);
      return labels.indexOf("ID") !== -1 && labels.indexOf("Device Name") !== -1 && labels.indexOf("Last Seen") !== -1;
    });
  }

  function ensureControl() {
    var group = findSortButtonGroup();
    if (!group) return;

    var control = group.querySelector("[" + CONTROL_ATTR + "]");
    if (!control) {
      control = document.createElement("button");
      control.type = "button";
      control.textContent = "User";
      control.title = "Group devices by Headscale user";
      control.className = "btn btn-xs capitalize headscale-user-sort-button";
      control.setAttribute(CONTROL_ATTR, "true");
      control.addEventListener("click", function () {
        groupEnabled = !groupEnabled;
        if (groupEnabled) {
          scheduleApply();
        } else {
          removeHeaders();
          showAllCards();
          sortCardsById();
          updateControl();
        }
      });
      group.appendChild(control);
    }

    Array.from(group.querySelectorAll("button:not([" + CONTROL_ATTR + "])")).forEach(function (button) {
      if (button.dataset.headscaleNativeSortListener) return;
      button.dataset.headscaleNativeSortListener = "true";
      button.addEventListener("click", function () {
        groupEnabled = false;
        setTimeout(function () {
          removeHeaders();
          showAllCards();
          updateControl();
        }, 0);
      });
    });

    updateControl();
  }

  function updateControl() {
    var group = findSortButtonGroup();
    if (!group) return;

    var control = group.querySelector("[" + CONTROL_ATTR + "]");
    if (!control) return;

    control.classList.toggle("btn-active", groupEnabled);
    control.setAttribute("aria-pressed", groupEnabled ? "true" : "false");
    if (groupEnabled) {
      Array.from(group.querySelectorAll("button:not([" + CONTROL_ATTR + "])")).forEach(function (button) {
        button.classList.remove("btn-active");
      });
    }
  }

  function refreshNodes() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = fetch(API_URL, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("Headscale nodes request failed with HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        nodesById = new Map();
        (data.nodes || []).forEach(function (node) {
          nodesById.set(String(node.id), node);
        });
      })
      .catch(function (error) {
        console.warn("Headscale device user grouping disabled:", error);
        groupEnabled = false;
      })
      .finally(function () {
        refreshPromise = null;
      });

    return refreshPromise;
  }

  function getDeviceId(card) {
    var candidates = Array.from(card.querySelectorAll("span,div"));
    for (var i = 0; i < candidates.length; i += 1) {
      var match = NODE_ID_RE.exec(candidates[i].textContent || "");
      if (match) return match[1];
    }
    return null;
  }

  function getDeviceCards() {
    return Array.from(document.querySelectorAll(".card-primary.bg-base-200")).filter(function (card) {
      return getDeviceId(card) !== null;
    });
  }

  function getUserName(node) {
    if (node && node.user) {
      if (node.user.name) return String(node.user.name);
      if (node.user.id !== undefined && node.user.id !== null) return "user-" + node.user.id;
    }
    return "No user";
  }

  function compareCards(left, right) {
    var leftId = getDeviceId(left);
    var rightId = getDeviceId(right);
    var leftUser = getUserName(nodesById.get(String(leftId)));
    var rightUser = getUserName(nodesById.get(String(rightId)));
    var userCompare = leftUser.localeCompare(rightUser, undefined, { sensitivity: "base" });
    if (userCompare !== 0) return userCompare;
    return Number(leftId) - Number(rightId);
  }

  function createHeader(userName, count) {
    var header = document.createElement("button");
    var chevron = document.createElement("span");
    var label = document.createElement("span");
    var badge = document.createElement("span");
    var collapsed = collapsedUsers.has(userName);

    header.className = "headscale-device-user-header";
    header.type = "button";
    header.setAttribute(HEADER_ATTR, "true");
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    header.title = collapsed ? "Expand " + userName + " devices" : "Collapse " + userName + " devices";
    chevron.className = "headscale-device-user-header-chevron";
    chevron.textContent = collapsed ? ">" : "v";
    label.className = "headscale-device-user-header-name";
    label.textContent = userName;
    badge.className = "headscale-device-user-header-count";
    badge.textContent = count + " " + (count === 1 ? "device" : "devices");
    header.addEventListener("click", function () {
      if (collapsedUsers.has(userName)) {
        collapsedUsers.delete(userName);
      } else {
        collapsedUsers.add(userName);
      }
      scheduleApply();
    });

    header.appendChild(chevron);
    header.appendChild(label);
    header.appendChild(badge);
    return header;
  }

  function removeHeaders(container) {
    var root = container || document;
    Array.from(root.querySelectorAll("[" + HEADER_ATTR + "]")).forEach(function (header) {
      header.remove();
    });
  }

  function showAllCards() {
    getDeviceCards().forEach(function (card) {
      card.hidden = false;
      card.style.display = "";
      card.removeAttribute("data-headscale-device-user");
    });
  }

  function sortCardsById() {
    var cards = getDeviceCards();
    if (cards.length < 2) return;

    var container = cards[0].parentElement;
    if (!container) return;

    applying = true;
    cards.sort(function (left, right) {
      return Number(getDeviceId(left)) - Number(getDeviceId(right));
    }).forEach(function (card) {
      container.appendChild(card);
    });
    setTimeout(function () {
      applying = false;
    }, 0);
  }

  function applyGrouping() {
    if (!isDevicePage()) return;

    ensureStyles();
    ensureControl();
    if (!groupEnabled) return;

    if (nodesById.size === 0) {
      refreshNodes().then(scheduleApply);
      return;
    }

    var cards = getDeviceCards();
    if (cards.length < 1) return;

    var container = cards[0].parentElement;
    if (!container) return;

    var groups = new Map();
    cards.sort(compareCards).forEach(function (card) {
      var node = nodesById.get(String(getDeviceId(card)));
      var userName = getUserName(node);
      if (!groups.has(userName)) groups.set(userName, []);
      groups.get(userName).push(card);
    });

    applying = true;
    removeHeaders(container);
    Array.from(groups.keys()).sort(function (left, right) {
      return left.localeCompare(right, undefined, { sensitivity: "base" });
    }).forEach(function (userName) {
      var userCards = groups.get(userName);
      container.appendChild(createHeader(userName, userCards.length));
      userCards.forEach(function (card) {
        var collapsed = collapsedUsers.has(userName);
        card.hidden = collapsed;
        card.style.display = collapsed ? "none" : "";
        card.setAttribute("data-headscale-device-user", userName);
        container.appendChild(card);
      });
    });
    updateControl();
    setTimeout(function () {
      applying = false;
    }, 0);
  }

  function scheduleApply() {
    if (scheduled || applying) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      applyGrouping();
    }, 100);
  }

  function observePage() {
    if (!document.body) return;

    new MutationObserver(function () {
      if (!applying) scheduleApply();
    }).observe(document.body, { childList: true, subtree: true });
    scheduleApply();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observePage, { once: true });
  } else {
    observePage();
  }
})();

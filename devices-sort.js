(function () {
  var API_URL = "/web/api/v1/node";
  var DEVICE_PATH_RE = /\/web\/devices\.html\/?$/;
  var GROUP_ATTR = "data-headscale-device-user-group";
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
      ".headscale-device-user-count{font-size:.75rem;font-weight:400;margin-left:.5rem;opacity:.7;}",
      ".headscale-device-user-body>.card-primary.bg-base-200{margin-top:.5rem;}",
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
          removeGroups();
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
          removeGroups();
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
      return !card.hasAttribute(GROUP_ATTR) && getDeviceId(card) !== null;
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

  function createChevron(collapsed) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");

    svg.setAttribute("class", "h-6 w-6 inline flex-shrink-0");
    svg.setAttribute("fill", "none");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", collapsed ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7");
    svg.appendChild(path);
    return svg;
  }

  function createGroup(userName, userCards) {
    var group = document.createElement("div");
    var header = document.createElement("div");
    var left = document.createElement("div");
    var right = document.createElement("div");
    var button = document.createElement("button");
    var label = document.createElement("span");
    var count = document.createElement("span");
    var body = document.createElement("div");
    var collapsed = collapsedUsers.has(userName);

    group.className = "card-primary bg-base-200";
    group.setAttribute(GROUP_ATTR, "true");
    header.className = "flex justify-between";
    label.className = "font-bold";
    label.textContent = userName;
    count.className = "headscale-device-user-count";
    count.textContent = userCards.length + " " + (userCards.length === 1 ? "device" : "devices");
    button.type = "button";
    button.setAttribute(HEADER_ATTR, "true");
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.title = collapsed ? "Expand " + userName + " devices" : "Collapse " + userName + " devices";
    button.appendChild(createChevron(collapsed));
    button.addEventListener("click", function () {
      if (collapsedUsers.has(userName)) {
        collapsedUsers.delete(userName);
      } else {
        collapsedUsers.add(userName);
      }
      scheduleApply();
    });
    body.className = "mt-2 pt-2 pl-2 headscale-device-user-body";
    body.hidden = collapsed;
    body.style.display = collapsed ? "none" : "";

    left.appendChild(label);
    left.appendChild(count);
    right.appendChild(button);
    header.appendChild(left);
    header.appendChild(right);
    userCards.forEach(function (card) {
      card.hidden = false;
      card.style.display = "";
      card.setAttribute("data-headscale-device-user", userName);
      body.appendChild(card);
    });

    group.appendChild(header);
    group.appendChild(body);
    return group;
  }

  function getListContainer(cards) {
    if (!cards.length) return null;

    var group = cards[0].closest("[" + GROUP_ATTR + "]");
    if (group && group.parentElement) return group.parentElement;
    return cards[0].parentElement;
  }

  function removeGroups(container) {
    var root = container || document;
    Array.from(root.querySelectorAll("[" + GROUP_ATTR + "]")).forEach(function (group) {
      var parent = group.parentElement;
      if (parent) {
        Array.from(group.querySelectorAll(".card-primary.bg-base-200")).filter(function (card) {
          return !card.hasAttribute(GROUP_ATTR) && getDeviceId(card) !== null;
        }).forEach(function (card) {
          parent.insertBefore(card, group);
        });
      }
      group.remove();
    });
    Array.from(root.querySelectorAll("[" + HEADER_ATTR + "]")).forEach(function (header) {
      if (!header.closest("[" + GROUP_ATTR + "]")) header.remove();
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

    var container = getListContainer(cards);
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

    var container = getListContainer(cards);
    if (!container) return;

    var groups = new Map();
    cards.sort(compareCards).forEach(function (card) {
      var node = nodesById.get(String(getDeviceId(card)));
      var userName = getUserName(node);
      if (!groups.has(userName)) groups.set(userName, []);
      groups.get(userName).push(card);
    });

    applying = true;
    removeGroups(container);
    Array.from(groups.keys()).sort(function (left, right) {
      return left.localeCompare(right, undefined, { sensitivity: "base" });
    }).forEach(function (userName) {
      var userCards = groups.get(userName);
      container.appendChild(createGroup(userName, userCards));
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

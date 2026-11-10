/* Applies the saved theme before first paint, so a dark page never flashes light. */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem("forge.settings") || "{}");
    if (s.theme === "light" || s.theme === "dark") document.documentElement.setAttribute("data-theme", s.theme);
  } catch (e) { /* storage unavailable: follow the system */ }
})();

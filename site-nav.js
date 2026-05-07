/**
 * Site navigation — single source of truth
 *
 * Every page includes `<div id="site-nav-root"></div>` and loads this script
 * before `ring-nav.js`. On DOMContentLoaded we replace that mount with a real
 * `<nav id="site-nav">` built from SITE_NAV below. The current page is detected
 * from `location.pathname` (last path segment); matching links get
 * `aria-current="page"`.
 *
 * To add or reorder pages: edit SITE_NAV only.
 */
(function () {
  /** @typedef {{ href: string, label: string }} NavChild */
  /** @typedef {{ kind: 'leaf', href: string, label: string }} NavLeaf */
  /** @typedef {{ kind: 'branch', href: string, label: string, childrenAriaLabel?: string, children: NavChild[] }} NavBranch */

  /** @type {(NavLeaf | NavBranch)[]} */
  const SITE_NAV = [
    { kind: "leaf", href: "index.html", label: "Main" },
    { kind: "leaf", href: "bio.html", label: "Bio" },
    {
      kind: "branch",
      href: "projects.html",
      label: "Projects",
      childrenAriaLabel: "Projects",
      children: [
        { href: "project1.html", label: "Project 1" },
        { href: "project2.html", label: "Project 2" },
        { href: "project3.html", label: "Project 3" },
      ],
    },
    { kind: "leaf", href: "cv.html", label: "CV" },
    { kind: "leaf", href: "universe.html", label: "Universe" },
    { kind: "leaf", href: "contact.html", label: "Contact" },
  ];

  function currentPageFilename() {
    const seg = (window.location.pathname || "").split("/").filter(Boolean).pop();
    return seg && seg.length ? seg : "index.html";
  }

  function link(href, label, currentFile) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (href === currentFile) a.setAttribute("aria-current", "page");
    return a;
  }

  function buildBranch(item, currentFile) {
    const wrap = document.createElement("div");
    wrap.className = "nav-branch";
    wrap.appendChild(link(item.href, item.label, currentFile));

    const kids = document.createElement("div");
    kids.className = "nav-branch-children";
    kids.setAttribute("role", "group");
    kids.setAttribute("aria-label", item.childrenAriaLabel || item.label);

    for (const ch of item.children) {
      kids.appendChild(link(ch.href, ch.label, currentFile));
    }
    wrap.appendChild(kids);
    return wrap;
  }

  function buildSiteNav() {
    const currentFile = currentPageFilename();
    const nav = document.createElement("nav");
    nav.id = "site-nav";
    nav.className = "nav";
    nav.setAttribute("aria-label", "Site");

    for (const item of SITE_NAV) {
      if (item.kind === "leaf") {
        nav.appendChild(link(item.href, item.label, currentFile));
      } else {
        nav.appendChild(buildBranch(item, currentFile));
      }
    }
    return nav;
  }

  function installSiteNav() {
    const mount = document.getElementById("site-nav-root");
    if (!mount) return;
    mount.replaceWith(buildSiteNav());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installSiteNav);
  } else {
    installSiteNav();
  }
})();

/* Shared session bootstrap. A network or server failure keeps the saved login. */
(function (root) {
  async function resolveSession() {
    let token = null;
    try { token = localStorage.getItem("token"); } catch (_) { token = null; }
    if (!token) return { status: "anonymous" };

    let response;
    try {
      response = await fetch(apiUrl("/api/auth/me"), {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store"
      });
    } catch (_) {
      return { status: "unavailable" };
    }

    if (response.status === 401) {
      try {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
      } catch (_) { /* ignore */ }
      return { status: "invalid" };
    }
    if (response.status === 403) return { status: "forbidden" };
    if (!response.ok) return { status: "unavailable" };

    let data = {};
    try { data = await response.json(); } catch (_) { return { status: "unavailable" }; }
    if (!data.user || !data.user.role) return { status: "unavailable" };
    try { localStorage.setItem("user", JSON.stringify(data.user)); } catch (_) { /* ignore */ }
    return { status: "ok", user: data.user };
  }

  function homeFor(user) {
    return user && user.role === "admin" ? "admin.html" : "dashboard.html";
  }

  root.NYCSession = { resolveSession: resolveSession, homeFor: homeFor };
})(typeof window !== "undefined" ? window : globalThis);

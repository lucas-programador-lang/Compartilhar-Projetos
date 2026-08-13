/* =========================================================
   COMPARTILHAR PROJETOS — AUTH.JS
   Lógica de login e cadastro, usada apenas em login.html e
   register.html. Compartilha o mesmo "banco de dados"
   (localStorage) usado em script.js e admin.js.
   ========================================================= */

(function () {
  "use strict";

  const DB_KEY = "cp_database_v1";
  const SESSION_KEY = "cp_session_v1";

  function uid(prefix) {
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 10);
  }
  function nowISO() {
    return new Date().toISOString();
  }

  /* ---------- banco de dados ---------- */
  function loadDB() {
    let raw = localStorage.getItem(DB_KEY);
    if (!raw) {
      const seeded = seedDB();
      localStorage.setItem(DB_KEY, JSON.stringify(seeded));
      return seeded;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      const seeded = seedDB();
      localStorage.setItem(DB_KEY, JSON.stringify(seeded));
      return seeded;
    }
  }
  function saveDB(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  // Seed mínimo — mantém a plataforma utilizável mesmo se auth.js
  // for a primeira página visitada (sem passar por script.js antes).
  function seedDB() {
    const adminId = uid("u");
    const demoId = uid("u");
    const day = 24 * 60 * 60 * 1000;
    return {
      users: [
        {
          id: adminId,
          name: "Equipe Compartilhar Projetos",
          email: "admin@compartilharprojetos.com",
          password: "admin123",
          role: "admin",
          avatarColor: "#1d4fc4",
          createdAt: nowISO(),
          refCode: "ADMIN01",
          referredBy: null,
          subscription: { active: false, plan: null, expiresAt: null },
          suspended: false,
          bio: "Conta oficial da plataforma.",
        },
        {
          id: demoId,
          name: "Marina Duarte",
          email: "marina@demo.com",
          password: "demo123",
          role: "user",
          avatarColor: "#b8860b",
          createdAt: nowISO(),
          refCode: "MARINA7X",
          referredBy: null,
          subscription: { active: true, plan: "p7", expiresAt: new Date(Date.now() + 7 * day).toISOString() },
          suspended: false,
          bio: "Product designer e criadora de side-projects.",
        },
      ],
      categories: [
        { id: uid("c"), name: "Web" },
        { id: uid("c"), name: "Mobile" },
        { id: uid("c"), name: "Design" },
        { id: uid("c"), name: "Inteligência Artificial" },
        { id: uid("c"), name: "Open Source" },
        { id: uid("c"), name: "Jogos" },
      ],
      projects: [],
      posts: [],
      referrals: [],
      commissions: [],
      withdrawals: [],
    };
  }

  let db = loadDB();

  /* ---------- sessão ---------- */
  function setSession(userId) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId }));
  }
  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch (e) {
      return null;
    }
  }
  function currentUser() {
    const s = getSession();
    if (!s) return null;
    return db.users.find((u) => u.id === s.userId) || null;
  }

  /* ---------- utilidades ---------- */
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  function qs(sel) {
    return document.querySelector(sel);
  }
  function toast(msg, type) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const iconChar = type === "success" ? "✓" : type === "error" ? "✕" : "i";
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = iconChar;
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = msg;
    el.append(icon, text);
    stack.appendChild(el);
    const dismiss = () => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    };
    setTimeout(dismiss, 3400);
  }
  function getParam(name) {
    return new URLSearchParams(location.search).get(name);
  }
  // para onde mandar o usuário depois de autenticar (?redirect=planos, ?redirect=publicar, etc.)
  function redirectDestination() {
    const r = getParam("redirect");
    const safe = r && /^[a-z0-9\-\/]+$/i.test(r) ? r : "painel";
    return "index.html#/" + safe.replace(/^\/+/, "");
  }

  /* ---------- ações ---------- */
  function registerUser({ name, email, password, refCode }) {
    email = email.trim().toLowerCase();
    if (!name || name.trim().length < 2) throw new Error("Informe seu nome completo.");
    if (!isValidEmail(email)) throw new Error("Informe um e-mail válido.");
    if (!password || password.length < 6) throw new Error("A senha deve ter ao menos 6 caracteres.");
    if (db.users.some((u) => u.email === email)) throw new Error("Este e-mail já está cadastrado.");

    let referredBy = null;
    if (refCode) {
      const ref = db.users.find((u) => u.refCode.toLowerCase() === refCode.trim().toLowerCase());
      if (ref) referredBy = ref.id;
    }

    const user = {
      id: uid("u"),
      name: name.trim(),
      email,
      password, // demo apenas — em produção use hash + salt no backend
      role: "user",
      avatarColor: ["#1d4fc4", "#b8860b", "#0f8a5f", "#8a6410", "#163e8c"][Math.floor(Math.random() * 5)],
      createdAt: nowISO(),
      refCode: (name.trim().split(" ")[0] + Math.random().toString(36).slice(2, 6)).toUpperCase(),
      referredBy,
      subscription: { active: false, plan: null, expiresAt: null },
      suspended: false,
      bio: "",
    };
    db.users.push(user);
    if (referredBy) {
      db.referrals.push({ id: uid("rf"), referrerId: referredBy, referredId: user.id, createdAt: nowISO() });
    }
    saveDB(db);
    return user;
  }

  function loginUser(email, password) {
    email = email.trim().toLowerCase();
    const user = db.users.find((u) => u.email === email && u.password === password);
    if (!user) throw new Error("E-mail ou senha incorretos.");
    if (user.suspended) throw new Error("Sua conta foi suspensa. Entre em contato com o suporte.");
    setSession(user.id);
    return user;
  }

  /* ---------- inicialização por página ---------- */
  function boot() {
    // se já estiver logado, pula direto para o painel
    if (currentUser()) {
      location.replace(redirectDestination());
      return;
    }

    // preserva o parâmetro ?redirect= ao alternar entre login e cadastro
    const redirectParam = getParam("redirect");
    ["goRegister", "goLogin"].forEach((id) => {
      const link = qs("#" + id);
      if (link && redirectParam) {
        const url = new URL(link.href, location.href);
        url.searchParams.set("redirect", redirectParam);
        link.href = url.toString();
      }
    });

    const loginForm = qs("#loginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(loginForm);
        try {
          loginUser(fd.get("email"), fd.get("password"));
          toast("Bem-vindo(a) de volta!", "success");
          location.href = redirectDestination();
        } catch (err) {
          const box = qs("#loginError");
          box.textContent = err.message;
          box.style.display = "block";
        }
      });
    }

    const registerForm = qs("#registerForm");
    if (registerForm) {
      const refField = qs("#refCodeInput");
      const refParam = getParam("ref");
      if (refField && refParam) refField.value = refParam;

      registerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(registerForm);
        try {
          const u = registerUser({
            name: fd.get("name"),
            email: fd.get("email"),
            password: fd.get("password"),
            refCode: fd.get("refCode"),
          });
          setSession(u.id);
          toast("Conta criada com sucesso!", "success");
          location.href = redirectDestination();
        } catch (err) {
          const box = qs("#registerError");
          box.textContent = err.message;
          box.style.display = "block";
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();

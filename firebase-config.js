/* =========================================================
   COMPARTILHAR PROJETOS — FIREBASE-CONFIG.JS
   Inicializa o Firebase (Auth + Realtime Database).
   Importado por auth.js, script.js e admin.js.
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBCKc-GYryZhx-DYm-tfxJrBbpg4zc0JIg",
  authDomain: "compartilhar-projetos.firebaseapp.com",
  databaseURL: "https://compartilhar-projetos-default-rtdb.firebaseio.com",
  projectId: "compartilhar-projetos",
  storageBucket: "compartilhar-projetos.firebasestorage.app",
  messagingSenderId: "421523492483",
  appId: "1:421523492483:web:6e7289000a8915e32655b6",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const rtdb = getDatabase(app);

/* =========================================================
   SESSÃO COM JANELA DESLIZANTE DE 7 DIAS
   ========================================================= */
// O SDK do Firebase, por padrão, nunca expira a sessão sozinho (o refresh
// token não tem validade própria — a pessoa fica logada indefinidamente
// até clicar em sair). Esse bloco adiciona uma expiração própria: toda
// vez que a pessoa abre o site autenticada, a janela se renova por mais
// 7 dias a partir de agora. Se ela ficar 7 dias seguidos sem abrir o
// site, a sessão expira sozinha e ela precisa logar de novo.
// Roda uma vez só (este arquivo é importado por auth.js, script.js e
// admin.js, então cobre login, site principal e painel admin).
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const SESSION_EXPIRES_KEY = "sessionExpiresAt";
const SESSION_EXPIRED_NOTICE_KEY = "sessionExpiredNotice";

onAuthStateChanged(auth, (user) => {
  if (!user) {
    localStorage.removeItem(SESSION_EXPIRES_KEY);
    return;
  }

  const storedExpiry = parseInt(localStorage.getItem(SESSION_EXPIRES_KEY) || "0", 10);

  if (storedExpiry && Date.now() > storedExpiry) {
    // Passou dos 7 dias sem abrir o site: força logout e deixa um aviso
    // pra próxima tela (lida e exibida pelo script.js/admin.js).
    localStorage.removeItem(SESSION_EXPIRES_KEY);
    sessionStorage.setItem(SESSION_EXPIRED_NOTICE_KEY, "1");
    signOut(auth).catch(() => {});
    return;
  }

  // Sessão ainda válida (ou é a primeira vez que vemos este login):
  // renova a janela por mais 7 dias a partir de agora.
  localStorage.setItem(SESSION_EXPIRES_KEY, String(Date.now() + SESSION_MAX_AGE_MS));
});

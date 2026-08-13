/* =========================================================
   COMPARTILHAR PROJETOS — FIREBASE-CONFIG.JS
   Inicializa o Firebase (Auth + Realtime Database).
   Importado por auth.js, script.js e admin.js.
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
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

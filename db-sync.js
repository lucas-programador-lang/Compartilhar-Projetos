/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS
   Substitui o antigo localStorage por um único nó no Firebase
   Realtime Database. Mantém a mesma "forma" do objeto db que
   já era usada em app.js / admin.js / auth.js, então o resto
   do código muda muito pouco.
   ========================================================= */

import { rtdb } from "./firebase-config.js";
import { ref, set, onValue } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { seedDB } from "./seed.js";

const DB_PATH = "database";

let cache = null;
const listeners = [];

/**
 * Registra um callback chamado toda vez que o banco mudar
 * (seja porque você salvou, seja porque outro usuário/aba salvou).
 * Se os dados já estiverem carregados, chama o callback imediatamente.
 */
export function onDBChange(cb) {
  listeners.push(cb);
  if (cache) cb(cache);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Retorna o snapshot mais recente do banco (ou null se ainda não carregou). */
export function getDB() {
  return cache;
}

/** Substitui a antiga função saveDB(db). Salva o objeto inteiro no Firebase. */
export function saveDB(newDb) {
  cache = newDb;
  return set(ref(rtdb, DB_PATH), newDb).catch((err) => {
    console.error("Erro ao salvar no Firebase:", err);
  });
}

// Assina mudanças em tempo real assim que este módulo é importado.
onValue(
  ref(rtdb, DB_PATH),
  (snapshot) => {
    if (snapshot.exists()) {
      cache = snapshot.val();
      // garante que os arrays esperados existam mesmo se o nó estiver incompleto
      cache.users = cache.users || [];
      cache.categories = cache.categories || [];
      cache.projects = cache.projects || [];
      cache.posts = cache.posts || [];
      cache.referrals = cache.referrals || [];
      cache.commissions = cache.commissions || [];
      cache.withdrawals = cache.withdrawals || [];
    } else {
      cache = seedDB();
      set(ref(rtdb, DB_PATH), cache);
    }
    listeners.forEach((cb) => cb(cache));
  },
  (err) => {
    console.error("Erro ao ler do Firebase:", err);
  }
);

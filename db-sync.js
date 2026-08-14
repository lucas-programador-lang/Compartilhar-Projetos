/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS (v2)
   Substitui o antigo saveDB() genérico (que reescrevia o banco
   inteiro) por funções específicas por operação. Isso é
   necessário porque as novas Regras do Firebase bloqueiam
   escrita client-side em users/$uid/subscription e users/$uid/role
   — um set() no objeto inteiro seria rejeitado por completo.

   getDB() e onDBChange() continuam iguais (leitura em tempo real).
   saveDB() genérico foi REMOVIDO. Use as funções específicas abaixo.
   ========================================================= */
import { rtdb } from "./firebase-config.js";
import { ref, set, update, push, onValue } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { seedDB } from "./seed.js";

const DB_PATH = "database";
let cache = null;
const listeners = [];

export function onDBChange(cb) {
  listeners.push(cb);
  if (cache) cb(cache);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getDB() {
  return cache;
}

/* ---------------------------------------------------------
   Helpers internos
--------------------------------------------------------- */
function userIndexById(userId) {
  const idx = cache.users.findIndex((u) => u && u.id === userId);
  if (idx === -1) throw new Error("Usuário não encontrado: " + userId);
  return idx;
}

/* ---------------------------------------------------------
   PERFIL — users/$idx/name e users/$idx/bio
--------------------------------------------------------- */
export function updateUserProfile(userId, { name, bio }) {
  const idx = userIndexById(userId);
  const updates = {};
  if (name != null) updates[`${DB_PATH}/users/${idx}/name`] = name;
  if (bio != null) updates[`${DB_PATH}/users/${idx}/bio`] = bio;
  return update(ref(rtdb), updates);
}

/* ---------------------------------------------------------
   PROJETOS — adiciona em users/.../ e na lista projects
--------------------------------------------------------- */
export function addProject(project) {
  const newRef = push(ref(rtdb, `${DB_PATH}/projects`));
  return set(newRef, project).then(() => project);
}

/* ---------------------------------------------------------
   COMUNIDADE — posts, comentários, respostas
--------------------------------------------------------- */
export function addPost(post) {
  const newRef = push(ref(rtdb, `${DB_PATH}/posts`));
  return set(newRef, post).then(() => post);
}

export function addComment(postId, comment) {
  const idx = cache.posts.findIndex((p) => p && p.id === postId);
  if (idx === -1) throw new Error("Publicação não encontrada: " + postId);
  const comments = cache.posts[idx].comments || [];
  const newIndex = comments.length;
  return update(ref(rtdb), {
    [`${DB_PATH}/posts/${idx}/comments/${newIndex}`]: comment,
  }).then(() => comment);
}

export function addReply(postId, commentId, reply) {
  const postIdx = cache.posts.findIndex((p) => p && p.id === postId);
  if (postIdx === -1) throw new Error("Publicação não encontrada: " + postId);
  const comments = cache.posts[postIdx].comments || [];
  const commentIdx = comments.findIndex((c) => c && c.id === commentId);
  if (commentIdx === -1) throw new Error("Comentário não encontrado: " + commentId);
  const replies = comments[commentIdx].replies || [];
  const newIndex = replies.length;
  return update(ref(rtdb), {
    [`${DB_PATH}/posts/${postIdx}/comments/${commentIdx}/replies/${newIndex}`]: reply,
  }).then(() => reply);
}

/* ---------------------------------------------------------
   INDICAÇÕES E SAQUES
--------------------------------------------------------- */
export function addReferral(referral) {
  const newRef = push(ref(rtdb, `${DB_PATH}/referrals`));
  return set(newRef, referral).then(() => referral);
}

export function addWithdrawalRequest(withdrawal) {
  const newRef = push(ref(rtdb, `${DB_PATH}/withdrawals`));
  return set(newRef, withdrawal).then(() => withdrawal);
}

/* ---------------------------------------------------------
   NOTA: subscription, role e commissions NÃO têm função de
   escrita aqui de propósito — só o Worker (com a Service
   Account) pode alterar esses campos, via webhook de pagamento
   confirmado. Isso é reforçado pelas Regras do Firebase.
--------------------------------------------------------- */

/* ---------------------------------------------------------
   Assinatura em tempo real (igual antes)
--------------------------------------------------------- */
onValue(
  ref(rtdb, DB_PATH),
  (snapshot) => {
    if (snapshot.exists()) {
      cache = snapshot.val();
      const clean = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : Object.values(arr || {}).filter(Boolean));
      cache.users = clean(cache.users);
      cache.categories = clean(cache.categories);
      cache.projects = clean(cache.projects);
      cache.posts = clean(cache.posts);
      cache.referrals = clean(cache.referrals);
      cache.commissions = clean(cache.commissions);
      cache.withdrawals = clean(cache.withdrawals);
      cache.posts.forEach((p) => {
        p.comments = clean(p.comments);
        p.comments.forEach((c) => {
          c.replies = clean(c.replies);
        });
      });
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

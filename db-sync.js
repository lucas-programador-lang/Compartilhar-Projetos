/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS (v4)
   Substitui o antigo saveDB() genérico (que reescrevia o banco
   inteiro) por funções específicas por operação. Isso é
   necessário porque as novas Regras do Firebase bloqueiam
   escrita client-side em users/$uid/subscription e users/$uid/role
   — um set() no objeto inteiro seria rejeitado por completo.

   v3: a leitura também deixou de ser um único listener no nó raiz
   "database". As regras negam leitura do nó raiz inteiro
   (".read": false) — só os nós filhos (users, categories, etc.)
   têm suas próprias permissões. Por isso agora existe um listener
   por nó de primeiro nível, e o resultado é combinado no mesmo
   objeto `cache` de sempre, pra não quebrar o resto do app.

   v4: CORREÇÃO IMPORTANTE — quando um listener onValue() recebe
   um erro de permissão (ex.: usuário ainda não logado tentando
   ler "users"), o Firebase cancela esse listener PARA SEMPRE.
   Ele não volta a escutar sozinho quando o usuário loga depois.
   Por isso agora os listeners são recriados sempre que o estado
   de autenticação muda (onAuthStateChanged), garantindo que,
   assim que o login é confirmado, os nós que exigem auth != null
   (users, referrals, commissions, withdrawals) voltem a ser lidos
   com o token válido.
   ========================================================= */
import { rtdb, auth } from "./firebase-config.js";
import { ref, set, update, push, onValue, off } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const DB_PATH = "database";
const TOP_LEVEL_KEYS = ["users", "categories", "projects", "posts", "referrals", "commissions", "withdrawals"];

let cache = emptyCache();
const listeners = [];

function emptyCache() {
  return {
    users: [],
    categories: [],
    projects: [],
    posts: [],
    referrals: [],
    commissions: [],
    withdrawals: [],
  };
}

function clean(val) {
  return Array.isArray(val) ? val.filter(Boolean) : Object.values(val || {}).filter(Boolean);
}

function notify() {
  listeners.forEach((cb) => cb(cache));
}

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
   PERFIL — users/$idx/name, users/$idx/bio e users/$idx/document
   (document = CPF ou CNPJ, exigido pela VizzionPay para gerar Pix)
--------------------------------------------------------- */
export function updateUserProfile(userId, { name, bio, document } = {}) {
  const idx = userIndexById(userId);
  const updates = {};
  if (name != null) updates[`${DB_PATH}/users/${idx}/name`] = name;
  if (bio != null) updates[`${DB_PATH}/users/${idx}/bio`] = bio;
  if (document != null) updates[`${DB_PATH}/users/${idx}/document`] = document;
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
   Assinatura em tempo real — um listener por nó de primeiro
   nível, porque o nó raiz "database" não pode ser lido de uma
   vez só (".read": false nas regras). Cada nó filho tem sua
   própria regra de leitura.

   Os listeners são recriados sempre que o estado de auth muda,
   pra evitar o problema do onValue() "morrer" depois de um
   permission_denied e nunca mais voltar a escutar sozinho.
--------------------------------------------------------- */
function subscribeAll() {
  TOP_LEVEL_KEYS.forEach((key) => {
    const nodeRef = ref(rtdb, `${DB_PATH}/${key}`);

    // remove qualquer listener anterior nesse nó antes de recriar,
    // pra não acumular listeners duplicados a cada login/logout
    off(nodeRef);

    onValue(
      nodeRef,
      (snapshot) => {
        cache[key] = snapshot.exists() ? clean(snapshot.val()) : [];
        if (key === "posts") {
          cache.posts.forEach((p) => {
            p.comments = clean(p.comments);
            p.comments.forEach((c) => {
              c.replies = clean(c.replies);
            });
          });
        }
        notify();
      },
      (err) => {
        // Normal enquanto o usuário não está logado: users, referrals,
        // commissions e withdrawals exigem auth != null nas regras.
        // categories/projects/posts são de leitura pública e não devem
        // cair aqui. Quando o usuário logar, subscribeAll() roda de
        // novo via onAuthStateChanged e o listener é recriado.
        console.error(`Erro ao ler ${key} do Firebase:`, err);
      }
    );
  });
}

// primeira assinatura (cobre o caso de página já carregar sem auth,
// ex.: categories/projects/posts, que são públicos)
subscribeAll();

// reconecta TODOS os listeners sempre que o login muda — é isso que
// garante que "users" (e os outros nós que exigem auth) voltem a
// ser lidos assim que o Firebase confirmar o login do usuário
onAuthStateChanged(auth, () => {
  subscribeAll();
});

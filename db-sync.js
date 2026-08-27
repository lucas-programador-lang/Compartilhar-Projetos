/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS (v7)
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
   (users, referrals, commissions, withdrawals, notifications)
   voltem a ser lidos com o token válido.

   v5: CORREÇÃO — onDBChange() chamava cb(cache) imediatamente ao
   registrar o listener, mesmo com cache ainda vazio (emptyCache()
   não é null, então a checagem antiga "if (cache) cb(cache)" era
   sempre verdadeira). Isso fazia quem escuta onDBChange (admin.js)
   marcar dbReady = true um instante cedo demais, antes do primeiro
   sync completo dos nós — causando um flash da tela de "acesso
   negado" antes dos dados reais chegarem. Agora existe um flag
   `synced`, exportado via isDBSynced(), que só vira true depois que
   TODOS os nós responderam (sucesso ou erro) pelo menos uma vez
   na geração de sync atual. onDBChange() só dispara de imediato se
   `synced` já for true; subscribeAll() reseta `synced` no início de
   cada nova geração (login/logout), evitando também que o painel
   mostre por um instante o cache de uma sessão anterior durante um
   relogin.

   v6: CORREÇÃO — addComment()/addReply() escreviam usando o ÍNDICE
   do array local (cache.posts.findIndex(...)) como se fosse a chave
   real do nó no Firebase. Como posts são criados com push() (chaves
   tipo "-NabcXYZ", não índices sequenciais), isso fazia o comentário
   ser gravado em um caminho totalmente novo e desconectado do post
   real (ex.: "posts/1/comments/0" em vez de dentro do post
   verdadeiro). Esse nó novo não tinha authorId/content/createdAt,
   então voltava para a tela como um "post fantasma" renderizado como
   "Usuário removido" / "Invalid Date". Correção: o cache agora guarda
   a chave real do Firebase de cada post/comentário/resposta em
   "_fbKey" (via cleanKeyed, que substitui clean() só para "posts"),
   e addComment()/addReply() usam essa chave real — nunca o índice do
   array — para saber onde escrever. De brinde, comments/replies
   passaram a usar push() em vez de "length" como próximo índice,
   eliminando a race condition de duas escritas simultâneas colidirem
   no mesmo índice.

   v7: NOTIFICAÇÕES. Novo nó de primeiro nível "notifications" — é
   onde o Worker grava um aviso quando um projeto é reprovado na
   moderação (ver handleModerateProject no worker.js), lido pelo
   script.js para mostrar o sino no header e a lista no painel do
   usuário. O Worker grava usando notificationsList.length como
   índice (não push()), então diferente de posts/comments a chave
   real do Firebase É o índice — não precisa de _fbKey/cleanKeyed,
   clean() padrão já basta. markNotificationRead() é a única escrita
   client-side sobre este nó (o usuário marcando a própria
   notificação como lida) — criar/editar o conteúdo da notificação
   continua sendo exclusividade do Worker, como subscription/role.

   v8: EDITAR E REENVIAR PROJETO REJEITADO. "projects" passou a usar
   cleanKeyed() (mesmo tratamento de "posts") — sem isso,
   updateProject() teria que escrever usando o índice do array local,
   e esse índice muda toda vez que um projeto é excluído em qualquer
   posição anterior à dele, fazendo a escrita ir parar no projeto
   errado (o mesmo bug de fundo que a v6 corrigiu para
   addComment/addReply). Nova função updateProject() permite ao
   dono de um projeto "rejected" reenviá-lo com os campos corrigidos
   SEM criar um registro novo — o script.js usa isso no fluxo de
   "Editar e reenviar" para não duplicar o projeto (antes, reenviar
   chamava addProject() de novo e o projeto rejeitado antigo ficava
   perdido no banco, nunca mais visível em lugar nenhum).
   ========================================================= */
import { rtdb, auth } from "./firebase-config.js";
import { ref, set, update, push, onValue, off } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const DB_PATH = "database";
const TOP_LEVEL_KEYS = ["users", "categories", "projects", "posts", "referrals", "commissions", "withdrawals", "notifications", "rankingPrizes"];
let cache = emptyCache();
const listeners = [];
let synced = false;

function emptyCache() {
  return {
    users: [],
    categories: [],
    projects: [],
    posts: [],
    referrals: [],
    commissions: [],
    withdrawals: [],
    notifications: [],
    rankingPrizes: [],
    publicProfiles: [],
    myProfile: null,
  };
}

function clean(val) {
  return Array.isArray(val) ? val.filter(Boolean) : Object.values(val || {}).filter(Boolean);
}

function cleanKeyed(val) {
  if (val == null) return [];
  if (Array.isArray(val)) {
    return val
      .map((v, i) => (v == null ? null : { ...v, _fbKey: String(i) }))
      .filter(Boolean);
  }
  return Object.entries(val)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ ...v, _fbKey: k }));
}

function notify() {
  listeners.forEach((cb) => cb(cache));
}

export function onDBChange(cb) {
  listeners.push(cb);
  if (synced) cb(cache);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getDB() {
  return cache;
}

export function isDBSynced() {
  return synced;
}

function userIndexById(userId) {
  const idx = cache.users.findIndex((u) => u && u.id === userId);
  if (idx === -1) throw new Error("Usuário não encontrado: " + userId);
  return idx;
}

export function updateUserProfile(userId, { name, bio, document } = {}) {
  const idx = userIndexById(userId);
  const updates = {};
  if (name != null) updates[`${DB_PATH}/users/${idx}/name`] = name;
  if (bio != null) updates[`${DB_PATH}/users/${idx}/bio`] = bio;
  if (document != null) updates[`${DB_PATH}/users/${idx}/document`] = document;
  return update(ref(rtdb), updates);
}

export function addProject(project) {
  const newRef = push(ref(rtdb, `${DB_PATH}/projects`));
  return set(newRef, project).then(() => project);
}

export function updateProject(projectId, updates) {
  const project = cache.projects.find((p) => p && p.id === projectId);
  if (!project || !project._fbKey) throw new Error("Projeto não encontrado: " + projectId);
  const patch = {};
  Object.keys(updates || {}).forEach((field) => {
    patch[`${DB_PATH}/projects/${project._fbKey}/${field}`] = updates[field];
  });
  return update(ref(rtdb), patch).then(() => ({ ...project, ...updates }));
}

export function addPost(post) {
  const newRef = push(ref(rtdb, `${DB_PATH}/posts`));
  return set(newRef, post).then(() => post);
}

export function addComment(postId, comment) {
  const post = cache.posts.find((p) => p && p.id === postId);
  if (!post || !post._fbKey) throw new Error("Publicação não encontrada: " + postId);
  const newRef = push(ref(rtdb, `${DB_PATH}/posts/${post._fbKey}/comments`));
  return set(newRef, comment).then(() => comment);
}

export function addReply(postId, commentId, reply) {
  const post = cache.posts.find((p) => p && p.id === postId);
  if (!post || !post._fbKey) throw new Error("Publicação não encontrada: " + postId);
  const comment = (post.comments || []).find((c) => c && c.id === commentId);
  if (!comment || !comment._fbKey) throw new Error("Comentário não encontrado: " + commentId);
  const newRef = push(ref(rtdb, `${DB_PATH}/posts/${post._fbKey}/comments/${comment._fbKey}/replies`));
  return set(newRef, reply).then(() => reply);
}

/* ---------------------------------------------------------
   SAQUES
--------------------------------------------------------- */
export function addWithdrawalRequest(withdrawal) {
  const newRef = push(ref(rtdb, `${DB_PATH}/withdrawals`));
  return set(newRef, withdrawal).then(() => withdrawal);
}

export function markNotificationRead(notificationId) {
  const idx = cache.notifications.findIndex((n) => n && n.id === notificationId);
  if (idx === -1) throw new Error("Notificação não encontrada: " + notificationId);
  return update(ref(rtdb), { [`${DB_PATH}/notifications/${idx}/read`]: true });
}

let syncGeneration = 0;

function subscribeAll() {
  syncGeneration += 1;
  const gen = syncGeneration;
  const uid = auth.currentUser ? auth.currentUser.uid : null;

  const allKeys = [...TOP_LEVEL_KEYS, "publicProfiles", "myProfile"];
  const loadedKeys = new Set();
  let fullySynced = false;
  synced = false;

  function markLoaded(key) {
    loadedKeys.add(key);
    if (!fullySynced && loadedKeys.size === allKeys.length) {
      fullySynced = true;
      synced = true;
    }
    if (fullySynced) notify();
  }

  TOP_LEVEL_KEYS.forEach((key) => {
    const nodeRef = ref(rtdb, `${DB_PATH}/${key}`);
    off(nodeRef);
    onValue(
      nodeRef,
      (snapshot) => {
        if (gen !== syncGeneration) return;
        if (key === "posts") {
          cache.posts = cleanKeyed(snapshot.exists() ? snapshot.val() : {});
          cache.posts.forEach((p) => {
            p.comments = cleanKeyed(p.comments);
            p.comments.forEach((c) => {
              c.replies = cleanKeyed(c.replies);
            });
          });
        } else if (key === "projects") {
          cache.projects = cleanKeyed(snapshot.exists() ? snapshot.val() : {});
        } else {
          cache[key] = snapshot.exists() ? clean(snapshot.val()) : [];
        }
        markLoaded(key);
      },
      (err) => {
        if (gen !== syncGeneration) return;
        console.error(`Erro ao ler ${key} do Firebase:`, err);
        cache[key] = [];
        markLoaded(key);
      }
    );
  });

  const publicProfilesRef = ref(rtdb, "publicProfiles");
  off(publicProfilesRef);
  onValue(
    publicProfilesRef,
    (snapshot) => {
      if (gen !== syncGeneration) return;
      if (!snapshot.exists()) {
        cache.publicProfiles = [];
      } else {
        const val = snapshot.val();
        cache.publicProfiles = Object.entries(val)
          .filter(([, v]) => v != null)
          .map(([uid, v]) => ({ id: uid, ...v }));
      }
      markLoaded("publicProfiles");
    },
    (err) => {
      if (gen !== syncGeneration) return;
      console.error("Erro ao ler publicProfiles do Firebase:", err);
      cache.publicProfiles = [];
      markLoaded("publicProfiles");
    }
  );

  if (uid) {
    const myProfileRef = ref(rtdb, `myProfile/${uid}`);
    off(myProfileRef);
    onValue(
      myProfileRef,
      (snapshot) => {
        if (gen !== syncGeneration) return;
        cache.myProfile = snapshot.exists() ? snapshot.val() : null;
        markLoaded("myProfile");
      },
      (err) => {
        if (gen !== syncGeneration) return;
        console.error("Erro ao ler myProfile do Firebase:", err);
        cache.myProfile = null;
        markLoaded("myProfile");
      }
    );
  } else {
    cache.myProfile = null;
    markLoaded("myProfile");
  }
}

subscribeAll();

onAuthStateChanged(auth, () => {
  subscribeAll();
});

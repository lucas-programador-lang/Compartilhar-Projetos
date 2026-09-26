/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS (v14 - A Digitar...)
   ========================================================= */
import { rtdb, auth } from "./firebase-config.js";
import { ref, set, update, push, onValue, off, get, child, query, orderByChild, equalTo, onDisconnect } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";

const DB_PATH = "database";
const WORKER_URL = "https://api.compartilhar-projetos.com.br";
const NOTIFY_WORKER_URL = "https://worker-notificacoes.lucas-dev-programador.workers.dev";
const TOP_LEVEL_KEYS = ["users", "categories", "projects", "posts", "referrals", "commissions", "withdrawals", "notifications", "rankingPrizes", "platformReviews"];
let cache = emptyCache();
const listeners = [];
let synced = false;

function emptyCache() { return { users: [], categories: [], projects: [], posts: [], referrals: [], commissions: [], withdrawals: [], notifications: [], rankingPrizes: [], platformReviews: [], publicProfiles: [], myProfile: null }; }
function clean(val) { return Array.isArray(val) ? val.filter(Boolean) : Object.values(val || {}).filter(Boolean); }
function cleanKeyed(val) { if (val == null) return []; if (Array.isArray(val)) return val.map((v, i) => (v == null ? null : { ...v, _fbKey: String(i) })).filter(Boolean); return Object.entries(val).filter(([, v]) => v != null).map(([k, v]) => ({ ...v, _fbKey: k })); }
function notify() { listeners.forEach((cb) => cb(cache)); }
export function onDBChange(cb) { listeners.push(cb); if (synced) cb(cache); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }
export function getDB() { return cache; }
export function isDBSynced() { return synced; }

export async function updateUserProfile(userId, { name, bio, document, fcmToken } = {}) {
  if (!auth.currentUser) throw new Error("Você precisa estar logado.");
  const idToken = await auth.currentUser.getIdToken(); const payload = {};
  if (name != null) payload.name = name; if (bio != null) payload.bio = bio; if (document != null) payload.document = document;
  if (fcmToken != null) payload.fcmToken = fcmToken;
  const res = await fetch(`${WORKER_URL}/update-profile`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Erro ao atualizar perfil"); return data;
}

export async function enviarNotificacaoPush({ targetUserId, targetUserIds, title, body, data } = {}) {
  if (!auth.currentUser) return;
  try { const idToken = await auth.currentUser.getIdToken(); await fetch(`${NOTIFY_WORKER_URL}/notify`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken }, body: JSON.stringify({ targetUserId, targetUserIds, title, body, data }) }); } catch (error) {}
}

/* =========================================================
   TOKEN DE PUSH DO APK (chamado pelo wrapper nativo do app)
   ========================================================= */
// O app instalado (gerado pelo wrapper que empacota o site em APK) chama
// window.salvarTokenPush(token) assim que o token FCM nativo é gerado.
// Isso pode acontecer ANTES do usuário estar logado (ex: app recém-aberto),
// então guardamos o token em memória e salvamos assim que o login acontecer.
let pendingFcmToken = null;

async function salvarTokenPushNoBackend(token) {
  if (!auth.currentUser) { pendingFcmToken = token; return; }
  try {
    await updateUserProfile(auth.currentUser.uid, { fcmToken: token });
    pendingFcmToken = null;
  } catch (err) {
    // Mantém o token pendente para tentar de novo no próximo login/reload.
    pendingFcmToken = token;
    console.error("Falha ao salvar token push:", err);
  }
}

window.salvarTokenPush = function (token) {
  if (!token) return;
  salvarTokenPushNoBackend(token);
};

export function addProject(project) { return set(push(ref(rtdb, `${DB_PATH}/projects`)), project).then(() => project); }
export function updateProject(projectId, updates) {
  const project = cache.projects.find((p) => p && p.id === projectId); if (!project || !project._fbKey) throw new Error("Projeto não encontrado: " + projectId);
  const patch = {}; Object.keys(updates || {}).forEach((field) => { patch[`${DB_PATH}/projects/${project._fbKey}/${field}`] = updates[field]; });
  return update(ref(rtdb), patch).then(() => ({ ...project, ...updates }));
}
// A chave do review é o próprio uid de quem avalia (em vez de push()):
// assim a regra de segurança consegue recusar uma segunda avaliação do
// mesmo usuário só checando se aquele caminho já existe (!data.exists()),
// sem precisar de orderByChild (que as regras do Realtime Database não
// suportam).
export function addProjectReview(projectId, review) {
  const project = cache.projects.find((p) => p && p.id === projectId);
  if (!project || !project._fbKey) throw new Error("Projeto não encontrado: " + projectId);
  return set(ref(rtdb, `${DB_PATH}/projects/${project._fbKey}/reviews/${review.userId}`), review).then(() => review);
}
export function addPost(post) { return set(push(ref(rtdb, `${DB_PATH}/posts`)), post).then(() => post); }
export function addComment(postId, comment) { const post = cache.posts.find((p) => p && p.id === postId); return set(push(ref(rtdb, `${DB_PATH}/posts/${post._fbKey}/comments`)), comment).then(() => comment); }
export function addReply(postId, commentId, reply) { const post = cache.posts.find((p) => p && p.id === postId); const comment = (post.comments || []).find((c) => c && c.id === commentId); return set(push(ref(rtdb, `${DB_PATH}/posts/${post._fbKey}/comments/${comment._fbKey}/replies`)), reply).then(() => reply); }
// Mesma lógica: chave = uid do usuário, para a regra de segurança poder
// recusar uma segunda avaliação da plataforma pelo mesmo usuário.
export function addPlatformReview(review) { return set(ref(rtdb, `${DB_PATH}/platformReviews/${review.userId}`), review).then(() => review); }
export function addWithdrawalRequest(withdrawal) { return set(push(ref(rtdb, `${DB_PATH}/withdrawals`)), withdrawal).then(() => withdrawal); }
export function markNotificationRead(notificationId) { const notification = cache.notifications.find((n) => n && n.id === notificationId); return update(ref(rtdb), { [`${DB_PATH}/notifications/${notification._fbKey}/read`]: true }); }

/* =========================================================
   CHAT DE SUPORTE EM TEMPO REAL
   ========================================================= */
// imageData (opcional): dataURL base64 de uma imagem anexada, mesmo
// padrão já usado para fotos de projeto (sem Firebase Storage).
export async function enviarMensagemSuporte(userId, userName, text, sender, imageData) {
  const chatRef = ref(rtdb, `supportChats/${userId}`); const msgsRef = ref(rtdb, `supportChats/${userId}/messages`); const now = new Date().toISOString();
  const msg = { sender: sender, text: text || "", createdAt: now, read: false };
  if (imageData) msg.imageData = imageData;
  await set(push(msgsRef), msg);
  const lastMessagePreview = text ? text : "📷 Foto";
  await update(chatRef, { userName: userName, lastMessage: lastMessagePreview, updatedAt: now, unreadAdmin: sender === "user", unreadUser: sender === "admin", status: "open" });
}
export function escutarChatUsuario(userId, callback) { return onValue(ref(rtdb, `supportChats/${userId}`), (snapshot) => { callback(snapshot.val()); }); }
// Marca como lidas (read: true) todas as mensagens do OUTRO remetente
// que ainda não foram lidas — usado para os checks ✓✓ estilo WhatsApp.
function marcarMensagensComoLidas(userId, senderToMark) {
  const msgsRef = ref(rtdb, `supportChats/${userId}/messages`);
  get(msgsRef).then((snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    const updates = {};
    Object.entries(data).forEach(([msgId, msg]) => {
      if (msg && msg.sender === senderToMark && !msg.read) {
        updates[`${msgId}/read`] = true;
      }
    });
    if (Object.keys(updates).length > 0) update(msgsRef, updates);
  }).catch(() => {});
}
export function marcarChatLidoUser(userId) { update(ref(rtdb, `supportChats/${userId}`), { unreadUser: false }); marcarMensagensComoLidas(userId, "admin"); }
export function marcarChatLidoAdmin(userId) { update(ref(rtdb, `supportChats/${userId}`), { unreadAdmin: false }); marcarMensagensComoLidas(userId, "user"); }
export function escutarTodosOsChats(callback) { return onValue(ref(rtdb, `supportChats`), (snapshot) => { callback(snapshot.val()); }); }
export function encerrarChatAdmin(userId) { return update(ref(rtdb, `supportChats/${userId}`), { status: "closed" }); }
// (Para o Usuário) Reabrir/iniciar uma nova conversa depois de ter saído —
// só muda o status de volta para "open"; NUNCA apaga o histórico de
// mensagens (o admin precisa continuar vendo a conversa anterior).
export function reabrirChatUsuario(userId) { return update(ref(rtdb, `supportChats/${userId}`), { status: "open", unreadAdmin: false, unreadUser: false }); }
// (Para o Usuário) Sair da conversa — marca como fechada do próprio lado
// do usuário, sem apagar mensagens.
export function encerrarChatUsuario(userId) { return update(ref(rtdb, `supportChats/${userId}`), { status: "closed" }); }

export function setAdminPresenceOnline() {
  const connectedRef = ref(rtdb, ".info/connected");
  const adminPresenceRef = ref(rtdb, "supportPresence/adminOnline");
  onValue(connectedRef, (snap) => {
    if (snap.val() === true) {
      onDisconnect(adminPresenceRef).set(false).then(() => {
        set(adminPresenceRef, true).catch(() => {});
      });
    }
  });
}
export function escutarPresencaAdmin(callback) { return onValue(ref(rtdb, "supportPresence/adminOnline"), (snapshot) => { callback(snapshot.val() === true); }, () => { callback(false); }); }

// NOVO: SISTEMA DE A DIGITAR...
export function notificarDigitacao(userId, quem, isTyping) {
  update(ref(rtdb, `supportChats/${userId}`), { [`typing_${quem}`]: isTyping }).catch(()=>{});
}

/* --------------------------------------------------------- */
let syncGeneration = 0;
function subscribeAll() {
  syncGeneration += 1; const gen = syncGeneration; const uid = auth.currentUser ? auth.currentUser.uid : null;
  const allKeys = [...TOP_LEVEL_KEYS, "publicProfiles", "myProfile"]; const loadedKeys = new Set();
  let fullySynced = false; synced = false;
  function markLoaded(key) { loadedKeys.add(key); if (!fullySynced && loadedKeys.size === allKeys.length) { fullySynced = true; synced = true; } if (fullySynced) notify(); }
  TOP_LEVEL_KEYS.forEach((key) => {
    const nodeRef = ref(rtdb, `${DB_PATH}/${key}`); off(nodeRef);
    onValue(nodeRef, (snapshot) => {
        if (gen !== syncGeneration) return;
        if (key === "posts") { cache.posts = cleanKeyed(snapshot.exists() ? snapshot.val() : {}); cache.posts.forEach((p) => { p.comments = cleanKeyed(p.comments); p.comments.forEach((c) => { c.replies = cleanKeyed(c.replies); }); }); } 
        else if (key === "projects") { cache.projects = cleanKeyed(snapshot.exists() ? snapshot.val() : {}); cache.projects.forEach((p) => { p.reviews = cleanKeyed(p.reviews); }); }
        else if (key === "notifications") { cache[key] = cleanKeyed(snapshot.exists() ? snapshot.val() : {}); } 
        else { cache[key] = snapshot.exists() ? clean(snapshot.val()) : []; }
        markLoaded(key);
      }, (err) => { if (gen !== syncGeneration) return; cache[key] = []; markLoaded(key); }
    );
  });
  const publicProfilesRef = ref(rtdb, "publicProfiles"); off(publicProfilesRef);
  onValue(publicProfilesRef, (snapshot) => {
      if (gen !== syncGeneration) return;
      if (!snapshot.exists()) { cache.publicProfiles = []; } else { const val = snapshot.val(); cache.publicProfiles = Object.entries(val).filter(([, v]) => v != null).map(([uid, v]) => ({ id: uid, ...v })); }
      markLoaded("publicProfiles");
    }, (err) => { if (gen !== syncGeneration) return; cache.publicProfiles = []; markLoaded("publicProfiles"); }
  );
  if (uid) {
    const myProfileRef = ref(rtdb, `myProfile/${uid}`); off(myProfileRef);
    onValue(myProfileRef, (snapshot) => {
        if (gen !== syncGeneration) return; cache.myProfile = snapshot.exists() ? snapshot.val() : null; markLoaded("myProfile");
      }, (err) => { if (gen !== syncGeneration) return; cache.myProfile = null; markLoaded("myProfile"); }
    );
  } else { cache.myProfile = null; markLoaded("myProfile"); }

  // Se um token de push chegou antes do login (app aberto sem sessão ainda),
  // salva agora que já temos um usuário autenticado.
  if (uid && pendingFcmToken) {
    salvarTokenPushNoBackend(pendingFcmToken);
  }
}

onAuthStateChanged(auth, (user) => { subscribeAll(); });

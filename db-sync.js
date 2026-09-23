/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS (v9 - Com Chat de Suporte)
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

   v7/v8.2: NOTIFICAÇÕES & FCM. Novo nó de primeiro nível "notifications".
   Agora processado via cleanKeyed() para evitar erros de índice ("PERMISSION_DENIED")
   ao marcar como lida. Inclui suporte para Push Notifications (FCM).
   
   v9: SUPORTE EM TEMPO REAL. Funções adicionadas para escutar e gravar 
   mensagens do novo módulo de chat.
   ========================================================= */
import { rtdb, auth } from "./firebase-config.js";
import { ref, set, update, push, onValue, off, get, child, query, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
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
    platformReviews: [],
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

// ATUALIZAÇÃO DO PERFIL VIA WORKER (Mais segurança)
export async function updateUserProfile(userId, { name, bio, document } = {}) {
  if (!auth.currentUser) throw new Error("Você precisa estar logado.");
  const idToken = await auth.currentUser.getIdToken();
  
  const payload = {};
  if (name != null) payload.name = name;
  if (bio != null) payload.bio = bio;
  if (document != null) payload.document = document;

  const res = await fetch(`${WORKER_URL}/update-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + idToken
    },
    body: JSON.stringify(payload)
  });
  
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Erro ao atualizar perfil");
  return data;
}

/**
 * Envia uma notificação push via o Worker dedicado de notificações
 * (worker-notificacoes). Aceita "targetUserId" (um usuário) ou
 * "targetUserIds" (vários — só funciona se quem está logado for admin,
 * o próprio Worker confere isso).
 *
 * Nunca lança erro para quem chamou: notificação push é um "extra" que
 * não pode travar a ação principal (comentar, aprovar saque etc.) caso
 * o envio falhe por qualquer motivo (usuário sem token salvo, worker
 * fora do ar, etc.).
 */
export async function enviarNotificacaoPush({ targetUserId, targetUserIds, title, body, data } = {}) {
  if (!auth.currentUser) return;
  try {
    const idToken = await auth.currentUser.getIdToken();
    await fetch(`${NOTIFY_WORKER_URL}/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + idToken,
      },
      body: JSON.stringify({ targetUserId, targetUserIds, title, body, data }),
    });
  } catch (error) {
    console.error("Erro ao enviar notificação push:", error);
  }
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
   AVALIAÇÕES DA PLATAFORMA (PLATFORM REVIEWS)
--------------------------------------------------------- */
export function addPlatformReview(review) {
  const newRef = push(ref(rtdb, `${DB_PATH}/platformReviews`));
  return set(newRef, review).then(() => review);
}

/* ---------------------------------------------------------
   SAQUES
--------------------------------------------------------- */
export function addWithdrawalRequest(withdrawal) {
  const newRef = push(ref(rtdb, `${DB_PATH}/withdrawals`));
  return set(newRef, withdrawal).then(() => withdrawal);
}

/* ---------------------------------------------------------
   NOTIFICAÇÕES
--------------------------------------------------------- */
export function markNotificationRead(notificationId) {
  const notification = cache.notifications.find((n) => n && n.id === notificationId);
  if (!notification || !notification._fbKey) throw new Error("Notificação não encontrada: " + notificationId);
  
  return update(ref(rtdb), { [`${DB_PATH}/notifications/${notification._fbKey}/read`]: true });
}

export function markAllNotificationsRead() {
  if (!auth.currentUser) return Promise.reject(new Error("Usuário não logado"));
  const uid = auth.currentUser.uid;
  const patch = {};
  
  cache.notifications.forEach((n) => {
    // Filtra apenas as não lidas pertencentes ao usuário logado
    if (n && n._fbKey && !n.read && (n.userId === uid || n.ownerId === uid || n.id === uid)) {
      patch[`${DB_PATH}/notifications/${n._fbKey}/read`] = true;
    }
  });
  
  if (Object.keys(patch).length === 0) return Promise.resolve(); // Nada para atualizar
  return update(ref(rtdb), patch);
}

/* =========================================================
   CHAT DE SUPORTE EM TEMPO REAL (NOVO)
   ========================================================= */

// 1. Enviar mensagem (Utilizador e Admin)
export async function enviarMensagemSuporte(userId, userName, text, sender) {
  const chatRef = ref(rtdb, `supportChats/${userId}`);
  const msgsRef = ref(rtdb, `supportChats/${userId}/messages`);
  const novaMsgRef = push(msgsRef);
  const now = new Date().toISOString();

  await set(novaMsgRef, {
      sender: sender, // "user" ou "admin"
      text: text,
      createdAt: now
  });

  // Atualiza o resumo do chat para o painel do Admin
  await update(chatRef, {
      userName: userName,
      lastMessage: text,
      updatedAt: now,
      unreadAdmin: sender === "user", // Admin tem nova mensagem não lida
      unreadUser: sender === "admin"  // User tem nova mensagem não lida
  });
}

// 2. Escutar as mensagens de um utilizador específico em tempo real
export function escutarChatUsuario(userId, callback) {
  const chatRef = ref(rtdb, `supportChats/${userId}`);
  return onValue(chatRef, (snapshot) => {
      callback(snapshot.val());
  });
}

// 3. Marcar as mensagens como lidas pelo utilizador
export function marcarChatLidoUser(userId) {
  update(ref(rtdb, `supportChats/${userId}`), { unreadUser: false });
}

// 4. (Para o Admin) Marcar as mensagens como lidas pelo administrador
export function marcarChatLidoAdmin(userId) {
  update(ref(rtdb, `supportChats/${userId}`), { unreadAdmin: false });
}

// 5. (Para o Admin) Escutar TODOS os chats para o painel de suporte
export function escutarTodosOsChats(callback) {
  const chatsRef = ref(rtdb, `supportChats`);
  return onValue(chatsRef, (snapshot) => {
      callback(snapshot.val());
  });
}

/* ---------------------------------------------------------
   FIM CHAT DE SUPORTE
--------------------------------------------------------- */

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
        } else if (key === "projects" || key === "notifications") {
          cache[key] = cleanKeyed(snapshot.exists() ? snapshot.val() : {});
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

// NOVA FUNÇÃO: Pede permissão e salva o token do FCM
async function requestNotificationPermission(user) {
  try {
    const appInstance = getApp();
    const messaging = getMessaging(appInstance);
    
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      console.log('Permissão concedida para Push Notifications.');
      
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      
      // Aguarda o Service Worker ficar pronto
      await navigator.serviceWorker.ready;
      console.log('Service Worker do Firebase registrado e ativo!');
      
      const currentToken = await getToken(messaging, { 
        vapidKey: 'BANECLiu3BpgSo-_DMH8JzoOl1PgybZSzy2yeXyTepmSAN2m53AcVr9LvAXHkv1M21_iO-XoeNIQHkohPAf7t7g',
        serviceWorkerRegistration: registration
      });
      
      if (currentToken) {
        // Busca SOMENTE o usuário logado (Seguro)
        const usersRef = ref(rtdb, 'database/users');
        const usersQuery = query(usersRef, orderByChild('id'), equalTo(user.uid));
        const snapshot = await get(usersQuery);
        
        if (snapshot.exists()) {
          const users = snapshot.val();
          for (const key in users) {
            // A busca já filtrou, então garantimos que é ele mesmo
            if (users[key].fcmToken !== currentToken) {
              await update(ref(rtdb, `database/users/${key}`), { fcmToken: currentToken });
              console.log('fcmToken atualizado no banco de dados!');
            }
            break; // Só precisa atualizar uma vez
          }
        } else {
          console.log('Usuário não encontrado no nó de busca.');
        }
      } else {
        console.log('Token indisponível. Configuração do FCM pode estar incompleta.');
      }
    } else {
      console.log('Permissão para notificações negada pelo usuário.');
    }
  } catch (error) {
    console.error('Erro ao lidar com permissão de notificação FCM:', error);
  }
}
subscribeAll();

onAuthStateChanged(auth, (user) => {
  subscribeAll();
  
  if (user) {
    // 1. Tenta pedir notificação do navegador (Chrome/Edge/Desktop)
    requestNotificationPermission(user);

    // 2. Avisa o Android que o usuário já logou e pode entregar o token nativo!
    if (window.Android && typeof window.Android.solicitarTokenFCM === 'function') {
      window.Android.solicitarTokenFCM();
    }
  }
});

// =========================================================
// RECEBE O TOKEN NATIVO DO APLICATIVO ANDROID (WEBVIEW)
// =========================================================
window.salvarTokenPush = async function(token) {
  if (!auth.currentUser) return;
  
  try {
    const usersRef = ref(rtdb, 'database/users');
    const usersQuery = query(usersRef, orderByChild('id'), equalTo(auth.currentUser.uid));
    const snapshot = await get(usersQuery);
    
    if (snapshot.exists()) {
      const users = snapshot.val();
      for (const key in users) {
        if (users[key].fcmToken !== token) {
          await update(ref(rtdb, `database/users/${key}`), { fcmToken: token });
          console.log('Token do App Android salvo com sucesso no banco de dados!');
        }
        break; 
      }
    }
  } catch (error) {
    console.error('Erro ao salvar token nativo:', error);
  }
};

/* =========================================================
   COMPARTILHAR PROJETOS — DB-SYNC.JS (v6)
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

   v5: CORREÇÃO — onDBChange() chamava cb(cache) imediatamente ao
   registrar o listener, mesmo com cache ainda vazio (emptyCache()
   não é null, então a checagem antiga "if (cache) cb(cache)" era
   sempre verdadeira). Isso fazia quem escuta onDBChange (admin.js)
   marcar dbReady = true um instante cedo demais, antes do primeiro
   sync completo dos 7 nós — causando um flash da tela de "acesso
   negado" antes dos dados reais chegarem. Agora existe um flag
   `synced`, exportado via isDBSynced(), que só vira true depois que
   TODOS os 7 nós responderam (sucesso ou erro) pelo menos uma vez
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
   ========================================================= */
import { rtdb, auth } from "./firebase-config.js";
import { ref, set, update, push, onValue, off } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const DB_PATH = "database";
const TOP_LEVEL_KEYS = ["users", "categories", "projects", "posts", "referrals", "commissions", "withdrawals"];

let cache = emptyCache();
const listeners = [];
// true só depois que os 7 nós responderam (sucesso OU erro) pelo menos
// uma vez desde a última mudança de login/logout. Ver nota v5 acima.
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
  };
}

function clean(val) {
  return Array.isArray(val) ? val.filter(Boolean) : Object.values(val || {}).filter(Boolean);
}

// Como clean(), mas preserva a chave real do Firebase de cada item em
// "_fbKey" — necessário para posts (e comments/replies dentro deles),
// já que são criados com push() e não têm índice sequencial confiável.
// Sem isso, escrever de volta usando a posição no array aponta para o
// nó errado no banco (ver nota v6 acima).
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
  // só dispara de imediato se já houve pelo menos um sync completo —
  // caso contrário quem está ouvindo receberia um cache vazio e
  // marcaria erroneamente "pronto, mas sem dados" (ver nota v5).
  if (synced) cb(cache);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getDB() {
  return cache;
}

// Permite quem consome o módulo checar o estado de sync sem precisar
// registrar um listener (ex.: admin.js decidindo mostrar loading).
export function isDBSynced() {
  return synced;
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

   addComment()/addReply() usam a chave real do Firebase
   (post._fbKey / comment._fbKey), nunca o índice do array local —
   ver nota v6 no cabeçalho do arquivo para o porquê disso importar.
--------------------------------------------------------- */
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

   IMPORTANTE: cada um dos 7 nós tem seu próprio listener, e eles
   resolvem em momentos diferentes — os públicos (categories,
   projects, posts) costumam responder quase na hora, enquanto
   users/referrals/commissions/withdrawals dependem do token de
   auth mais recente e demoram um pouco mais. Se notify() disparasse
   a cada nó individualmente, o primeiro aviso (ex.: vindo de
   "categories") já marcaria os dados como "prontos" em quem escuta
   onDBChange, mesmo com "users" ainda vazio — e isso reintroduz o
   mesmo problema de redirecionar pro login antes da hora. Por isso
   agora notify() só é chamado depois que TODOS os 7 nós tiverem
   respondido (com sucesso OU erro) pelo menos uma vez desde a
   última mudança de login/logout. O mesmo critério agora também
   controla o flag `synced` (ver v5 no cabeçalho do arquivo).
--------------------------------------------------------- */
let syncGeneration = 0;

function subscribeAll() {
  syncGeneration += 1;
  const gen = syncGeneration;
  const loadedKeys = new Set();
  let fullySynced = false;
  // nova geração (login/logout) = precisa sincronizar tudo de novo
  // antes de considerar o cache confiável outra vez.
  synced = false;

  function markLoaded(key) {
    loadedKeys.add(key);
    if (!fullySynced && loadedKeys.size === TOP_LEVEL_KEYS.length) {
      fullySynced = true;
      synced = true; // libera onDBChange()/isDBSynced() só a partir daqui
    }
    if (fullySynced) notify();
  }

  TOP_LEVEL_KEYS.forEach((key) => {
    const nodeRef = ref(rtdb, `${DB_PATH}/${key}`);

    // remove qualquer listener anterior nesse nó antes de recriar,
    // pra não acumular listeners duplicados a cada login/logout
    off(nodeRef);

    onValue(
      nodeRef,
      (snapshot) => {
        if (gen !== syncGeneration) return; // listener de uma geração antiga — ignora
        if (key === "posts") {
          // posts (e comments/replies dentro deles) precisam da chave
          // real do Firebase preservada em "_fbKey" — ver nota v6.
          cache.posts = cleanKeyed(snapshot.exists() ? snapshot.val() : {});
          cache.posts.forEach((p) => {
            p.comments = cleanKeyed(p.comments);
            p.comments.forEach((c) => {
              c.replies = cleanKeyed(c.replies);
            });
          });
        } else {
          cache[key] = snapshot.exists() ? clean(snapshot.val()) : [];
        }
        markLoaded(key);
      },
      (err) => {
        if (gen !== syncGeneration) return;
        // Normal enquanto o usuário não está logado: users, referrals,
        // commissions e withdrawals exigem auth != null nas regras.
        // categories/projects/posts são de leitura pública e não devem
        // cair aqui. Quando o usuário logar, subscribeAll() roda de
        // novo via onAuthStateChanged e o listener é recriado.
        console.error(`Erro ao ler ${key} do Firebase:`, err);
        cache[key] = []; // evita vazar dado de uma sessão anterior
        markLoaded(key);
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

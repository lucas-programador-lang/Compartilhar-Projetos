// ============================================================
// ADICIONAR no bloco de rotas dentro de `fetch`, junto com as
// outras rotas /admin/*:
// ============================================================
//
//   if (url.pathname === "/admin/chat-list" && request.method === "POST") {
//     return withAdmin(request, env, handleChatList);
//   }
//   if (url.pathname === "/admin/chat-messages" && request.method === "POST") {
//     return withAdmin(request, env, handleChatMessages);
//   }
//   if (url.pathname === "/admin/chat-send" && request.method === "POST") {
//     return withAdmin(request, env, handleChatSend);
//   }

// ----------------------------------------------------
// CHAT ADMIN — lista conversas e envia mensagens como admin.
//
// Diferente das outras rotas administrativas, chats/* NÃO é
// indexado por um campo "id" dentro do valor (como users, projects,
// etc.) — a própria chave do nó já é o uid do usuário que iniciou
// a conversa. Por isso não reusa findEntryById aqui: lê o nó
// "/database/chats" (ou "/chats", confirme com sua estrutura real)
// inteiro e itera as chaves diretamente.
//
// NOTA: o resto do projeto guarda tudo sob /database/... no RTDB
// (users, projects, etc. — ver FIREBASE_DB_URL + paths acima).
// As regras que você aplicou colocam "chats" FORA de "database",
// no root. Ajuste CHATS_PATH abaixo para bater com onde os dados
// REALMENTE estão gravados (confirme no console/dados, não só nas
// regras) — se estiver errado, chat-list sempre volta vazio.
// ----------------------------------------------------
const CHATS_PATH = "/chats.json"; // troque para "/database/chats.json" se for o caso

async function handleChatList({ accessToken, usersRaw }) {
  const chatsRaw = await firebaseGetJson(accessToken, CHATS_PATH);
  if (!chatsRaw) return jsonResponse({ chats: [] }, 200);

  const userEntries = toEntries(usersRaw).map((e) => e.value);

  const chats = Object.entries(chatsRaw).map(([uid, chatData]) => {
    const registeredUser = userEntries.find((u) => u && u.id === uid);
    const messages = chatData?.messages ? Object.values(chatData.messages) : [];
    const last = messages.length
      ? messages.reduce((a, b) => ((a.timestamp || 0) > (b.timestamp || 0) ? a : b))
      : null;

    return {
      uid,
      name: registeredUser ? registeredUser.name : null,
      email: registeredUser ? registeredUser.email : null,
      lastMessage: last ? last.text : null,
      lastTimestamp: last ? last.timestamp : null,
      messageCount: messages.length,
    };
  });

  chats.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

  return jsonResponse({ chats }, 200);
}

// Retorna o histórico completo de UMA conversa, com os IDs de
// mensagem preservados (chat-list só dá preview/última mensagem —
// isso é usado quando o admin abre uma conversa específica).
async function handleChatMessages({ body, accessToken }) {
  const { targetUserId } = body;
  if (!targetUserId) return jsonResponse({ message: "targetUserId é obrigatório." }, 400);

  const messagesPath = `${CHATS_PATH.replace(".json", "")}/${targetUserId}/messages.json`;
  const raw = await firebaseGetJson(accessToken, messagesPath);
  if (!raw) return jsonResponse({ messages: [] }, 200);

  const messages = Object.entries(raw)
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  return jsonResponse({ messages }, 200);
}

async function handleChatSend({ body, accessToken }) {
  const { targetUserId, text } = body;
  if (!targetUserId || !text || !String(text).trim()) {
    return jsonResponse({ message: "targetUserId e text são obrigatórios." }, 400);
  }

  const messagesPath = `${CHATS_PATH.replace(".json", "")}/${targetUserId}/messages.json`;

  const message = {
    text: String(text).trim(),
    sender: "admin",
    timestamp: Date.now(),
  };

  // POST no RTDB REST gera uma push key automaticamente, igual ao
  // push() do SDK client — mantém o mesmo formato de chave que as
  // mensagens de usuário já usam.
  const res = await fetch(`${FIREBASE_DB_URL}${messagesPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Falha ao enviar mensagem (${res.status}): ${errText}`);
  }

  const { name } = await res.json(); // {"name": "-Nxxxxxx"} — push key gerada
  return jsonResponse({ sent: true, id: name, message }, 200);
}

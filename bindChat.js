/* ---------------------------------------------------------
     CHAT ADMIN (via Worker — /admin/chat-*)

     Reescrito: antes lia/escrevia direto no RTDB via onValue/push,
     o que exigia regra pública ou checagem de admin nas próprias
     regras (inviável, ver nota em database.rules.json). Agora
     tudo passa por adminFetch, igual ao resto das ações
     administrativas. Como REST não empurra atualização sozinho,
     uso polling curto (CHAT_POLL_INTERVAL_MS) para simular tempo
     real — suficiente para um chat de suporte, onde 2-3s de atraso
     não importa.
  --------------------------------------------------------- */
  const CHAT_POLL_INTERVAL_MS = 3000;

  let chatListPollTimer = null;
  let chatMessagesPollTimer = null;

  function bindChat() {
    if (chatBound) return;

    const listEl = qs("#adminChatList");
    const bodyEl = qs("#adminChatBody");
    const formEl = qs("#adminChatForm");
    const inputEl = qs("#adminChatInput");
    const submitBtn = qs("#adminChatSubmitBtn");
    const activeUserEl = qs("#adminChatActiveUser");

    if (!listEl || !formEl) return;
    chatBound = true;

    startChatListPolling(listEl);

    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!currentActiveChatUser) return;

      const textValue = inputEl.value.trim();
      if (!textValue) return;

      withButtonLock(submitBtn, async () => {
        inputEl.value = "";
        try {
          await adminFetch("/admin/chat-send", { targetUserId: currentActiveChatUser, text: textValue });
          await refreshChatMessages(bodyEl, currentActiveChatUser);
        } catch (err) {
          toast(err.message || "Falha ao enviar mensagem ao visitante.", "error");
          inputEl.value = textValue; // devolve o texto — não perde a mensagem
        }
      });
    });

    function startChatListPolling(listEl) {
      refreshChatList(listEl);
      clearInterval(chatListPollTimer);
      chatListPollTimer = setInterval(() => refreshChatList(listEl), CHAT_POLL_INTERVAL_MS);
    }

    async function refreshChatList(listEl) {
      let chats;
      try {
        const result = await adminFetch("/admin/chat-list", {});
        chats = result.chats || [];
      } catch (err) {
        console.error("Falha ao listar conversas:", err);
        return;
      }

      listEl.innerHTML = "";

      if (chats.length === 0) {
        listEl.innerHTML = '<p style="padding: 16px; font-size: 13px; color: #888; text-align: center;">Nenhuma conversa encontrada.</p>';
        return;
      }

      chats.forEach((chat) => {
        const displayName = chat.name || `Visitante (${chat.uid.slice(0, 10)}...)`;
        const displayEmail = chat.email || "Visitante não logado";

        const userBtn = document.createElement("button");
        userBtn.style.cssText =
          "width: 100%; text-align: left; padding: 16px; border: none; border-bottom: 1px solid var(--border-soft); background: transparent; cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: background 0.2s;";

        userBtn.innerHTML = `
          <span style="font-size: 14px; font-weight: 600; color: var(--navy-900);">👤 ${escapeHtml(displayName)}</span>
          <span style="font-size: 12px; color: #666; font-weight: 400;">${escapeHtml(displayEmail)}</span>
        `;

        userBtn.onmouseover = () => { if (currentActiveChatUser !== chat.uid) userBtn.style.background = "#f0f0f5"; };
        userBtn.onmouseout = () => { if (currentActiveChatUser !== chat.uid) userBtn.style.background = "transparent"; };

        userBtn.onclick = () => {
          Array.from(listEl.children).forEach((btn) => (btn.style.background = "transparent"));
          userBtn.style.background = "#e2e8f0";
          openChatWithUser(chat.uid, displayName, displayEmail);
        };

        if (currentActiveChatUser === chat.uid) {
          userBtn.style.background = "#e2e8f0";
        }

        listEl.appendChild(userBtn);
      });
    }

    function openChatWithUser(userId, displayName, displayEmail) {
      currentActiveChatUser = userId;

      activeUserEl.innerHTML = `Atendendo: <strong>${escapeHtml(displayName)}</strong> <span style="font-size: 13px; color: #666; font-weight: normal; margin-left: 8px;">${escapeHtml(displayEmail)}</span>`;

      inputEl.disabled = false;
      submitBtn.disabled = false;
      inputEl.focus();

      refreshChatMessages(bodyEl, userId);
      clearInterval(chatMessagesPollTimer);
      chatMessagesPollTimer = setInterval(() => {
        if (currentActiveChatUser === userId) refreshChatMessages(bodyEl, userId);
      }, CHAT_POLL_INTERVAL_MS);
    }

    async function refreshChatMessages(bodyEl, userId) {
      let messages;
      try {
        const result = await adminFetch("/admin/chat-messages", { targetUserId: userId });
        messages = result.messages || [];
      } catch (err) {
        console.error("Falha ao carregar mensagens:", err);
        return;
      }

      if (currentActiveChatUser !== userId) return; // usuário trocou de conversa enquanto isso carregava

      const wasAtBottom = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 20;

      bodyEl.innerHTML = "";

      if (messages.length === 0) {
        bodyEl.innerHTML = '<p style="text-align: center; color: #888; margin-top: auto; margin-bottom: auto; font-size: 14px;">Nenhuma mensagem recebida ainda.</p>';
        return;
      }

      messages.forEach((msg) => {
        const msgDiv = document.createElement("div");
        msgDiv.style.cssText = "max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; word-wrap: break-word;";

        if (msg.sender === "admin") {
          msgDiv.style.alignSelf = "flex-end";
          msgDiv.style.background = "var(--blue-600)";
          msgDiv.style.color = "white";
          msgDiv.style.borderBottomRightRadius = "4px";
        } else {
          msgDiv.style.alignSelf = "flex-start";
          msgDiv.style.background = "#e5e5ea";
          msgDiv.style.color = "#333";
          msgDiv.style.borderBottomLeftRadius = "4px";
        }

        msgDiv.innerText = msg.text;
        bodyEl.appendChild(msgDiv);
      });

      if (wasAtBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  }

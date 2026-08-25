import { rtdb, auth } from './firebase-config.js';
import { ref, push, onValue, off, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
    // 1. Mapear Elementos
    const triggerBtn = document.getElementById('chat-trigger-btn');
    const closeBtn = document.getElementById('chat-close-btn');
    const chatWindow = document.getElementById('chat-window');
    const chatBody = document.getElementById('chat-body');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const emptyMsg = document.getElementById('chat-empty-msg');

    // 2. Lógica de Abrir/Fechar
    triggerBtn.addEventListener('click', () => {
        chatWindow.classList.add('active');
        triggerBtn.style.display = 'none';
        chatInput.focus();
    });

    closeBtn.addEventListener('click', () => {
        chatWindow.classList.remove('active');
        triggerBtn.style.display = 'flex';
    });

    // Enquanto não há uid autenticado (real ou anônimo), o formulário
    // fica bloqueado — a regra do RTDB exige auth.uid === $uid, então
    // não existe leitura/escrita válida sem isso.
    let currentUserId = null;
    let activeChatRef = null;
    let activeListenerCallback = null;

    chatInput.disabled = true;
    chatForm.querySelector('button[type="submit"]').disabled = true;

    // 3. Garante sessão autenticada — real (login) ou anônima.
    //    A regra do RTDB exige auth.uid === $uid; o antigo ID
    //    aleatório do localStorage não satisfaz isso mais.
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            try {
                await signInAnonymously(auth);
            } catch (error) {
                console.error("Falha ao autenticar visitante:", error);
            }
            return; // onAuthStateChanged dispara de novo quando a sessão anônima completar
        }

        currentUserId = user.uid;
        chatInput.disabled = false;
        chatForm.querySelector('button[type="submit"]').disabled = false;

        // Desconecta o listener da conversa anterior, se havia uma
        // (ex.: usuário estava anônimo e acabou de logar de verdade —
        // troca de uid, então troca de referência no banco).
        if (activeChatRef && activeListenerCallback) {
            off(activeChatRef, 'value', activeListenerCallback);
        }

        activeChatRef = ref(rtdb, `chats/${currentUserId}/messages`);
        activeListenerCallback = (snapshot) => {
            document.querySelectorAll('.chat-msg-wrapper').forEach(e => e.remove());

            if (snapshot.exists()) {
                emptyMsg.style.display = 'none';

                snapshot.forEach((childSnapshot) => {
                    const msgData = childSnapshot.val();
                    renderMessage(msgData.text, msgData.sender);
                });
            } else {
                emptyMsg.style.display = 'block';
            }

            chatBody.scrollTop = chatBody.scrollHeight;
        };

        onValue(activeChatRef, activeListenerCallback, (error) => {
            console.error("Erro ao ler mensagens:", error);
        });
    });

    // 4. Função para Desenhar a Mensagem com Etiquetas "Equipe de Suporte"
    function renderMessage(text, sender) {
        const wrapper = document.createElement('div');
        wrapper.classList.add('chat-msg-wrapper');
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'column';
        wrapper.style.marginBottom = '10px';

        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-msg');

        if (sender === 'user') {
            wrapper.style.alignItems = 'flex-end';
            msgDiv.classList.add('msg-right');
        } else {
            wrapper.style.alignItems = 'flex-start';
            msgDiv.classList.add('msg-left');

            const label = document.createElement('span');
            label.textContent = "Equipe de Suporte";
            label.style.fontSize = "11px";
            label.style.color = "#888";
            label.style.marginBottom = "4px";
            label.style.marginLeft = "4px";
            wrapper.appendChild(label);
        }

        msgDiv.textContent = text;
        wrapper.appendChild(msgDiv);
        chatBody.appendChild(wrapper);
    }

    // 5. Envio de Nova Mensagem
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!currentUserId || !activeChatRef) return; // ainda autenticando

        const textValue = chatInput.value.trim();
        if (!textValue) return;

        chatInput.value = '';

        try {
            // sender é sempre 'user' aqui — a regra do RTDB só aceita
            // esse valor em escritas de usuário; 'admin' só é gravado
            // pelo Worker, nunca pelo client.
            await push(activeChatRef, {
                text: textValue,
                sender: 'user',
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error("Erro ao enviar mensagem:", error);
            chatInput.value = textValue; // devolve o texto — não perde a mensagem
            alert("Erro ao conectar com o banco de dados. Tente novamente.");
        }
    });
});

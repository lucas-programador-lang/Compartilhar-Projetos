import { db } from './firebase-config.js'; 
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"; // Adapte a versão/URL se necessário para bater com o seu firebase-config.js

document.addEventListener('DOMContentLoaded', () => {
    // 1. Mapear Elementos da Tela
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
        triggerBtn.style.display = 'none'; // Esconde o botão ao abrir
        chatInput.focus();
    });

    closeBtn.addEventListener('click', () => {
        chatWindow.classList.remove('active');
        triggerBtn.style.display = 'flex'; // Volta o botão
    });

    // 3. Sistema de Sessão do Usuário
    // Se o usuário não tem um ID salvo, gera um aleatório e salva no localStorage
    let currentUserId = localStorage.getItem('chat_session_id');
    if (!currentUserId) {
        currentUserId = Math.random().toString(36).substring(2, 11);
        localStorage.setItem('chat_session_id', currentUserId);
    }

    // 4. Conexão em Tempo Real com o Firebase
    const chatCollectionRef = collection(db, `chats/${currentUserId}/messages`);
    const q = query(chatCollectionRef, orderBy("timestamp", "asc"));

    onSnapshot(q, (snapshot) => {
        // Limpa as mensagens antigas para não duplicar
        document.querySelectorAll('.chat-msg').forEach(e => e.remove());

        if (snapshot.docs.length > 0) {
            emptyMsg.style.display = 'none'; // Esconde a mensagem de boas-vindas
        }

        snapshot.docs.forEach((doc) => {
            const msgData = doc.data();
            renderMessage(msgData.text, msgData.sender);
        });

        // Rola para o final
        chatBody.scrollTop = chatBody.scrollHeight;
    });

    // 5. Função para Desenhar a Mensagem na Tela
    function renderMessage(text, sender) {
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-msg');
        
        if (sender === 'user') {
            msgDiv.classList.add('msg-right');
        } else {
            msgDiv.classList.add('msg-left'); // Quando você responder pelo painel Admin
        }

        msgDiv.textContent = text;
        chatBody.appendChild(msgDiv);
    }

    // 6. Envio de Nova Mensagem
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const textValue = chatInput.value.trim();
        if (!textValue) return;

        chatInput.value = ''; // Limpa rápido pro usuário

        try {
            await addDoc(chatCollectionRef, {
                text: textValue,
                sender: 'user',
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error("Erro ao enviar mensagem:", error);
            alert("Erro ao conectar com o suporte. Tente novamente.");
        }
    });
});

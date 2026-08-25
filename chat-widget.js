import { rtdb } from './firebase-config.js'; 
import { ref, push, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

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
    let currentUserId = localStorage.getItem('chat_session_id');
    if (!currentUserId) {
        currentUserId = Math.random().toString(36).substring(2, 11);
        localStorage.setItem('chat_session_id', currentUserId);
    }

    // 4. Conexão em Tempo Real com o Firebase (RTDB)
    const chatRef = ref(rtdb, `chats/${currentUserId}/messages`);

    onValue(chatRef, (snapshot) => {
        // Limpa as mensagens antigas da tela para não duplicar
        document.querySelectorAll('.chat-msg').forEach(e => e.remove());

        if (snapshot.exists()) {
            emptyMsg.style.display = 'none'; // Esconde a mensagem inicial
            
            // O RTDB devolve os dados em um formato diferente, iteramos por cada nó
            snapshot.forEach((childSnapshot) => {
                const msgData = childSnapshot.val();
                renderMessage(msgData.text, msgData.sender);
            });
        }

        // Rola o scroll para a última mensagem
        chatBody.scrollTop = chatBody.scrollHeight;
    });

    // 5. Função para Desenhar a Mensagem na Tela
    function renderMessage(text, sender) {
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-msg');
        
        if (sender === 'user') {
            msgDiv.classList.add('msg-right');
        } else {
            msgDiv.classList.add('msg-left'); // Para quando o Admin responder
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
            await push(chatRef, {
                text: textValue,
                sender: 'user',
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error("Erro ao enviar mensagem:", error);
            alert("Erro ao conectar com o banco de dados. Tente novamente.");
        }
    });
});

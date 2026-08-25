import { rtdb, auth } from './firebase-config.js'; // Importamos a Autenticação também
import { ref, push, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js"; // Observador de Login

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

    // 3. ID de Sessão Inicial (Caso não esteja logado)
    let currentUserId = localStorage.getItem('chat_session_id');
    if (!currentUserId) {
        currentUserId = Math.random().toString(36).substring(2, 11);
        localStorage.setItem('chat_session_id', currentUserId);
    }

    let chatRef = ref(rtdb, `chats/${currentUserId}/messages`);

    // 4. Se o usuário estiver logado na plataforma, trocamos para o ID real dele!
    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUserId = user.uid; // Pega o ID verdadeiro do cliente
            chatRef = ref(rtdb, `chats/${currentUserId}/messages`);
        }

        // Reconecta a leitura do banco de dados na pasta correta
        onValue(chatRef, (snapshot) => {
            // Limpa mensagens antigas da tela
            document.querySelectorAll('.chat-msg-wrapper').forEach(e => e.remove());

            if (snapshot.exists()) {
                emptyMsg.style.display = 'none'; 
                
                snapshot.forEach((childSnapshot) => {
                    const msgData = childSnapshot.val();
                    renderMessage(msgData.text, msgData.sender);
                });
            }

            chatBody.scrollTop = chatBody.scrollHeight;
        });
    });

    // 5. Função para Desenhar a Mensagem com Etiquetas "Equipe de Suporte"
    function renderMessage(text, sender) {
        // Criamos um "embrulho" (wrapper) para segurar a etiqueta e o balão
        const wrapper = document.createElement('div');
        wrapper.classList.add('chat-msg-wrapper');
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'column';
        wrapper.style.marginBottom = '10px';

        const msgDiv = document.createElement('div');
        msgDiv.classList.add('chat-msg');
        
        if (sender === 'user') {
            wrapper.style.alignItems = 'flex-end'; // Alinha o balão dele pra direita
            msgDiv.classList.add('msg-right');
        } else {
            wrapper.style.alignItems = 'flex-start'; // Alinha a sua resposta à esquerda
            msgDiv.classList.add('msg-left');
            
            // Adiciona a etiqueta de "Equipe de Suporte" em cima do balão
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

    // 6. Envio de Nova Mensagem
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const textValue = chatInput.value.trim();
        if (!textValue) return;

        chatInput.value = ''; 

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

import React, { useState, useEffect, useRef } from 'react';
import { ref, push, onValue, serverTimestamp, off } from 'firebase/database';
import { rtdb, auth } from './firebaseConfig'; // Ajuste o caminho para a sua configuração do Firebase
import { onAuthStateChanged } from 'firebase/auth';
import './ChatWidget.css';

// Gera um ID de sessão de forma estável, uma única vez, e só se necessário.
// Fica fora do componente para não ser recriado a cada render.
function getOrCreateSessionId() {
  let sessionId = localStorage.getItem('chat_session_id');
  if (!sessionId) {
    sessionId = crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
    localStorage.setItem('chat_session_id', sessionId);
  }
  return sessionId;
}

export default function ChatWidget({ userId }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [sendError, setSendError] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(userId || getOrCreateSessionId());

  const messagesEndRef = useRef(null);

  // Se não veio userId por prop, observa o login real do Firebase Auth
  // e troca o ID de sessão temporário pelo UID assim que disponível.
  useEffect(() => {
    if (userId) {
      setCurrentUserId(userId);
      return;
    }
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setCurrentUserId(user ? user.uid : getOrCreateSessionId());
    });
    return () => unsubscribeAuth();
  }, [userId]);

  // Lê as mensagens do RTDB para o usuário atual
  useEffect(() => {
    if (!currentUserId) return;

    const chatRef = ref(rtdb, `chats/${currentUserId}/messages`);

    const unsubscribe = onValue(
      chatRef,
      (snapshot) => {
        const data = snapshot.val();
        if (!data) {
          setMessages([]);
          return;
        }
        // RTDB retorna um objeto { pushId: {...} }, não um array
        const messagesData = Object.entries(data)
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        setMessages(messagesData);
      },
      (error) => {
        console.error('Erro ao ler mensagens:', error);
      }
    );

    return () => off(chatRef, 'value', unsubscribe);
  }, [currentUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (e) => {
    e.preventDefault();
    const msgText = inputText.trim();
    if (!msgText || !currentUserId) return;

    setInputText('');
    setSendError(null);

    try {
      const chatRef = ref(rtdb, `chats/${currentUserId}/messages`);
      await push(chatRef, {
        text: msgText,
        sender: 'user',
        timestamp: serverTimestamp(),
      });
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
      setSendError('Não foi possível enviar. Tente novamente.');
      setInputText(msgText); // devolve o texto pro usuário não perder a mensagem
    }
  };

  return (
    <div className="chat-widget-container">
      {!isOpen ? (
        <button className="chat-trigger-btn" onClick={() => setIsOpen(true)}>
          <span className="chat-icon">💬</span> Ajuda
        </button>
      ) : (
        <div className="chat-window active">
          <div className="chat-header">
            <h4>Suporte Compartilhar Projetos</h4>
            <button className="close-btn" onClick={() => setIsOpen(false)}>✕</button>
          </div>

          <div className="chat-body">
            {messages.length === 0 && (
              <p className="chat-empty">Olá! Como podemos te ajudar hoje?</p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`chat-msg ${msg.sender === 'user' ? 'msg-right' : 'msg-left'}`}
              >
                {msg.sender !== 'user' && (
                  <span className="chat-msg-label">Equipe de Suporte</span>
                )}
                {msg.text}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {sendError && <p className="chat-error">{sendError}</p>}

          <form onSubmit={sendMessage} className="chat-footer">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Digite sua dúvida..."
              autoFocus
            />
            <button type="submit" disabled={!inputText.trim()}>
              Enviar
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useRef } from 'react';
import { ref, push, onValue, serverTimestamp } from 'firebase/database';
import { rtdb, auth } from './firebase-config'; // corrigido: era './firebaseConfig'
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import './ChatWidget.css';

export default function ChatWidget({ userId }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [sendError, setSendError] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(userId || null);

  const messagesEndRef = useRef(null);

  // Garante uma sessão autenticada — real (login) ou anônima. A regra
  // do RTDB exige $uid === auth.uid, então sem isso nenhum visitante
  // consegue ler/escrever no próprio chat.
  useEffect(() => {
    if (userId) {
      setCurrentUserId(userId);
      return;
    }

    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUserId(user.uid);
        return;
      }
      // Sem sessão nenhuma — cria uma anônima. onAuthStateChanged
      // dispara de novo assim que ela completa, com o uid definido.
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error('Falha ao autenticar visitante:', error);
        setSendError('Não foi possível iniciar o chat. Recarregue a página.');
      }
    });

    return () => unsubscribeAuth();
  }, [userId]);

  useEffect(() => {
    if (!currentUserId) return;

    const chatRef = ref(rtdb, `chats/${currentUserId}/messages`);

    // onValue() já retorna a própria função de "desinscrever" (SDK v9+).
    // Antes o código chamava off(chatRef, 'value', unsubscribe) passando
    // essa função de retorno como se fosse o callback original — isso
    // não remove o listener de verdade, e a cada remount do componente
    // um novo listener se acumulava (causando mensagens duplicadas).
    const unsubscribe = onValue(
      chatRef,
      (snapshot) => {
        const data = snapshot.val();
        if (!data) {
          setMessages([]);
          return;
        }
        const messagesData = Object.entries(data)
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        setMessages(messagesData);
      },
      (error) => {
        console.error('Erro ao ler mensagens:', error);
      }
    );

    return () => unsubscribe();
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
      // sender é sempre 'user' aqui — a regra do RTDB só aceita esse
      // valor para escritas de usuário; 'admin' só é gravado pelo
      // Worker, com service account, nunca pelo client.
      await push(chatRef, {
        text: msgText,
        sender: 'user',
        timestamp: serverTimestamp(),
      });
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
      setSendError('Não foi possível enviar. Tente novamente.');
      setInputText(msgText);
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
              disabled={!currentUserId}
            />
            <button type="submit" disabled={!inputText.trim() || !currentUserId}>
              Enviar
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

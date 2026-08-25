import React, { useState, useEffect, useRef } from 'react';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { db } from './firebaseConfig'; // Ajuste o caminho para a sua configuração do Firebase
import './ChatWidget.css'; // Vamos criar esse arquivo no próximo passo

export default function ChatWidget({ userId }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  
  // Se o usuário não estiver logado, cria um ID temporário no navegador
  const currentUserId = userId || localStorage.getItem('chat_session_id') || Math.random().toString(36).substr(2, 9);
  
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!userId && !localStorage.getItem('chat_session_id')) {
      localStorage.setItem('chat_session_id', currentUserId);
    }

    // Estrutura: chats -> [currentUserId] -> messages
    const q = query(
      collection(db, `chats/${currentUserId}/messages`), 
      orderBy("timestamp", "asc")
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const messagesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setMessages(messagesData);
      
      // Rola para a última mensagem automaticamente
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    });

    return () => unsubscribe();
  }, [currentUserId, userId]);

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const msgText = inputText;
    setInputText(""); // Limpa o input imediatamente para melhor UX

    await addDoc(collection(db, `chats/${currentUserId}/messages`), {
      text: msgText,
      sender: "user", // Quem enviou
      timestamp: serverTimestamp()
    });
  };

  return (
    <div className="chat-widget-container">
      {!isOpen ? (
        <button className="chat-trigger-btn" onClick={() => setIsOpen(true)}>
          <span className="chat-icon">💬</span> Ajuda
        </button>
      ) : (
        <div className="chat-window">
          <div className="chat-header">
            <h4>Suporte Compartilhar Projetos</h4>
            <button className="close-btn" onClick={() => setIsOpen(false)}>✕</button>
          </div>
          
          <div className="chat-body">
            {messages.length === 0 && (
              <p className="chat-empty">Olá! Como podemos te ajudar hoje?</p>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`chat-msg ${msg.sender === "user" ? "msg-right" : "msg-left"}`}>
                {msg.text}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={sendMessage} className="chat-footer">
            <input 
              type="text" 
              value={inputText} 
              onChange={(e) => setInputText(e.target.value)} 
              placeholder="Digite sua dúvida..." 
              autoFocus
            />
            <button type="submit">Enviar</button>
          </form>
        </div>
      )}
    </div>
  );
}

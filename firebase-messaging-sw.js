// firebase-messaging-sw.js
// Importa os scripts do Firebase em segundo plano
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

// Inicializa o Firebase com as SUAS credenciais exatas
firebase.initializeApp({
  apiKey: "AIzaSyBCKc-GYryZhx-DYm-tfxJrBbpg4zc0JIg",
  authDomain: "compartilhar-projetos.firebaseapp.com",
  databaseURL: "https://compartilhar-projetos-default-rtdb.firebaseio.com",
  projectId: "compartilhar-projetos",
  storageBucket: "compartilhar-projetos.firebasestorage.app",
  messagingSenderId: "421523492483",
  appId: "1:421523492483:web:6e7289000a8915e32655b6"
});

const messaging = firebase.messaging();

// Escuta as mensagens quando o site está fechado ou em segundo plano
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Mensagem recebida em background ', payload);
  
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/favicon-192x192.png', // Certifique-se de que este ícone existe na sua pasta
    data: payload.data
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

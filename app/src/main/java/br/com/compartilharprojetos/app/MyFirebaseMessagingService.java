package br.com.compartilharprojetos.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class MyFirebaseMessagingService extends FirebaseMessagingService {

    private static final String TAG = "FCMService";
    private static final String CHANNEL_ID = "default_channel_id"; 

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        String titulo = "Compartilhar Projetos";
        String mensagem = "Você tem uma nova atualização.";

        // 1. Captura Título e Mensagem (Payload de Notificação)
        if (remoteMessage.getNotification() != null) {
            if (remoteMessage.getNotification().getTitle() != null) {
                titulo = remoteMessage.getNotification().getTitle();
            }
            if (remoteMessage.getNotification().getBody() != null) {
                mensagem = remoteMessage.getNotification().getBody();
            }
        } 
        // 2. Captura Título e Mensagem (Payload de Dados)
        else if (remoteMessage.getData().size() > 0) {
            if (remoteMessage.getData().containsKey("title")) {
                titulo = remoteMessage.getData().get("title");
            }
            if (remoteMessage.getData().containsKey("body")) {
                mensagem = remoteMessage.getData().get("body");
            }
        }

        // 3. LÓGICA DE ROTEAMENTO (Deep Linking Avançado)
        String rotaFinal = null;
        
        // A) Primeiro tenta ver se o backend enviou a rota exata (ex: "/projeto/123")
        if (remoteMessage.getData().containsKey("rota")) {
            rotaFinal = remoteMessage.getData().get("rota");
        } 
        // B) Se não enviou rota exata, usa o seu sistema inteligente de Tipo
        else if (remoteMessage.getData().containsKey("tipo")) {
            String tipo = remoteMessage.getData().get("tipo");
            rotaFinal = rotaParaTipo(tipo);
        }

        mostrarNotificacao(titulo, mensagem, rotaFinal);
    }

    private String rotaParaTipo(String tipo) {
        if (tipo == null) return null;
        switch (tipo) {
            case "comentario":
            case "resposta":
                return "/comunidade";
            case "saque_aprovado":
            case "saque_recusado":
                return "/painel";
            default:
                return null; 
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.d(TAG, "Novo token FCM gerado: " + token);
        MainActivity.enviarTokenParaWebView(token);
    }

    private void mostrarNotificacao(String titulo, String mensagem, String rota) {
        NotificationManager notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Notificações Gerais",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.enableVibration(true);
            notificationManager.createNotificationChannel(channel);
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        
        // Anexa a rota ao intent para que o MainActivity saiba para onde ir
        if (rota != null && !rota.isEmpty()) {
            intent.putExtra("rota", rota);
        }
        
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher_round)
                .setColor(Color.parseColor("#0b0b10")) 
                .setContentTitle(titulo)
                .setContentText(mensagem)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(mensagem))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(pendingIntent);

        // Usa IDs baseados no tempo para as notificações não se apagarem umas às outras
        notificationManager.notify((int) System.currentTimeMillis(), builder.build());
    }
}
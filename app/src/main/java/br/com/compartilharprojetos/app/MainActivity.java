package br.com.compartilharprojetos.app;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricPrompt;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.webkit.WebViewAssetLoader;

import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.UpdateAvailability;
import com.google.firebase.messaging.FirebaseMessaging;

import java.io.File;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.concurrent.Executor;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private SwipeRefreshLayout swipeRefreshLayout;
    private ProgressBar progressBar;
    
    // Suporte a Tela Cheia (Vídeos)
    private FrameLayout customViewContainer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    // Asset Loader (Carregamento Rápido de Ficheiros)
    private WebViewAssetLoader assetLoader;

    // Callbacks da rede
    private ConnectivityManager.NetworkCallback networkCallback;

    // Gerenciamento de Ficheiros e Câmera
    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private ActivityResultLauncher<String> requestPermissionLauncher;
    private ActivityResultLauncher<String> requestCameraPermissionLauncher;
    private String mCameraPhotoPath;
    
    private ValueCallback<Uri[]> pendingFilePathCallback;
    private WebChromeClient.FileChooserParams pendingFileChooserParams;
    
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private ActivityResultLauncher<String[]> requestLocationPermissionLauncher;

    private String pendingDownloadUrl, pendingDownloadMimeType, pendingDownloadContentDisposition;
    private ActivityResultLauncher<String> requestStoragePermissionLauncher;

    private static final String URL_HOME = "https://compartilhar-projetos.com.br/";
    private boolean erroDeConexao = false;
    private boolean siteCarregando = true;
    private String rotaAtual = "/";
    
    private long tempoUltimoCliqueVoltar = 0;
    private static WeakReference<MainActivity> instanciaAtual;

    // --- VARIÁVEIS PARA A ATUALIZAÇÃO AUTOMÁTICA ---
    private long downloadIdAtual = -1;

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != -1) {
                instalarApkBaixado(id);
            }
        }
    };
    // -----------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        instanciaAtual = new WeakReference<>(this);
        splashScreen.setKeepOnScreenCondition(() -> siteCarregando);

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (siteCarregando) siteCarregando = false; 
        }, 8000);

        verificarAtualizacaoPlayStore();
        criarCanalDeNotificacoes();
        configurarPedidoDePermissoesAtivas();

        configurarJanela();
        configurarInterface();
        configurarSeletorDeArquivos();
        configurarWebView();
        configurarGestorDeDownloads();
        configurarNavegacaoDeGestos();
        monitorarRedeEmTempoReal();

        // Regista o ouvinte para instalar o APK assim que o download terminar
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, filter);
        }

        if (savedInstanceState == null) {
            processarIntentRecebida(getIntent());
        } else {
            webView.restoreState(savedInstanceState);
        }

        pedirPermissaoNotificacao();
    }

    private void processarIntentRecebida(Intent intent) {
        if (intent == null) return;
        
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String textoPartilhado = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (textoPartilhado != null) {
                webView.loadUrl(URL_HOME + "?linkRecebido=" + Uri.encode(textoPartilhado));
                return;
            }
        }

        Uri data = intent.getData();
        if (data != null) {
            webView.loadUrl(data.toString());
        } else {
            String rotaDestino = intent.getExtras() != null ? intent.getStringExtra("rota") : null;
            if (rotaDestino != null && !rotaDestino.isEmpty()) webView.loadUrl(URL_HOME + "#" + rotaDestino);
            else webView.loadUrl(URL_HOME);
        }
    }

    private boolean isModoEscuro() {
        int nightModeFlags = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        return nightModeFlags == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    private void verificarAtualizacaoPlayStore() {
        AppUpdateManager appUpdateManager = AppUpdateManagerFactory.create(this);
        appUpdateManager.getAppUpdateInfo().addOnSuccessListener(appUpdateInfo -> {
            if (appUpdateInfo.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                  && appUpdateInfo.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)) {
                try {
                    appUpdateManager.startUpdateFlowForResult(appUpdateInfo, AppUpdateType.IMMEDIATE, this, 100);
                } catch (Exception ignored) {}
            }
        });
    }

    private void configurarInterface() {
        FrameLayout rootLayout = new FrameLayout(this);
        int corFundo = isModoEscuro() ? Color.rgb(11, 11, 16) : Color.WHITE;
        rootLayout.setBackgroundColor(corFundo);

        // --- CÓDIGO NOVO: Evita que o site passe por trás da barra de status (hora/bateria) ---
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(rootLayout, (v, windowInsets) -> {
            androidx.core.graphics.Insets insets = windowInsets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());
            v.setPadding(0, insets.top, 0, insets.bottom);
            return windowInsets;
        });
        // -------------------------------------------------------------------------------------

        swipeRefreshLayout = new SwipeRefreshLayout(this);
        swipeRefreshLayout.setProgressBackgroundColorSchemeColor(corFundo);
        swipeRefreshLayout.setColorSchemeColors(Color.rgb(108, 99, 255));
        swipeRefreshLayout.setOnRefreshListener(() -> {
            erroDeConexao = false;
            webView.loadUrl(URL_HOME);
        });

        webView = new WebView(this);
        swipeRefreshLayout.addView(webView);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(255, 193, 7)));
        progressBar.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 8));

        customViewContainer = new FrameLayout(this);
        customViewContainer.setBackgroundColor(Color.BLACK);
        customViewContainer.setVisibility(View.GONE);

        rootLayout.addView(swipeRefreshLayout);
        rootLayout.addView(progressBar);
        rootLayout.addView(customViewContainer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configurarWebView() {
        int corFundo = isModoEscuro() ? Color.rgb(11, 11, 16) : Color.WHITE;
        webView.setBackgroundColor(corFundo);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setGeolocationEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " CompartilharProjetosApp/1.0");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.addJavascriptInterface(new WebAppInterface(), "Android");
        definirClientesWeb();
    }

    private void definirClientesWeb() {
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress == 100) progressBar.setVisibility(View.GONE);
                else {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                }
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewContainer.addView(customView);
                customViewContainer.setVisibility(View.VISIBLE);
                swipeRefreshLayout.setVisibility(View.GONE);
                customViewCallback = callback;
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                customViewContainer.setVisibility(View.GONE);
                customViewContainer.removeView(customView);
                swipeRefreshLayout.setVisibility(View.VISIBLE);
                customView = null;
                if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestLocationPermissionLauncher.launch(new String[]{ android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION });
                } else {
                    callback.invoke(origin, true, false);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    pendingFilePathCallback = filePathCallback;
                    pendingFileChooserParams = fileChooserParams;
                    requestCameraPermissionLauncher.launch(android.Manifest.permission.CAMERA);
                    return true;
                } else return abrirSeletorDeArquivos(filePathCallback, fileChooserParams);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                
                if (uri.getScheme() != null && uri.getScheme().equals("https") && uri.getHost() != null && uri.getHost().equals("appassets.androidplatform.net")) {
                    return assetLoader.shouldInterceptRequest(uri);
                }
                
                String url = uri.toString();
                if (url.endsWith(".png") || url.endsWith(".jpg") || url.endsWith(".jpeg") || url.endsWith(".svg")) {
                    try {
                        String fileName = uri.getLastPathSegment();
                        if (fileName != null) {
                            String mimeType = url.endsWith(".png") ? "image/png" : url.endsWith(".svg") ? "image/svg+xml" : "image/jpeg";
                            return new WebResourceResponse(mimeType, "UTF-8", getAssets().open("cache_nativa/" + fileName));
                        }
                    } catch (IOException ignored) {}
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                
                if (url.startsWith("intent://") || url.startsWith("pix:") || url.contains("mercadopago") || url.contains("vizzionpay") || url.contains("primepag") || url.contains("cora") || url.contains("abacatepay")) {
                    try {
                        Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                        if (intent.resolveActivity(getPackageManager()) != null) {
                            startActivity(intent);
                            return true;
                        }
                    } catch (Exception e) {}
                }
                
                if (url.startsWith("whatsapp://") || url.startsWith("tel:") || url.startsWith("mailto:") || url.startsWith("geo:")) {
                    return abrirAppExterno(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                }
                
                if (url.endsWith(".apk") || url.contains("github.com") && url.contains("releases/download")) {
                    return false; 
                }
                
                if (url.startsWith("http") && !url.contains("compartilhar-projetos.com.br")) {
                    abrirLinkExternoComCustomTabs(url);
                    return true;
                }
                
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) injetarTelaDeErro();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                swipeRefreshLayout.setRefreshing(false);
                siteCarregando = false;
                registrarTokenFCM();
            }
        });
    }

    private void configurarNavegacaoDeGestos() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customView != null) {
                    webView.getWebChromeClient().onHideCustomView();
                } 
                else if (erroDeConexao || rotaAtual.equals("/") || rotaAtual.equals("")) {
                    if (System.currentTimeMillis() - tempoUltimoCliqueVoltar < 2000) finish();
                    else {
                        Toast.makeText(MainActivity.this, "Pressione voltar novamente para sair", Toast.LENGTH_SHORT).show();
                        tempoUltimoCliqueVoltar = System.currentTimeMillis();
                    }
                } 
                else {
                    if (webView != null) {
                        webView.evaluateJavascript("javascript:if(typeof window.AndroidVoltar === 'function') { window.AndroidVoltar(); } else { window.history.back(); }", null);
                    }
                }
            }
        });
    }

    private void injetarTelaDeErro() {
        erroDeConexao = true;
        swipeRefreshLayout.setRefreshing(false);
        String erroHtml = "<html><body style='background-color:#0b0b10; color:#ffffff; text-align:center; padding-top:40%; font-family:sans-serif;'><h3>Algo deu errado</h3><p>Puxe a tela para baixo para tentar novamente.</p></body></html>";
        webView.loadDataWithBaseURL(URL_HOME, erroHtml, "text/html", "UTF-8", null);
    }
    
    private void configurarPedidoDePermissoesAtivas() {
        requestPermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestPermission(), isGranted -> {
            if (!isGranted) Toast.makeText(this, "Notificações desativadas.", Toast.LENGTH_SHORT).show();
        });

        requestCameraPermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestPermission(), isGranted -> {
            if (isGranted) {
                if (pendingFilePathCallback != null && pendingFileChooserParams != null) abrirSeletorDeArquivos(pendingFilePathCallback, pendingFileChooserParams);
            } else {
                Toast.makeText(this, "Permissão de câmera negada.", Toast.LENGTH_LONG).show();
                if (pendingFilePathCallback != null) { pendingFilePathCallback.onReceiveValue(null); pendingFilePathCallback = null; }
            }
            pendingFileChooserParams = null; 
        });

        requestLocationPermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
            Boolean fineGranted = result.get(android.Manifest.permission.ACCESS_FINE_LOCATION);
            if ((fineGranted != null && fineGranted)) {
                if (pendingGeoCallback != null) pendingGeoCallback.invoke(pendingGeoOrigin, true, false);
            } else {
                if (pendingGeoCallback != null) pendingGeoCallback.invoke(pendingGeoOrigin, false, false);
                Toast.makeText(this, "Permissão de localização negada.", Toast.LENGTH_SHORT).show();
            }
            pendingGeoCallback = null; pendingGeoOrigin = null;
        });

        requestStoragePermissionLauncher = registerForActivityResult(new ActivityResultContracts.RequestPermission(), isGranted -> {
            if (isGranted && pendingDownloadUrl != null) executarDownload(pendingDownloadUrl, pendingDownloadContentDisposition, pendingDownloadMimeType);
            else Toast.makeText(this, "Permissão necessária para salvar arquivos.", Toast.LENGTH_LONG).show();
            pendingDownloadUrl = null;
        });
    }

    private void pedirPermissaoNotificacao() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS);
            }
        }
    }

    private void criarCanalDeNotificacoes() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel("default_channel_id", "Notificações Gerais", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Alertas de projetos e comunidade.");
            channel.enableVibration(true);
            NotificationManager notificationManager = getSystemService(NotificationManager.class);
            if (notificationManager != null) notificationManager.createNotificationChannel(channel);
        }
    }

    private void monitorarRedeEmTempoReal() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    runOnUiThread(() -> { if (erroDeConexao && webView != null) { erroDeConexao = false; webView.loadUrl(URL_HOME); } });
                }
                @Override
                public void onLost(@NonNull Network network) {
                    runOnUiThread(() -> { if (webView != null) webView.evaluateJavascript("javascript:if(typeof window.alertaSemInternet === 'function') window.alertaSemInternet();", null); });
                }
            };
            cm.registerDefaultNetworkCallback(networkCallback);
        }
    }

    // --- FUNÇÃO PARA ABRIR O INSTALADOR DO APK ---
    private void instalarApkBaixado(long id) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            Uri apkUri = dm.getUriForDownloadedFile(id);
            
            if (apkUri == null) {
                File apkFile = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "compartilhar-projetos.apk");
                if (apkFile.exists()) {
                    apkUri = FileProvider.getUriForFile(this, getPackageName() + ".provider", apkFile);
                }
            }

            if (apkUri != null) {
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(installIntent);
            }
        } catch (Exception e) {
            Toast.makeText(this, "Abra a pasta Downloads do celular para instalar a atualização.", Toast.LENGTH_LONG).show();
        }
    }

    public class WebAppInterface {
        @JavascriptInterface public void siteTotalmenteCarregado() { siteCarregando = false; }
        @JavascriptInterface public void atualizarRota(String rota) { rotaAtual = rota; }
        @JavascriptInterface public void solicitarBiometria() { runOnUiThread(() -> mostrarPromptBiometria()); }
        @JavascriptInterface public void mostrarToast(String mensagem) { runOnUiThread(() -> Toast.makeText(getApplicationContext(), mensagem, Toast.LENGTH_SHORT).show()); }
        @JavascriptInterface public void solicitarTokenFCM() { registrarTokenFCM(); }
        
        @JavascriptInterface
        public String obterVersaoApp() {
            try {
                return MainActivity.this.getPackageManager().getPackageInfo(MainActivity.this.getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "1.0.0";
            }
        }
        
        @JavascriptInterface
        public void vibrarCelular() {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createOneShot(100, VibrationEffect.DEFAULT_AMPLITUDE));
                else v.vibrate(100);
            }
        }

        @JavascriptInterface
        public void compartilhar(String titulo, String texto, String url) {
            runOnUiThread(() -> {
                Intent sendIntent = new Intent(Intent.ACTION_SEND);
                sendIntent.putExtra(Intent.EXTRA_TITLE, titulo);
                sendIntent.putExtra(Intent.EXTRA_TEXT, texto + "\n\n" + url);
                sendIntent.setType("text/plain");
                startActivity(Intent.createChooser(sendIntent, "Compartilhar usando..."));
            });
        }

        @JavascriptInterface
        public void baixarApkDireto(String urlParaBaixar) {
            runOnUiThread(() -> {
                try {
                    File arquivoAntigo = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "compartilhar-projetos.apk");
                    if (arquivoAntigo.exists()) arquivoAntigo.delete();

                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(urlParaBaixar));
                    request.setMimeType("application/vnd.android.package-archive");
                    request.addRequestHeader("cookie", CookieManager.getInstance().getCookie(urlParaBaixar));
                    request.allowScanningByMediaScanner();
                    request.setTitle("Compartilhar Projetos");
                    request.setDescription("Baixando atualização...");
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "compartilhar-projetos.apk");
                    
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) {
                        downloadIdAtual = dm.enqueue(request); 
                        Toast.makeText(getApplicationContext(), "Download iniciado. Aguarde a instalação...", Toast.LENGTH_LONG).show();
                    }
                } catch (Exception e) {
                    Toast.makeText(getApplicationContext(), "Erro ao iniciar download", Toast.LENGTH_SHORT).show();
                }
            });
        }
    }

    private void mostrarPromptBiometria() {
        Executor executor = ContextCompat.getMainExecutor(this);
        BiometricPrompt biometricPrompt = new BiometricPrompt(MainActivity.this, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                super.onAuthenticationSucceeded(result);
                webView.evaluateJavascript("javascript:biometriaAprovada()", null);
            }
        });
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder().setTitle("Segurança Compartilhar Projetos").setSubtitle("Confirme sua identidade").setNegativeButtonText("Cancelar").build();
        biometricPrompt.authenticate(promptInfo);
    }

    private File criarArquivoDeImagem() throws IOException {
        @SuppressLint("SimpleDateFormat") String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss").format(new Date());
        return File.createTempFile("JPEG_" + timeStamp + "_", ".jpg", getExternalFilesDir(Environment.DIRECTORY_PICTURES));
    }
    
    private boolean abrirSeletorDeArquivos(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (MainActivity.this.filePathCallback != null) MainActivity.this.filePathCallback.onReceiveValue(null);
        MainActivity.this.filePathCallback = callback;

        Intent takePictureIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (takePictureIntent.resolveActivity(getPackageManager()) != null) {
            File photoFile = null;
            try {
                photoFile = criarArquivoDeImagem();
                takePictureIntent.putExtra("PhotoPath", mCameraPhotoPath);
            } catch (IOException ex) { Toast.makeText(MainActivity.this, "Erro ao abrir câmera", Toast.LENGTH_SHORT).show(); }
            if (photoFile != null) {
                mCameraPhotoPath = "file:" + photoFile.getAbsolutePath();
                takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".provider", photoFile));
            } else takePictureIntent = null;
        }

        Intent contentSelectionIntent = new Intent(Intent.ACTION_GET_CONTENT);
        contentSelectionIntent.addCategory(Intent.CATEGORY_OPENABLE);
        contentSelectionIntent.setType("image/*");
        contentSelectionIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);

        Intent chooserIntent = new Intent(Intent.ACTION_CHOOSER);
        chooserIntent.putExtra(Intent.EXTRA_INTENT, contentSelectionIntent);
        chooserIntent.putExtra(Intent.EXTRA_TITLE, "Selecionar Imagem");
        chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, takePictureIntent != null ? new Intent[]{takePictureIntent} : new Intent[0]);

        try { fileChooserLauncher.launch(chooserIntent); } catch (ActivityNotFoundException e) { MainActivity.this.filePathCallback = null; return false; }
        return true;
    }

    private void configurarJanela() {
        boolean escuro = isModoEscuro();
        int corFundo = escuro ? Color.rgb(11, 11, 16) : Color.WHITE;
        getWindow().setStatusBarColor(corFundo);
        getWindow().setNavigationBarColor(corFundo);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(!escuro);
    }

    private void abrirLinkExternoComCustomTabs(String url) {
        CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder().setToolbarColor(Color.rgb(11, 11, 16)).build();
        customTabsIntent.launchUrl(this, Uri.parse(url));
    }

    private void processarPedidoDeDownload(String url, String contentDisposition, String mimeType) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && ContextCompat.checkSelfPermission(this, android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUrl = url; pendingDownloadContentDisposition = contentDisposition; pendingDownloadMimeType = mimeType;
            requestStoragePermissionLauncher.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE);
        } else executarDownload(url, contentDisposition, mimeType);
    }

    private void executarDownload(String url, String contentDisposition, String mimetype) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimetype);
            request.addRequestHeader("cookie", CookieManager.getInstance().getCookie(url));
            request.allowScanningByMediaScanner();
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, android.webkit.URLUtil.guessFileName(url, contentDisposition, mimetype));
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm != null) { dm.enqueue(request); Toast.makeText(getApplicationContext(), "A descarregar atualização...", Toast.LENGTH_SHORT).show(); }
        } catch (Exception e) { Toast.makeText(this, "Erro ao iniciar download", Toast.LENGTH_SHORT).show(); }
    }

    private void configurarGestorDeDownloads() {
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> processarPedidoDeDownload(url, contentDisposition, mimetype));
    }

    private void configurarSeletorDeArquivos() {
        fileChooserLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (result.getResultCode() == RESULT_OK) {
                    if (result.getData() != null) {
                        ClipData clipData = result.getData().getClipData();
                        if (clipData != null) {
                            results = new Uri[clipData.getItemCount()];
                            for (int i = 0; i < clipData.getItemCount(); i++) results[i] = clipData.getItemAt(i).getUri();
                        } else if (result.getData().getDataString() != null) results = new Uri[]{Uri.parse(result.getData().getDataString())};
                    } else if (mCameraPhotoPath != null) results = new Uri[]{Uri.parse(mCameraPhotoPath)};
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        });
    }

    private boolean abrirAppExterno(Intent intent) {
        try { startActivity(intent); return true; } catch (Exception e) { return false; }
    }

    private void registrarTokenFCM() {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful()) enviarTokenAoWeb(task.getResult());
        });
    }

    private void enviarTokenAoWeb(String token) {
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript("javascript:if(typeof window.salvarTokenPush === 'function') window.salvarTokenPush('" + token + "');", null);
        });
    }

    public static void enviarTokenParaWebView(String token) {
        if (instanciaAtual != null) {
            MainActivity activity = instanciaAtual.get();
            if (activity != null) {
                activity.enviarTokenAoWeb(token);
            }
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        processarIntentRecebida(intent);
    }

    @Override protected void onPause() { super.onPause(); if (webView != null) webView.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(downloadReceiver); } catch(Exception e) {} // Desliga o ouvinte de downloads

        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null && networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { cm.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
        }
        if (instanciaAtual != null && instanciaAtual.get() == this) instanciaAtual.clear();
        if (webView != null) {
            webView.clearHistory(); webView.clearCache(true); webView.loadUrl("about:blank");
            webView.onPause(); webView.removeAllViews(); webView.destroy(); webView = null;
        }
        super.onDestroy();
    }
}

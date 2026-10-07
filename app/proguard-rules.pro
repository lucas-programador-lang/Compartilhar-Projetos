# Protege a comunicação entre o seu Site (Javascript) e o Java
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class br.com.compartilharprojetos.app.MainActivity$WebAppInterface { *; }
document.addEventListener("DOMContentLoaded", function() {
  // 1. Injeta o visual do Modal (HTML e CSS) na página
  const modalHTML = `
    <style>
      #updateModal {
        display: none; position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background-color: #1e1e24; color: #ffffff; padding: 24px; border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 99999; width: 90%; max-width: 400px;
        font-family: sans-serif; border: 1px solid #333;
      }
      #updateModal h4 { margin: 0 0 12px 0; font-size: 18px; font-weight: 600; }
      #updateModal p { margin: 0 0 24px 0; font-size: 14px; color: #b3b3b3; line-height: 1.5; }
      .update-buttons { display: flex; justify-content: flex-end; gap: 12px; }
      .btn-update-later { background: transparent; color: #b3b3b3; border: none; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
      .btn-update-later:hover { background: #2a2a35; }
      .btn-update-now { background: #6c63ff; color: #ffffff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; text-decoration: none; font-size: 14px; font-weight: 600; }
      .btn-update-now:hover { background: #5750d4; }
    </style>
    <div id="updateModal">
      <h4>Atualização Disponível</h4>
      <p>Uma nova versão do aplicativo Compartilhar Projetos foi lançada. Recomendamos a atualização para manter o desempenho e a segurança do sistema.</p>
      <div class="update-buttons">
        <button class="btn-update-later" onclick="document.getElementById('updateModal').style.display='none'">Agora não</button>
        <a href="https://github.com/lucas-programador-lang/Compartilhar-Projetos/releases/latest/download/compartilhar-projetos.apk" class="btn-update-now">Atualizar</a>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  // 2. Lógica para verificar a versão no GitHub
  if (typeof Android !== 'undefined' && typeof Android.obterVersaoApp === 'function') {
    var versaoInstalada = Android.obterVersaoApp();
    
    fetch("https://api.github.com/repos/lucas-programador-lang/Compartilhar-Projetos/releases/latest")
      .then(response => response.json())
      .then(data => {
        if (data.tag_name) {
          var versaoMaisRecente = data.tag_name.replace('v', '');
          
          if (versaoInstalada !== "1.0.0" && versaoInstalada !== versaoMaisRecente) {
            document.getElementById('updateModal').style.display = 'block';
          }
        }
      })
      .catch(error => console.error("Erro ao verificar atualizações.", error));
  }
});

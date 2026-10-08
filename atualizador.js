document.addEventListener("DOMContentLoaded", function() {
  const modalHTML = `
    <style>
      #bloqueioFundo {
        display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(11, 11, 16, 0.95); z-index: 99998; backdrop-filter: blur(8px);
      }
      #updateModal {
        display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background-color: #1e1e24; color: #ffffff; padding: 32px; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.8); z-index: 99999; width: 90%; max-width: 380px;
        font-family: sans-serif; border: 1px solid #333; text-align: center;
      }
      #updateModal h4 { margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #ffffff; }
      #updateModal p { margin: 0 0 24px 0; font-size: 15px; color: #b3b3b3; line-height: 1.5; }
      .btn-update-now {
        display: inline-block; background: #6c63ff; color: #ffffff; border: none; padding: 14px 24px;
        border-radius: 8px; cursor: pointer; text-decoration: none; font-size: 16px; font-weight: 600; width: 100%;
        box-sizing: border-box;
      }
      .btn-update-now:hover { background: #5750d4; }
      .btn-support {
        display: inline-block; margin-top: 18px; color: #25D366; text-decoration: none; font-size: 14px; font-weight: 500;
      }
      .btn-support:hover { text-decoration: underline; }
    </style>
    
    <div id="bloqueioFundo"></div>
    <div id="updateModal">
      <h4>Atualização Obrigatória</h4>
      <p>Lançámos uma nova versão com melhorias importantes de segurança e desempenho. Para continuar a utilizar o Compartilhar Projetos, instale a atualização mais recente.</p>
      
      <!-- TRUQUE: Usa a função nativa do Android para abrir a gaveta de cópia -->
      <button onclick="Android.compartilhar('Atualização Necessária', 'Copie o link abaixo e cole no Chrome do seu celular para baixar a nova versão do Compartilhar Projetos:', 'https://github.com/lucas-programador-lang/Compartilhar-Projetos/releases/latest/download/compartilhar-projetos.apk')" class="btn-update-now">Obter Link de Atualização</button>
      
      <a href="https://wa.me/5569993607367?text=Ol%C3%A1%2C%20estou%20com%20problemas%20para%20atualizar%20o%20aplicativo%20Compartilhar%20Projetos." class="btn-support">Precisa de ajuda? Fale no WhatsApp</a>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  if (typeof Android !== 'undefined') {
    var versaoInstalada = "0.0.0"; 
    
    if (typeof Android.obterVersaoApp === 'function') {
        versaoInstalada = Android.obterVersaoApp().trim();
    }
    
    fetch("https://api.github.com/repos/lucas-programador-lang/Compartilhar-Projetos/releases/latest")
      .then(response => response.json())
      .then(data => {
        if (data.tag_name) {
          var versaoMaisRecente = data.tag_name.replace('v', '').trim();
          
          if (versaoInstalada !== versaoMaisRecente) {
            document.getElementById('bloqueioFundo').style.display = 'block';
            document.getElementById('updateModal').style.display = 'block';
            document.body.style.overflow = 'hidden'; 
          }
        }
      })
      .catch(error => console.error("Erro ao verificar atualizações.", error));
  }
});

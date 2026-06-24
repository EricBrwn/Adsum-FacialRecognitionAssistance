// ⚙️ CONFIGURACIÓN GLOBAL
const CONFIG = {
    MODEL_PATH: './models', 
    ADMIN_PASSWORD: "adsum"
};

// 🌐 INYECCIÓN AUTOMÁTICA DE LA BARRA DE NAVEGACIÓN
document.addEventListener("DOMContentLoaded", () => {
    
    // 1. Detectar en qué página estamos
    const path = window.location.pathname;
    const isScanner = path.includes('index.html') || path.endsWith('/');
    const isRegistration = path.includes('registration.html');

    // 2. Definir colores según la página activa
    const scannerColor = isScanner ? '#00bcd4' : '#aaa';
    const scannerWeight = isScanner ? 'bold' : 'normal';
    
    const regColor = isRegistration ? '#00bcd4' : '#aaa';
    const regWeight = isRegistration ? 'bold' : 'normal';

    // 3. Crear y meter la barra de navegación al principio del body
    const navBar = document.createElement("div");
    navBar.style.cssText = "background: #1a1c20; padding: 12px; text-align: center; border-radius: 8px; margin-bottom: 15px; border: 1px solid #333; width: 90%; max-width: 600px; margin-left: auto; margin-right: auto;";
    
    navBar.innerHTML = `
        <span onclick="window.location.href='./index.html'" style="color: ${scannerColor}; margin: 0 15px; font-weight: ${scannerWeight}; font-size: 16px; cursor: pointer; transition: color 0.3s;">📷 Scanner</span>
        <span onclick="window.location.href='./registration.html'" style="color: ${regColor}; margin: 0 15px; font-weight: ${regWeight}; font-size: 16px; cursor: pointer; transition: color 0.3s;">📝 Registration</span>
    `;
    document.body.insertBefore(navBar, document.body.firstChild);

    // 4. Buscar si existe la marca de agua y activarle el botón secreto de Admin
    const watermark = document.querySelector(".watermark");
    if (watermark) {
        watermark.style.cursor = "pointer";
        watermark.addEventListener("dblclick", () => {
            const password = prompt("🔐 Enter Developer Password:");
            if (password === CONFIG.ADMIN_PASSWORD) {
                window.location.href = './admin.html';
            } else if (password !== null) {
                alert("❌ Access Denied");
            }
        });
    }
});
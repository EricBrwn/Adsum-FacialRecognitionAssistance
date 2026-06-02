
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyD8fdqlJlojf-ZPPkUcjPXQCZiMDx2-7J0",
    authDomain: "recognitionaccess-7e966.firebaseapp.com",
    projectId: "recognitionaccess-7e966",
    storageBucket: "recognitionaccess-7e966.firebasestorage.app",
    messagingSenderId: "567614249426",
    appId: "1:567614249426:web:b4955b0ed207cbfcfc100b"
};

const app = initializeApp(firebaseConfig);

// Exportamos la base de datos para que index.js y registro.js puedan usarla
export const db = getFirestore(app);
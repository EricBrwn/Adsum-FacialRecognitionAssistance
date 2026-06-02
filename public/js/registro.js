import { db } from "./firebase-config.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const mensaje = document.getElementById('mensajeEstado');
const imagenPrevia = document.getElementById('imagenPrevia');
const btnRegistrar = document.getElementById('btnRegistrar');
const inputFoto = document.getElementById('inputFoto');
const inputCorreo = document.getElementById('correoUsuario');

let descriptorFacial = null; 

async function iniciar() {
    try {
        mensaje.innerText = "Cargando cerebro...";
        await Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
            faceapi.nets.faceRecognitionNet.loadFromUri('./models')
        ]);
        mensaje.innerText = "Sistema listo. Llena tus datos y sube foto.";
        mensaje.style.color = "blue";
        console.log("IA Cargada correctamente");
    } catch (error) {
        console.error("Error cargando modelos:", error);
        mensaje.innerText = "Error: Revisa la consola (F12)";
        mensaje.style.color = "red";
    }
}

iniciar();

inputFoto.addEventListener('change', async () => {
    const archivo = inputFoto.files[0];
    if (!archivo) return;

    const imagenUrl = URL.createObjectURL(archivo);
    imagenPrevia.src = imagenUrl;

    mensaje.innerText = "Analizando rostro...";
    mensaje.style.color = "black";
    
    btnRegistrar.disabled = true;
    descriptorFacial = null;

    imagenPrevia.onload = async () => {
        try {
            const deteccion = await faceapi.detectSingleFace(imagenPrevia)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (deteccion) {
                mensaje.innerText = "¡Rostro detectado! ✅";
                mensaje.style.color = "green";
                descriptorFacial = deteccion.descriptor;
                btnRegistrar.disabled = false;
            } else {
                mensaje.innerText = "❌ No veo ninguna cara clara. Intenta otra.";
                mensaje.style.color = "red";
            }
        } catch (error) {
            console.error(error);
            mensaje.innerText = "Error al procesar imagen.";
        }
    };
});

btnRegistrar.addEventListener('click', async () => {
    const nombre = document.getElementById('nombreUsuario').value;
    const correo = inputCorreo.value;

    if (nombre === "" || correo === "") {
        alert("¡Falta información! Escribe nombre y correo.");
        return;
    }

    btnRegistrar.innerText = "Guardando en la nube...";
    btnRegistrar.disabled = true;

    try {
        const referenciaDocumento = doc(db, "Users", correo);
        await setDoc(referenciaDocumento, {
            nombreCompleto: nombre,
            email: correo,
            descriptor: Array.from(descriptorFacial), 
            fechaRegistro: new Date().toISOString()
        });

        alert("¡Registro Exitoso! Ya estás en el sistema.");
        mensaje.innerText = "✅ Todo listo. Ya puedes cerrar esta página.";
        btnRegistrar.innerText = "Guardado con éxito";
        
    } catch (error) {
        console.error("Error guardando en Firebase: ", error);
        alert("Hubo un error al guardar. Revisa la consola.");
        btnRegistrar.innerText = "Intentar de nuevo";
        btnRegistrar.disabled = false;
    }
});
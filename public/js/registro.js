import { db } from "./firebase-config.js";
import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// Elementos de la interfaz 
const mensaje = document.getElementById('mensajeEstado');
const imagenPrevia = document.getElementById('imagenPrevia');
const btnRegistrar = document.getElementById('btnRegistrar');
const inputFoto = document.getElementById('inputFoto');
const inputCorreo = document.getElementById('correoUsuario');

// Elementos del Buscador de grupos
const buscadorGrupos = document.getElementById('buscadorGrupos');
const resultadosBusqueda = document.getElementById('resultadosBusqueda');
const contenedorGrupos = document.getElementById('contenedor-grupos');

let todosLosGruposMemoria = []; 
let descriptorFacial = null; 

async function iniciar() {
    try {
        mensaje.innerText = "1/2 Cargando cerebro de IA...";
        await Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
            faceapi.nets.faceRecognitionNet.loadFromUri('./models')
        ]);
        
        mensaje.innerText = "2/2 Sincronizando grupos existentes...";
        await cargarGruposDesdeFirebase();

        mensaje.innerText = "Sistema listo. Llena tus datos.";
        mensaje.style.color = "blue";
    } catch (error) {
        console.error(error);
        mensaje.innerText = "Error al iniciar el registro.";
        mensaje.style.color = "red";
    }
}

// 1. Escanea Firebase pero NO dibuja nada, solo los guarda en memoria
async function cargarGruposDesdeFirebase() {
    const querySnapshot = await getDocs(collection(db, "Users"));
    const gruposExistentes = new Set();
    
    querySnapshot.forEach(doc => {
        const datos = doc.data();
        if (datos.grupos && Array.isArray(datos.grupos)) {
            datos.grupos.forEach(g => {
                if (g !== "Sin Grupo") gruposExistentes.add(g);
            });
        }
    });
    todosLosGruposMemoria = Array.from(gruposExistentes); 
}

// 2. Función que convierte un texto en una píldora seleccionada
function agregarCheckboxGrupo(nombreGrupo) {
    let nombreLimpio = nombreGrupo.trim();
    if (nombreLimpio === "") return;

    const yaExiste = Array.from(contenedorGrupos.querySelectorAll('input')).some(i => i.value.toLowerCase() === nombreLimpio.toLowerCase());
    
    if (!yaExiste) {
        let label = document.createElement("label");
        label.className = "grupo-opcion";
        
        let checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = nombreLimpio;
        checkbox.checked = true; // ¡SIEMPRE nace con palomita!
        
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + nombreLimpio));
        contenedorGrupos.appendChild(label);
    }

    buscadorGrupos.value = "";
    resultadosBusqueda.style.display = "none";
}

// 3. El motor del buscador al escribir
buscadorGrupos.addEventListener('input', () => {
    let texto = buscadorGrupos.value.toLowerCase().trim();
    resultadosBusqueda.innerHTML = ""; 

    if (texto === "") {
        resultadosBusqueda.style.display = "none";
        return;
    }

    let coincidencias = todosLosGruposMemoria.filter(g => g.toLowerCase().includes(texto));

    coincidencias.forEach(match => {
        let div = document.createElement("div");
        div.className = "dropdown-item";
        div.innerText = match;
        div.addEventListener("click", () => agregarCheckboxGrupo(match));
        resultadosBusqueda.appendChild(div);
    });

    let divCrear = document.createElement("div");
    divCrear.className = "dropdown-item";
    divCrear.style.fontWeight = "bold";
    divCrear.style.color = "#007bff";
    divCrear.innerText = `+ Crear y seleccionar "${buscadorGrupos.value}"`;
    divCrear.addEventListener("click", () => {
        agregarCheckboxGrupo(buscadorGrupos.value);
        if (!todosLosGruposMemoria.includes(buscadorGrupos.value)) {
            todosLosGruposMemoria.push(buscadorGrupos.value); 
        }
    });
    resultadosBusqueda.appendChild(divCrear);

    resultadosBusqueda.style.display = "block"; 
});

// 4. "A prueba de tontos": Si presiona Enter, se crea/selecciona automáticamente
buscadorGrupos.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        let texto = buscadorGrupos.value.trim();
        if (texto !== "") {
            agregarCheckboxGrupo(texto);
            if (!todosLosGruposMemoria.includes(texto)) todosLosGruposMemoria.push(texto);
        }
    }
});

// 5. Ocultar el menú si da clic en cualquier otro lado de la pantalla
document.addEventListener("click", (e) => {
    if (e.target !== buscadorGrupos && e.target !== resultadosBusqueda) {
        resultadosBusqueda.style.display = "none";
    }
});

// --- EL LECTOR DE ROSTROS (AHORA CON SOPORTE PARA IPHONE/HEIC) ---
inputFoto.addEventListener('change', async () => {
    let archivo = inputFoto.files[0];
    if (!archivo) return;
    
    btnRegistrar.disabled = true;

    // Detectamos si es una foto de iPhone (.heic)
    let nombreArchivo = archivo.name.toLowerCase();
    if (nombreArchivo.endsWith('.heic') || archivo.type === 'image/heic') {
        mensaje.innerText = "Convirtiendo formato de iPhone (esto toma un par de segundos)...";
        mensaje.style.color = "orange";
        
        try {
            // Convertimos la imagen a JPEG mágicamente en el navegador
            const blobConvertido = await heic2any({
                blob: archivo,
                toType: "image/jpeg",
                quality: 0.8 // Buena calidad, procesamiento rápido
            });
            
            // heic2any a veces devuelve un arreglo, nos aseguramos de tomar el archivo correcto
            archivo = Array.isArray(blobConvertido) ? blobConvertido[0] : blobConvertido;
        } catch (error) {
            console.error("Error al convertir HEIC:", error);
            mensaje.innerText = "❌ Error al procesar la imagen de iPhone.";
            mensaje.style.color = "red";
            return;
        }
    }

    // Ahora sí, creamos la URL con la imagen (sea normal o ya convertida)
    const imagenUrl = URL.createObjectURL(archivo);
    imagenPrevia.src = imagenUrl;
    mensaje.innerText = "Analizando rostro...";
    mensaje.style.color = "blue"; 

    // El análisis continúa normal
    imagenPrevia.onload = async () => {
        const deteccion = await faceapi.detectSingleFace(imagenPrevia).withFaceLandmarks().withFaceDescriptor();
        if (deteccion) {
            mensaje.innerText = "¡Rostro detectado! ✅";
            mensaje.style.color = "green";
            descriptorFacial = deteccion.descriptor;
            btnRegistrar.disabled = false;
        } else {
            mensaje.innerText = "❌ No veo ninguna cara clara.";
            mensaje.style.color = "red";
        }
    };

    imagenPrevia.onerror = () => {
        mensaje.innerText = "❌ Error: No se pudo mostrar la imagen.";
        mensaje.style.color = "red";
        btnRegistrar.disabled = true;
    };
});

// --- GUARDAR EN FIREBASE ---
btnRegistrar.addEventListener('click', async () => {
    const nombre = document.getElementById('nombreUsuario').value.trim();
    const correo = inputCorreo.value.trim();

    if (!nombre || !correo) { alert("Por favor, llena nombre y correo."); return; }

    let checkboxesSeleccionados = document.querySelectorAll('#contenedor-grupos input[type="checkbox"]:checked');
    let gruposElegidos = [];
    checkboxesSeleccionados.forEach((casilla) => {
        gruposElegidos.push(casilla.value);
    });

    if (gruposElegidos.length === 0) {
        alert("⚠️ ¡Acción Detenida! Debes seleccionar al menos un grupo o escribir uno nuevo antes de guardar el usuario.");
        return;
    }

    btnRegistrar.innerText = "Guardando...";
    btnRegistrar.disabled = true;

    try {
        await setDoc(doc(db, "Users", correo), {
            nombreCompleto: nombre,
            email: correo,
            descriptor: Array.from(descriptorFacial), 
            fechaRegistro: new Date().toISOString(),
            grupos: gruposElegidos 
        });

        alert("¡Registro Exitoso!");
        location.reload(); 
    } catch (error) {
        console.error(error);
        alert("Error al guardar.");
        btnRegistrar.disabled = false;
    }
});

iniciar();
import { db } from "./firebase-config.js";
import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const mensaje = document.getElementById('mensajeEstado');
const imagenPrevia = document.getElementById('imagenPrevia');
const btnRegistrar = document.getElementById('btnRegistrar');
const inputFoto = document.getElementById('inputFoto');
const inputCorreo = document.getElementById('correoUsuario');

const inputGrupo = document.getElementById('inputGrupo');
const btnAgregarGrupo = document.getElementById('btnAgregarGrupo');
const contenedorTags = document.getElementById('contenedorTags');
const datalistGrupos = document.getElementById('listaGrupos');

let descriptorFacial = null; 
let gruposSeleccionados = new Set(); // Evita que se repitan grupos en la lista local

async function iniciar() {
    try {
        mensaje.innerText = "1/2 Cargando cerebro de IA...";
        await Promise.all([
            faceapi.nets.ssdMobilenetv1.loadFromUri('./models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
            faceapi.nets.faceRecognitionNet.loadFromUri('./models')
        ]);
        
        mensaje.innerText = "2/2 Sincronizando grupos existentes...";
        await cargarGruposAutocompletado();

        mensaje.innerText = "Sistema listo. Llena tus datos.";
        mensaje.style.color = "blue";
    } catch (error) {
        console.error(error);
        mensaje.innerText = "Error al iniciar el registro.";
        mensaje.style.color = "red";
    }
}

// Busca todos los grupos que ya existen en la base de datos para sugerirlos
async function cargarGruposAutocompletado() {
    const querySnapshot = await getDocs(collection(db, "Users"));
    const gruposExistentes = new Set();
    
    querySnapshot.forEach(doc => {
        const datos = doc.data();
        if (datos.grupos && Array.isArray(datos.grupos)) {
            datos.grupos.forEach(g => gruposExistentes.add(g));
        }
    });

    datalistGrupos.innerHTML = "";
    gruposExistentes.forEach(grupo => {
        datalistGrupos.innerHTML += `<option value="${grupo}"></option>`;
    });
}

function renderizarTags() {
    contenedorTags.innerHTML = "";
    gruposSeleccionados.forEach(grupo => {
        const tag = document.createElement('span');
        tag.className = 'tag-grupo';
        tag.innerHTML = `${grupo} <button type="button" class="btn-borrar-tag" data-grupo="${grupo}">×</button>`;
        contenedorTags.appendChild(tag);
    });
}

// Agregar grupo al hacer click en + o presionar Enter
btnAgregarGrupo.addEventListener('click', () => {
    const valor = inputGrupo.value.trim();
    if (valor && !gruposSeleccionados.has(valor)) {
        gruposSeleccionados.add(valor);
        renderizarTags();
        inputGrupo.value = "";
    }
});
inputGrupo.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); btnAgregarGrupo.click(); }
});

// Borrar grupo al hacer click en la X
contenedorTags.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-borrar-tag')) {
        const grupoABorrar = e.target.getAttribute('data-grupo');
        gruposSeleccionados.delete(grupoABorrar);
        renderizarTags();
    }
});

inputFoto.addEventListener('change', async () => {
    const archivo = inputFoto.files[0];
    if (!archivo) return;
    const imagenUrl = URL.createObjectURL(archivo);
    imagenPrevia.src = imagenUrl;
    mensaje.innerText = "Analizando rostro...";
    btnRegistrar.disabled = true;

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
});

btnRegistrar.addEventListener('click', async () => {
    const nombre = document.getElementById('nombreUsuario').value.trim();
    const correo = inputCorreo.value.trim();

    if (!nombre || !correo) { alert("Llena nombre y correo."); return; }

    btnRegistrar.innerText = "Guardando...";
    btnRegistrar.disabled = true;

    try {
        await setDoc(doc(db, "Users", correo), {
            nombreCompleto: nombre,
            email: correo,
            descriptor: Array.from(descriptorFacial), 
            fechaRegistro: new Date().toISOString(),
            // Guardamos el array de grupos (si no eligió ninguno, se va a "Sin Grupo")
            grupos: gruposSeleccionados.size > 0 ? Array.from(gruposSeleccionados) : ["Sin Grupo"]
        });

        alert("¡Registro Exitoso!");
        location.reload(); // Recargamos para limpiar y actualizar el autocompletado
    } catch (error) {
        console.error(error);
        alert("Error al guardar.");
        btnRegistrar.disabled = false;
    }
});

iniciar();
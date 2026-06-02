import { db } from "./firebase-config.js";
import { collection, getDocs, addDoc, query, where } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const video = document.getElementById('camara');
const mensaje = document.getElementById('mensajeScanner');

let rostrosConocidos = []; 
let mapaCorreos = {}; 
let basesDeDatosGrupos = {}; 
let comparadorFacial = null; 

async function inicializarEscaner() {
    try {
        mensaje.innerText = "1/3 Cargando cerebro de IA (Modelos)...";
        mensaje.style.color = "yellow";
        
        await faceapi.nets.ssdMobilenetv1.loadFromUri('./models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('./models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('./models');
        
        mensaje.innerText = "2/3 IA lista. Encendiendo cámara...";
        await encenderCamara(); 

        mensaje.innerText = "3/3 Sincronizando base de datos...";
        await descargarDatosFirebase();
        
    } catch (error) {
        console.error("Error crítico en la inicialización:", error);
        mensaje.innerText = "Error crítico: Revisa la consola.";
        mensaje.style.color = "red";
        return;
    }

    iniciarReconocimiento();
}

async function encenderCamara() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
    } catch (error) {
        alert("⛔ No se pudo acceder a la cámara. Revisa el ícono del candado en la barra de direcciones, permite la cámara y recarga la página.");
        console.error("Error de cámara:", error);
        throw error; 
    }
}

async function descargarDatosFirebase() {
    try {
        rostrosConocidos = []; 
        mapaCorreos = {};
        basesDeDatosGrupos = {};

        const querySnapshot = await getDocs(collection(db, "Users"));
        
        querySnapshot.forEach((doc) => {
            const datos = doc.data();
            
            if (!datos.nombreCompleto || !datos.descriptor) {
                console.warn(`Omitiendo documento ${doc.id} por estar incompleto.`);
                return; 
            }

            const nombre = String(datos.nombreCompleto);
            const correo = doc.id;
            mapaCorreos[nombre] = correo;

            const gruposDeLaPersona = datos.grupos || ["Sin Grupo"];
    
            gruposDeLaPersona.forEach(nombreGrupo => {
                if (!basesDeDatosGrupos[nombreGrupo]) {
                    basesDeDatosGrupos[nombreGrupo] = [];
                }
                basesDeDatosGrupos[nombreGrupo].push(correo);
            });

            const arregloNormal = datos.descriptor;
            const descriptorFloat32 = new Float32Array(arregloNormal);
            const rostroEtiquetado = new faceapi.LabeledFaceDescriptors(nombre, [descriptorFloat32]);
            
            rostrosConocidos.push(rostroEtiquetado);
        });

        comparadorFacial = new faceapi.FaceMatcher(rostrosConocidos, 0.6);

        if (rostrosConocidos.length === 0) {
            mensaje.innerText = "Error: No hay usuarios válidos en la base de datos.";
            mensaje.style.color = "orange";
        } else {
            console.log("Usuarios cargados en RAM:", rostrosConocidos);
            mensaje.innerText = `Sistema Listo. ${rostrosConocidos.length} personas cargadas.`;
            mensaje.style.color = "lightgreen";
        }

        const selectHTML = document.getElementById('selectGrupo');
        selectHTML.innerHTML = '<option value="todos">Todos los registrados</option>'; 
        
        for (const grupo in basesDeDatosGrupos) {
            selectHTML.innerHTML += `<option value="${grupo}">${grupo} (${basesDeDatosGrupos[grupo].length} personas)</option>`;
        }

    } catch (error) {
        console.error("Error obteniendo datos: ", error);
        mensaje.innerText = "Error al descargar datos.";
        throw error;
    }
}

let ultimoRegistroUsuario = {}; 
const TIEMPO_ESPERA_MS = 60000; 

async function registrarAcceso(nombrePersona) {
    const tiempoActual = Date.now(); 

    if (ultimoRegistroUsuario[nombrePersona] && (tiempoActual - ultimoRegistroUsuario[nombrePersona] < TIEMPO_ESPERA_MS)) {
        return; 
    }

    ultimoRegistroUsuario[nombrePersona] = tiempoActual;
    const correoDeLaPersona = mapaCorreos[nombrePersona] || "Desconocido";

    try {
        const fechaActual = new Date();
        await addDoc(collection(db, "Historial"), {
            nombre: nombrePersona,
            correo: correoDeLaPersona,
            fecha: fechaActual.toLocaleDateString(), 
            hora: fechaActual.toLocaleTimeString(),  
            timestamp: tiempoActual 
        });

        console.log(`✅ Bitácora: Entrada de ${nombrePersona} registrada en la nube.`);
    } catch (error) {
        console.error("Error al guardar en el historial:", error);
    }
}

async function iniciarReconocimiento() {
    const arrancarDeteccion = async () => {
        const canvas = faceapi.createCanvasFromMedia(video);
        document.getElementById('contenedor-camara').append(canvas);

        const dimensiones = { width: video.width, height: video.height };
        faceapi.matchDimensions(canvas, dimensiones);

        setInterval(async () => {
            const detecciones = await faceapi.detectAllFaces(video)
                .withFaceLandmarks()
                .withFaceDescriptors();

            const deteccionesRedimensionadas = faceapi.resizeResults(detecciones, dimensiones);
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

            deteccionesRedimensionadas.forEach(deteccion => {
                const mejorMatch = comparadorFacial.findBestMatch(deteccion.descriptor);
                const box = deteccion.detection.box; 

                if (mejorMatch.label !== 'unknown') {
                    mensaje.innerText = `¡ACCESO CONCEDIDO: BIENVENIDO ${mejorMatch.label.toUpperCase()}!`;
                    mensaje.style.color = "lightgreen";
                    registrarAcceso(mejorMatch.label);
                } else {
                    mensaje.innerText = "ACCESO DENEGADO: Persona no registrada.";
                    mensaje.style.color = "red";
                }   
                
                const drawBox = new faceapi.draw.DrawBox(box, { 
                    label: mejorMatch.toString(), 
                    boxColor: mejorMatch.label === 'unknown' ? 'red' : 'green' 
                });
                
                drawBox.draw(canvas);
            });
        }, 200);
    };

    // Si el video ya cargó y está listo, arrancamos de inmediato.
    if (video.readyState >= 3) {
        arrancarDeteccion();
    } else {
        // Si tarda en cargar, esperamos a que avise que ya está reproduciendo.
        video.addEventListener('playing', arrancarDeteccion);
    }
}

async function calcularFaltas() {
    try {
        const grupoSeleccionado = document.getElementById('selectGrupo').value;
        const horaInicioHTML = document.getElementById('horaInicio').value;
        const horaFinHTML = document.getElementById('horaFin').value;

        if (!horaInicioHTML || !horaFinHTML) {
            alert("⚠️ Por favor selecciona una hora válida.");
            return;
        }

        let listaInvitados = [];
        if (grupoSeleccionado === "todos") {
            listaInvitados = Object.values(mapaCorreos); 
        } else {
            listaInvitados = basesDeDatosGrupos[grupoSeleccionado] || []; 
        }

        if (listaInvitados.length === 0) {
            alert("⚠️ No hay nadie registrado en este grupo.");
            return;
        }

        const [hInicio, mInicio] = horaInicioHTML.split(':');
        const [hFin, mFin] = horaFinHTML.split(':');

        const hoy = new Date();
        const horaInicioTs = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), parseInt(hInicio), parseInt(mInicio), 0).getTime(); 
        const horaFinTs = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), parseInt(hFin), parseInt(mFin), 0).getTime();

        const fechaHoy = hoy.toLocaleDateString();
        
        const consulta = query(collection(db, "Historial"), where("fecha", "==", fechaHoy));
        const resultados = await getDocs(consulta);

        let correosAsistentes = new Set(); 
        resultados.forEach((doc) => {
            const datos = doc.data();
            if (datos.correo && datos.timestamp >= horaInicioTs && datos.timestamp <= horaFinTs) {
                correosAsistentes.add(datos.correo);
            }
        });

        let ausentes = [];
        listaInvitados.forEach(correoInvitado => {
            if (!correosAsistentes.has(correoInvitado)) {
                let nombrePersona = "Invitado";
                for (const [nombre, correo] of Object.entries(mapaCorreos)) {
                    if (correo === correoInvitado) nombrePersona = nombre;
                }
                ausentes.push({ nombre: nombrePersona, correo: correoInvitado });
            }
        });

        document.getElementById('modalAdmin').style.display = 'none';

        if (ausentes.length === 0) {
            alert(`✅ ¡Éxito total!\nTodos los ${listaInvitados.length} invitados del grupo llegaron a tiempo.`);
        } else {
            let mensajeAlerta = `⚠️ REPORTE DE FALTAS (${ausentes.length} de ${listaInvitados.length} no llegaron):\n\n`;
            ausentes.forEach(persona => {
                mensajeAlerta += `- ${persona.nombre}\n`;
            });
            alert(mensajeAlerta);
        }

    } catch (error) {
        console.error("Error al calcular las faltas:", error);
        alert("Hubo un error. Revisa la consola.");
    }
}

const modal = document.getElementById('modalAdmin');
document.getElementById('btnAbrirAdmin').addEventListener('click', () => {
    modal.style.display = 'flex';
});
document.getElementById('btnCerrarModal').addEventListener('click', () => {
    modal.style.display = 'none'; 
});
document.getElementById('btnCerrarDia').addEventListener('click', calcularFaltas);

inicializarEscaner();